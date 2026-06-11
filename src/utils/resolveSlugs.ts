import type { ResolvedSlugs } from '../types.js'

/** Fill any missing collection slugs with their plugin defaults. */
export function resolveSlugs(slugs: Partial<ResolvedSlugs>): ResolvedSlugs {
  return {
    events: slugs.events ?? 'notification-events',
    inbox: slugs.inbox ?? 'notification-inbox',
    rules: slugs.rules ?? 'notification-rules',
    subscriptions: slugs.subscriptions ?? 'notification-subscriptions',
  }
}
