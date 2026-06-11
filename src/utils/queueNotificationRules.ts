import type { Where } from 'payload'

import type { FieldConditions, QueueNotificationRulesOptions } from '../types.js'

import { attemptAsync } from './attemptAsync.js'
import { evaluateFieldConditions } from './evaluateFieldConditions.js'

/**
 * Finds all active notification rules matching the trigger (and optional
 * contextFilters) and queues a `processNotificationEvent` job for each one.
 *
 * When `previousDoc` and `currentDoc` are both provided the built-in
 * `evaluateFieldConditions` runs against each rule's `fieldConditions` JSON.
 * Rules without `fieldConditions` are always queued.
 *
 * Fire-and-forget: errors are logged but never thrown so callers are not blocked.
 */
export async function queueNotificationRules({
  contextData = {},
  contextFilters,
  currentDoc,
  payload,
  previousDoc,
  slugs,
  trigger,
}: QueueNotificationRulesOptions): Promise<void> {
  const rulesSlug = slugs?.rules ?? 'notification-rules'

  const conditions: Where[] = [
    { trigger: { equals: trigger } },
    { active: { equals: true } },
  ]

  if (contextFilters) {
    conditions.push(contextFilters)
  }

  const where: Where = { and: conditions }

  const [err, result] = await attemptAsync(() =>
    payload.find({
      collection: rulesSlug as never,
      depth: 0,
      pagination: false,
      where,
    }),
  )

  if (err || !result) {
    payload.logger.error({ err, trigger }, 'queueNotificationRules: failed to query rules')
    return
  }

  const rulesToQueue =
    previousDoc && currentDoc
      ? result.docs.filter((rule) => {
          const fc = (rule as Record<string, unknown>)['fieldConditions']
          if (fc == null) {return true}
          return evaluateFieldConditions(
            fc as FieldConditions,
            previousDoc,
            currentDoc,
          )
        })
      : result.docs

  await Promise.all(
    rulesToQueue.map(async (rule) => {
      const [queueErr] = await attemptAsync(() =>
        payload.jobs.queue({
          input: {
            contextData,
            ruleId: String(rule.id),
          },
          task: 'processNotificationEvent',
        }),
      )

      if (queueErr) {
        payload.logger.error(
          { err: queueErr, ruleId: rule.id, trigger },
          'queueNotificationRules: failed to queue job',
        )
      }
    }),
  )
}
