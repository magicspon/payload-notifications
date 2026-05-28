import type { TaskConfig } from 'payload'

import type { ChannelDefinition, NotificationRuleShape, ResolvedSlugs } from '../types.js'

import { attemptAsync } from '../utils/attemptAsync.js'
import { renderNotification } from '../utils/renderNotification.js'

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
  const resolvedSlugs: ResolvedSlugs = {
    events: slugs.events ?? 'notification-events',
    inbox: slugs.inbox ?? 'notification-inbox',
    rules: slugs.rules ?? 'notification-rules',
    subscriptions: slugs.subscriptions ?? 'notification-subscriptions',
  }
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

      const rule = (await payload.findByID({
        id: ruleId,
        collection: rulesSlug,
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
      })) as unknown as NotificationRuleShape | null

      if (!rule?.active) {
        return { output: { eventId: '' } }
      }

      // Stable across retries — Payload reuses the same job id on retry.
      const jobId = (job as { id?: number | string } | undefined)?.id
      const dedupeKey = jobId != null ? `pne:${String(jobId)}` : undefined

      // Reuse the event from a previous attempt if this job already ran.
      let event = null as null | Record<string, unknown>
      if (dedupeKey) {
        const { docs } = await payload.find({
          collection: eventsSlug,
          depth: 0,
          limit: 1,
          overrideAccess: true,
          where: { dedupeKey: { equals: dedupeKey } },
        })
        event = (docs[0] as Record<string, unknown> | undefined) ?? null
      }

      const alreadyDelivered = event?.deliveredImmediate === true

      if (!event) {
        event = (await payload.create({
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
        })) as Record<string, unknown>
      }

      const eventId = String(event.id)

      const { docs: subscriptions } = await payload.find({
        collection: subsSlug,
        depth: 1,
        overrideAccess: true,
        pagination: false,
        where: { and: [{ rule: { equals: ruleId } }, { active: { equals: true } }] },
      })

      const immediateSubscriptions = subscriptions.filter((s) => s.schedule === 'immediate')
      const hasPendingDigest = subscriptions.some((s) => s.schedule !== 'immediate')

      const settle = (status: 'failed' | 'sent') =>
        payload.update({
          id: event.id as number | string,
          collection: eventsSlug,
          data: { processedAt: new Date().toISOString(), status },
          overrideAccess: true,
        })

      if (immediateSubscriptions.length === 0) {
        // No immediate work. Digest subscriptions (if any) leave the event
        // `pending` for `sendNotificationDigest` to pick up. With no
        // subscriptions at all, nothing will ever process it, so resolve it now.
        if (!hasPendingDigest) {
          await settle('sent')
        }
        return { output: { eventId } }
      }

      if (alreadyDelivered) {
        // A previous attempt already delivered immediate notifications. Never
        // re-send; just settle the status (digest subs keep it `pending`).
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
      await payload.update({
        id: event.id as number | string,
        collection: eventsSlug,
        data: { deliveredImmediate: true },
        overrideAccess: true,
      })

      const eventContext = {
        id: eventId,
        contextData: contextData ?? {},
        trigger: rule.trigger,
      }

      let anyDeliveryAttempted = false
      let anyDeliverySucceeded = false

      for (const sub of immediateSubscriptions) {
        const subChannels = (sub.channels ?? []) as string[]

        for (const channelDef of channels) {
          if (!subChannels.includes(channelDef.value)) {continue}

          anyDeliveryAttempted = true

          const [err] = await attemptAsync(() =>
            channelDef.handler({
              event: eventContext,
              rendered: {
                html: rendered.html,
                subject: rendered.subject,
                text: rendered.text,
              },
              req,
              slugs: resolvedSlugs,
              subscription: sub as Record<string, unknown>,
            }),
          )

          if (err) {
            payload.logger.error(
              { channel: channelDef.value, err, eventId, ruleId },
              'processNotificationEvent: channel handler failed',
            )
          } else {
            anyDeliverySucceeded = true
          }
        }
      }

      if (hasPendingDigest) {
        // Leave the event `pending` so `sendNotificationDigest` still delivers
        // to digest subscribers, regardless of how immediate delivery fared.
        // The digest run finalises the status (and stamps processedAt).
        return { output: { eventId } }
      }

      await settle(anyDeliveryAttempted && !anyDeliverySucceeded ? 'failed' : 'sent')

      return { output: { eventId } }
    },
  }
}
