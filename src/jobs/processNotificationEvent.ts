import type { Payload, PayloadRequest, TaskConfig } from 'payload'

import type {
  ChannelDefinition,
  NotificationRuleShape,
  RenderedNotification,
  ResolvedSlugs,
} from '../types.js'

import { attemptAsync } from '../utils/attemptAsync.js'
import { renderNotification } from '../utils/renderNotification.js'
import { resolveSlugs } from '../utils/resolveSlugs.js'

type EventRecord = Record<string, unknown>

/**
 * Dispatches notifications for a single rule trigger.
 *
 * For immediate subscriptions: renders the rule template, calls each matching
 * channel handler, then marks the event `sent` or `failed`.
 *
 * For daily/weekly subscriptions: creates the event record and leaves it
 * `pending` for `sendNotificationDigest` to collect.
 *
 * Idempotency: the task keys its event record on the job id (`dedupeKey`) and
 * claims immediate delivery (`deliveredImmediate`) before sending. On a retry it
 * reuses the existing event and never re-sends immediate notifications, giving
 * an at-most-once guarantee for external side effects.
 */
export function makeProcessNotificationEventTask(
  channels: ChannelDefinition[],
  slugs: Partial<ResolvedSlugs>,
): TaskConfig<'processNotificationEvent'> {
  const resolvedSlugs = resolveSlugs(slugs)
  const { events: eventsSlug, rules: rulesSlug, subscriptions: subsSlug } = resolvedSlugs

  return {
    slug: 'processNotificationEvent',
    inputSchema: [
      { name: 'ruleId', type: 'text', required: true },
      { name: 'contextData', type: 'json', required: false },
    ],
    outputSchema: [{ name: 'eventId', type: 'text' }],
    retries: 2,

    handler: async ({ input: rawInput, job, req }) => {
      const { payload } = req
      const { contextData = {}, ruleId } = rawInput as {
        contextData?: Record<string, string>
        ruleId: string
      }

      const rule = await loadActiveRule(payload, rulesSlug, ruleId)
      if (!rule) {
        return { output: { eventId: '' } }
      }

      const dedupeKey = makeDedupeKey(job)
      const existing = await findExistingEvent(payload, eventsSlug, dedupeKey)
      const alreadyDelivered = existing?.deliveredImmediate === true

      const event =
        existing ??
        (await payload.create({
          collection: eventsSlug,
          data: {
            contextData,
            ...(dedupeKey ? { dedupeKey } : {}),
            deliveredImmediate: false,
            rule: ruleId,
            status: 'pending',
            trigger: rule.trigger,
          },
          overrideAccess: true,
        })) as EventRecord

      const eventId = String(event.id)
      const settle = (status: 'failed' | 'sent') =>
        updateEventStatus(payload, eventsSlug, event.id, {
          processedAt: new Date().toISOString(),
          status,
        })

      const { hasPendingDigest, immediate } = await loadSubscriptions(payload, subsSlug, ruleId)

      // Nothing to deliver immediately — either there are no immediate
      // subscriptions, or a prior attempt already delivered them. Digest
      // subscriptions (if any) keep the event `pending`; otherwise settle now.
      if (immediate.length === 0 || alreadyDelivered) {
        if (!hasPendingDigest) {
          await settle('sent')
        }
        return { output: { eventId } }
      }

      const rendered = await renderNotification(rule, contextData ?? {})
      if (rendered.renderFailed) {
        payload.logger.error(
          { eventId, ruleId },
          'processNotificationEvent: Lexical render failed — skipping all subscriptions',
        )
        await settle('failed')
        return { output: { eventId } }
      }

      // Claim delivery before sending so a crash + retry cannot double-send.
      await updateEventStatus(payload, eventsSlug, event.id, { deliveredImmediate: true })

      const outcome = await deliverImmediate({
        channels,
        event: { id: eventId, contextData: contextData ?? {}, trigger: rule.trigger },
        immediate,
        logger: payload.logger,
        rendered,
        req,
        ruleId,
        slugs: resolvedSlugs,
      })

      if (hasPendingDigest) {
        // Leave the event `pending` so `sendNotificationDigest` still delivers
        // to digest subscribers, regardless of how immediate delivery fared.
        // The digest run finalises the status (and stamps processedAt).
        return { output: { eventId } }
      }

      await settle(outcome.attempted && !outcome.succeeded ? 'failed' : 'sent')

      return { output: { eventId } }
    },
  }
}

/** Loads the rule and returns it only when present and active. */
async function loadActiveRule(
  payload: Payload,
  rulesSlug: string,
  ruleId: string,
): Promise<NotificationRuleShape | null> {
  const rule = (await payload.findByID({
    id: ruleId,
    collection: rulesSlug as never,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
  })) as unknown as NotificationRuleShape | null

  return rule?.active ? rule : null
}

/** Stable across retries — Payload reuses the same job id on retry. */
function makeDedupeKey(job: unknown): string | undefined {
  const jobId = (job as { id?: number | string } | undefined)?.id
  return jobId != null ? `pne:${String(jobId)}` : undefined
}

/** Reuse the event from a previous attempt if this job already ran. */
async function findExistingEvent(
  payload: Payload,
  eventsSlug: string,
  dedupeKey: string | undefined,
): Promise<EventRecord | null> {
  if (!dedupeKey) {
    return null
  }

  const { docs } = await payload.find({
    collection: eventsSlug as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { dedupeKey: { equals: dedupeKey } },
  })

  return (docs[0] as EventRecord | undefined) ?? null
}

function updateEventStatus(
  payload: Payload,
  eventsSlug: string,
  id: unknown,
  data: Record<string, unknown>,
) {
  return payload.update({
    id: id as number | string,
    collection: eventsSlug as never,
    data,
    overrideAccess: true,
  })
}

async function loadSubscriptions(
  payload: Payload,
  subsSlug: string,
  ruleId: string,
): Promise<{ hasPendingDigest: boolean; immediate: EventRecord[] }> {
  const { docs: subscriptions } = await payload.find({
    collection: subsSlug as never,
    depth: 1,
    overrideAccess: true,
    pagination: false,
    where: { and: [{ rule: { equals: ruleId } }, { active: { equals: true } }] },
  })

  return {
    hasPendingDigest: subscriptions.some((s) => s.schedule !== 'immediate'),
    immediate: subscriptions.filter((s) => s.schedule === 'immediate') as EventRecord[],
  }
}

type ImmediateDeliveryArgs = {
  channels: ChannelDefinition[]
  event: { contextData: Record<string, string>; id: string; trigger: string }
  immediate: EventRecord[]
  logger: Payload['logger']
  rendered: RenderedNotification
  req: PayloadRequest
  ruleId: string
  slugs: ResolvedSlugs
}

/** Fans the rendered notification out to every matching immediate channel. */
async function deliverImmediate(
  args: ImmediateDeliveryArgs,
): Promise<{ attempted: boolean; succeeded: boolean }> {
  const { channels, event, immediate, logger, rendered, req, ruleId, slugs } = args
  let attempted = false
  let succeeded = false

  for (const sub of immediate) {
    const subChannels = (sub.channels ?? []) as string[]

    for (const channelDef of channels) {
      if (!subChannels.includes(channelDef.value)) {
        continue
      }

      attempted = true

      const [err] = await attemptAsync(() =>
        channelDef.handler({
          event,
          rendered: { html: rendered.html, subject: rendered.subject, text: rendered.text },
          req,
          slugs,
          subscription: sub,
        }),
      )

      if (err) {
        logger.error(
          { channel: channelDef.value, err, eventId: event.id, ruleId },
          'processNotificationEvent: channel handler failed',
        )
      } else {
        succeeded = true
      }
    }
  }

  return { attempted, succeeded }
}
