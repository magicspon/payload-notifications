import type { Payload, PayloadRequest, TaskConfig } from 'payload'

import type {
  ChannelDefinition,
  NotificationEventShape,
  NotificationRuleShape,
  ResolvedSlugs,
} from '../types.js'

import { attemptAsync } from '../utils/attemptAsync.js'
import { extractId } from '../utils/extractId.js'
import { renderNotification } from '../utils/renderNotification.js'
import { resolveSlugs } from '../utils/resolveSlugs.js'

const PENDING_EVENTS_LIMIT = 500

type RenderedItem = {
  contextData: Record<string, string>
  eventId: string
  html: string
  subject: string
  text: string
  trigger: string
}

type Subscription = Record<string, unknown>

/**
 * Collects all pending notification events and sends batched digest deliveries
 * to matching subscriptions.
 *
 * Flow:
 * 1. Find pending events
 * 2. Mark them as 'processing' to prevent double-send across concurrent runs
 * 3. Find matching subscriptions for the given schedule
 * 4. Group events by subscription
 * 5. Call each channel's `digestHandler` (or `handler` per event if absent)
 * 6. Mark events 'sent' or 'failed'
 */
export function makeSendNotificationDigestTask(
  channels: ChannelDefinition[],
  slugs: Partial<ResolvedSlugs>,
): TaskConfig<'sendNotificationDigest'> {
  const resolvedSlugs = resolveSlugs(slugs)
  const { events: eventsSlug, subscriptions: subsSlug } = resolvedSlugs

  return {
    slug: 'sendNotificationDigest',
    inputSchema: [{ name: 'schedule', type: 'text', required: true }],
    outputSchema: [{ name: 'processed', type: 'text' }],
    retries: 1,

    handler: async ({ input: rawInput, req }) => {
      const { payload } = req
      const { schedule } = rawInput as { schedule: string }

      if (schedule !== 'daily' && schedule !== 'weekly') {
        payload.logger.warn({ schedule }, 'sendNotificationDigest: unrecognised schedule value')
        return { output: { processed: '0' } }
      }

      const events = await loadPendingEvents(payload, eventsSlug, schedule)
      if (events.length === 0) {
        return { output: { processed: '0' } }
      }

      const ruleIds = [
        ...new Set(events.map((e) => extractId(e.rule)).filter((id): id is string => !!id)),
      ]
      const subscriptions = await loadSubscriptions(payload, subsSlug, ruleIds, schedule)
      if (subscriptions.length === 0) {
        return { output: { processed: '0' } }
      }

      // Only events whose rule has a matching subscription for this schedule are
      // handled this run. Others are left `pending` for a later run/schedule.
      const subscribedRuleIds = new Set(
        subscriptions.map((s) => extractId(s.rule as never)).filter((id): id is string => !!id),
      )
      const relevantEvents = events.filter((e) => {
        const id = extractId(e.rule)
        return id != null && subscribedRuleIds.has(id)
      })

      if (relevantEvents.length === 0) {
        return { output: { processed: '0' } }
      }

      // Mark as 'processing' to reduce the window for concurrent runs double-sending.
      await markEvents(payload, eventsSlug, relevantEvents, { status: 'processing' })

      const succeeded = await deliverDigests({
        channels,
        logger: payload.logger,
        relevantEvents,
        renderItem: makeRenderItem(),
        req,
        schedule,
        slugs: resolvedSlugs,
        subscriptions,
      })

      const processed = await finaliseEvents(payload, eventsSlug, relevantEvents, succeeded)

      return { output: { processed: String(processed) } }
    },
  }
}

async function loadPendingEvents(
  payload: Payload,
  eventsSlug: string,
  schedule: string,
): Promise<NotificationEventShape[]> {
  const now = new Date().toISOString()

  const { docs } = await payload.find({
    collection: eventsSlug as never,
    depth: 1,
    limit: PENDING_EVENTS_LIMIT,
    overrideAccess: true,
    where: {
      and: [{ status: { equals: 'pending' } }, { createdAt: { less_than: now } }],
    },
  })

  if (docs.length === PENDING_EVENTS_LIMIT) {
    payload.logger.warn(
      { limit: PENDING_EVENTS_LIMIT, schedule },
      'sendNotificationDigest: pending events query hit the limit — some events deferred to next run',
    )
  }

  return docs as unknown as NotificationEventShape[]
}

async function loadSubscriptions(
  payload: Payload,
  subsSlug: string,
  ruleIds: string[],
  schedule: string,
): Promise<Subscription[]> {
  const { docs } = await payload.find({
    collection: subsSlug as never,
    depth: 1,
    overrideAccess: true,
    pagination: false,
    where: {
      and: [
        { rule: { in: ruleIds } },
        { schedule: { equals: schedule } },
        { active: { equals: true } },
      ],
    },
  })

  return docs as Subscription[]
}

function markEvents(
  payload: Payload,
  eventsSlug: string,
  events: NotificationEventShape[],
  data: Record<string, unknown>,
) {
  return Promise.all(
    events.map((ev) =>
      payload.update({
        id: ev.id,
        collection: eventsSlug as never,
        data,
        overrideAccess: true,
      }),
    ),
  )
}

/** Renders each event at most once, keyed by event id. */
function makeRenderItem(): (ev: NotificationEventShape) => Promise<null | RenderedItem> {
  const cache = new Map<string, null | RenderedItem>()

  return async (ev) => {
    const eventId = String(ev.id)
    if (cache.has(eventId)) {
      return cache.get(eventId) ?? null
    }

    const rule = typeof ev.rule === 'object' ? (ev.rule as unknown as NotificationRuleShape) : null
    if (!rule) {
      cache.set(eventId, null)
      return null
    }

    const contextData = ev.contextData ?? {}
    const rendered = await renderNotification(rule, contextData)
    const item: null | RenderedItem = rendered.renderFailed
      ? null
      : {
          contextData,
          eventId,
          html: rendered.html,
          subject: rendered.subject,
          text: rendered.text,
          trigger: ev.trigger,
        }
    cache.set(eventId, item)
    return item
  }
}

type DigestDeliveryArgs = {
  channels: ChannelDefinition[]
  logger: Payload['logger']
  relevantEvents: NotificationEventShape[]
  renderItem: (ev: NotificationEventShape) => Promise<null | RenderedItem>
  req: PayloadRequest
  schedule: 'daily' | 'weekly'
  slugs: ResolvedSlugs
  subscriptions: Subscription[]
}

/** Delivers batched items per subscription/channel; returns the ids that sent. */
async function deliverDigests(args: DigestDeliveryArgs): Promise<Set<string>> {
  const { channels, relevantEvents, renderItem, subscriptions } = args
  const succeeded = new Set<string>()

  for (const sub of subscriptions) {
    const ruleId = extractId(sub.rule as never)
    if (!ruleId) {
      continue
    }

    const matchingEvents = relevantEvents.filter((e) => extractId(e.rule) === ruleId)
    if (matchingEvents.length === 0) {
      continue
    }

    const items = (await Promise.all(matchingEvents.map(renderItem))).filter(
      (item): item is RenderedItem => item !== null,
    )
    if (items.length === 0) {
      continue
    }

    const subChannels = (sub.channels ?? []) as string[]
    for (const channelDef of channels) {
      if (!subChannels.includes(channelDef.value)) {
        continue
      }
      await deliverToChannel({ ...args, channelDef, items, sub, succeeded })
    }
  }

  return succeeded
}

type ChannelDeliveryArgs = {
  channelDef: ChannelDefinition
  items: RenderedItem[]
  sub: Subscription
  succeeded: Set<string>
} & DigestDeliveryArgs

/**
 * Sends one batch through a single channel, preferring `digestHandler` and
 * falling back to the per-event `handler`. Records every sent event id.
 */
async function deliverToChannel(args: ChannelDeliveryArgs): Promise<void> {
  const { channelDef, items, logger, req, schedule, slugs, sub, succeeded } = args

  if (channelDef.digestHandler) {
    const [err] = await attemptAsync(() =>
      channelDef.digestHandler!({ items, req, schedule, slugs, subscription: sub }),
    )
    if (err) {
      logger.error(
        { channel: channelDef.value, err },
        'sendNotificationDigest: digestHandler failed',
      )
      return
    }
    for (const item of items) {
      succeeded.add(item.eventId)
    }
    return
  }

  // Fallback: call the per-event handler once per item.
  for (const item of items) {
    const [err] = await attemptAsync(() =>
      channelDef.handler({
        event: { id: item.eventId, contextData: item.contextData, trigger: item.trigger },
        rendered: { html: item.html, subject: item.subject, text: item.text },
        req,
        slugs,
        subscription: sub,
      }),
    )
    if (err) {
      logger.error(
        { channel: channelDef.value, err },
        'sendNotificationDigest: handler failed for event',
      )
    } else {
      succeeded.add(item.eventId)
    }
  }
}

/**
 * Finalises each event exactly once: `sent` if any delivery succeeded,
 * otherwise `failed` (it was attempted, or could not be rendered/routed).
 * Returns the count marked `sent`.
 */
async function finaliseEvents(
  payload: Payload,
  eventsSlug: string,
  relevantEvents: NotificationEventShape[],
  succeeded: Set<string>,
): Promise<number> {
  const processedAt = new Date().toISOString()
  let processed = 0

  await Promise.all(
    relevantEvents.map((ev) => {
      const status = succeeded.has(String(ev.id)) ? 'sent' : 'failed'
      if (status === 'sent') {
        processed++
      }
      return payload.update({
        id: ev.id,
        collection: eventsSlug as never,
        data: { processedAt, status },
        overrideAccess: true,
      })
    }),
  )

  return processed
}
