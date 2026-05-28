import type { Config } from 'payload'

import type { NotificationsPluginConfig } from './types.js'

import { buildNotificationEventsCollection } from './collections/notificationEvents.js'
import { buildNotificationInboxCollection } from './collections/notificationInbox.js'
import { buildNotificationRulesCollection } from './collections/notificationRules.js'
import { buildNotificationSubscriptionsCollection } from './collections/notificationSubscriptions.js'
import { makeProcessNotificationEventTask } from './jobs/processNotificationEvent.js'
import { makeSendNotificationDigestTask } from './jobs/sendNotificationDigest.js'
import { mergeCollection } from './utils/mergeCollection.js'

export { makeEmailChannel } from './channels/makeEmailChannel.js'
export { makeInboxChannel } from './channels/makeInboxChannel.js'
export { makeWebhookChannel } from './channels/makeWebhookChannel.js'
export type { ChannelDefinition, NotificationsPluginConfig, RenderedNotification, TriggerDefinition } from './types.js'
export { evaluateFieldConditions } from './utils/evaluateFieldConditions.js'
export { makeTriggers } from './utils/makeTriggers.js'
export { queueNotificationRules } from './utils/queueNotificationRules.js'
export { renderNotification } from './utils/renderNotification.js'

export function notificationsPlugin(
  options: NotificationsPluginConfig,
): (config: Config) => Config {
  return (incomingConfig: Config): Config => {
    const config = { ...incomingConfig }

    const slugs = {
      events: options.slugs?.events ?? 'notification-events',
      inbox: options.slugs?.inbox ?? 'notification-inbox',
      rules: options.slugs?.rules ?? 'notification-rules',
      subscriptions: options.slugs?.subscriptions ?? 'notification-subscriptions',
    }

    const overrides = options.collections ?? {}

    const rulesCollection = mergeCollection(
      buildNotificationRulesCollection(options, slugs.rules),
      overrides.notificationRules,
    )
    const eventsCollection = mergeCollection(
      buildNotificationEventsCollection(slugs.events, slugs.rules),
      overrides.notificationEvents,
    )
    const inboxCollection = mergeCollection(
      buildNotificationInboxCollection(slugs.inbox, slugs.events),
      overrides.notificationInbox,
    )
    const subscriptionsCollection = mergeCollection(
      buildNotificationSubscriptionsCollection(slugs.subscriptions, slugs.rules, options.channels),
      overrides.notificationSubscriptions,
    )

    if (!config.collections) {config.collections = []}
    config.collections.push(rulesCollection, eventsCollection, inboxCollection, subscriptionsCollection)

    if (options.disabled) {return config}

    if (!config.jobs) {
      config.jobs = { tasks: [] }
    } else if (!config.jobs.tasks) {
      config.jobs.tasks = []
    }

    ;(config.jobs.tasks as unknown[]).push(
      makeProcessNotificationEventTask(options.channels, slugs),
      makeSendNotificationDigestTask(options.channels, slugs),
    )

    return config
  }
}
