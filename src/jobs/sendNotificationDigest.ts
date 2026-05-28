import type { TaskConfig } from 'payload'

import type {
  ChannelDefinition,
  NotificationEventShape,
  NotificationRuleShape,
  ResolvedSlugs,
} from '../types.js'

import { attemptAsync } from '../utils/attemptAsync.js'
import { extractId } from '../utils/extractId.js'
import { renderNotification } from '../utils/renderNotification.js'

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
  const resolvedSlugs: ResolvedSlugs = {
    events: slugs.events ?? 'notification-events',
    inbox: slugs.inbox ?? 'notification-inbox',
    rules: slugs.rules ?? 'notification-rules',
    subscriptions: slugs.subscriptions ?? 'notification-subscriptions',
  }
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

      const now = new Date().toISOString()

      const { docs: pendingEvents } = await payload.find({
        collection: eventsSlug as never,
        depth: 1,
        limit: 500,
        overrideAccess: true,
        where: {
          and: [
            { status: { equals: 'pending' } },
            { createdAt: { less_than: now } },
          ],
        },
      })

      if (pendingEvents.length === 500) {
        payload.logger.warn(
          { limit: 500, schedule },
          'sendNotificationDigest: pending events query hit the limit — some events deferred to next run',
        )
      }

      if (pendingEvents.length === 0) {
        return { output: { processed: '0' } }
      }

      const events = pendingEvents as unknown as NotificationEventShape[]

      const ruleIds = [
        ...new Set(events.map((e) => extractId(e.rule)).filter((id): id is string => !!id)),
      ]

      const { docs: subscriptions } = await payload.find({
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
      await Promise.all(
        relevantEvents.map((ev) =>
          payload.update({
            id: ev.id,
            collection: eventsSlug as never,
            data: { status: 'processing' },
            overrideAccess: true,
          }),
        ),
      )

      // Render each event at most once, keyed by event id.
      type RenderedItem = {
        contextData: Record<string, string>
        eventId: string
        html: string
        subject: string
        text: string
        trigger: string
      }
      const renderCache = new Map<string, null | RenderedItem>()
      const renderItem = async (ev: NotificationEventShape): Promise<null | RenderedItem> => {
        const eventId = String(ev.id)
        if (renderCache.has(eventId)) {return renderCache.get(eventId) ?? null}

        const rule = typeof ev.rule === 'object' ? (ev.rule as unknown as NotificationRuleShape) : null
        if (!rule) {
          renderCache.set(eventId, null)
          return null
        }

        const contextData = ev.contextData ?? {}
        const rendered = await renderNotification(rule, contextData)
        const item: null | RenderedItem = rendered.renderFailed
          ? null
          : { contextData, eventId, html: rendered.html, subject: rendered.subject, text: rendered.text, trigger: ev.trigger }
        renderCache.set(eventId, item)
        return item
      }

      // Aggregate delivery outcomes per event across every subscription/channel.
      const attempted = new Set<string>()
      const succeeded = new Set<string>()

      for (const sub of subscriptions) {
        const ruleId = extractId(sub.rule as never)
        if (!ruleId) {continue}

        const matchingEvents = relevantEvents.filter((e) => extractId(e.rule) === ruleId)
        if (matchingEvents.length === 0) {continue}

        const items = (await Promise.all(matchingEvents.map(renderItem))).filter(
          (item): item is RenderedItem => item !== null,
        )
        if (items.length === 0) {continue}

        const subChannels = (sub.channels ?? []) as string[]

        for (const channelDef of channels) {
          if (!subChannels.includes(channelDef.value)) {continue}

          for (const item of items) {attempted.add(item.eventId)}

          if (channelDef.digestHandler) {
            const [err] = await attemptAsync(() =>
              channelDef.digestHandler!({
                items,
                req,
                schedule,
                slugs: resolvedSlugs,
                subscription: sub as Record<string, unknown>,
              }),
            )
            if (err) {
              payload.logger.error(
                { channel: channelDef.value, err },
                'sendNotificationDigest: digestHandler failed',
              )
            } else {
              for (const item of items) {succeeded.add(item.eventId)}
            }
          } else {
            // Fallback: call the per-event handler once per item.
            for (const item of items) {
              const [err] = await attemptAsync(() =>
                channelDef.handler({
                  event: { id: item.eventId, contextData: item.contextData, trigger: item.trigger },
                  rendered: { html: item.html, subject: item.subject, text: item.text },
                  req,
                  slugs: resolvedSlugs,
                  subscription: sub as Record<string, unknown>,
                }),
              )
              if (err) {
                payload.logger.error(
                  { channel: channelDef.value, err },
                  'sendNotificationDigest: handler failed for event',
                )
              } else {
                succeeded.add(item.eventId)
              }
            }
          }
        }
      }

      // Finalise each event exactly once: `sent` if any delivery succeeded,
      // otherwise `failed` (it was attempted, or could not be rendered/routed).
      const processedAt = new Date().toISOString()
      let processed = 0
      await Promise.all(
        relevantEvents.map((ev) => {
          const id = String(ev.id)
          const status = succeeded.has(id) ? 'sent' : 'failed'
          if (status === 'sent') {processed++}
          return payload.update({
            id: ev.id,
            collection: eventsSlug as never,
            data: { processedAt, status },
            overrideAccess: true,
          })
        }),
      )

      return { output: { processed: String(processed) } }
    },
  }
}
