import type { ChannelDefinition } from '../types.js'

/**
 * Built-in in-app inbox channel. Creates a record in the resolved inbox
 * collection for each user in the subscription.
 *
 * This channel does NOT contribute a `users` field to the subscriptions
 * collection — it reads from the `users` field already present (e.g. contributed
 * by `makeEmailChannel`, or added via the `collections.notificationSubscriptions`
 * override). Register `makeEmailChannel` before this channel, or add a `users`
 * field manually if using inbox standalone.
 *
 * The target collection is taken from the plugin's resolved `slugs.inbox` at
 * runtime, so a custom `slugs.inbox` is honoured automatically. Pass
 * `inboxSlugOverride` only to target a different collection than the plugin's.
 *
 * @param inboxSlugOverride - optional slug that overrides the resolved inbox slug.
 */
export function makeInboxChannel(inboxSlugOverride?: string): ChannelDefinition {
  return {
    label: 'In-App',
    value: 'in_app',

    handler: async ({ event, rendered, req, slugs, subscription }) => {
      const inboxSlug = inboxSlugOverride ?? slugs.inbox
      const users = resolveUsers(subscription)
      const eventId = coerceId(event.id)

      await Promise.all(
        users.map((user) =>
          req.payload.create({
            collection: inboxSlug as never,
            data: {
              event: eventId,
              message: rendered.text,
              read: false,
              subject: rendered.subject,
              user: user.id,
            },
            overrideAccess: true,
          }),
        ),
      )
    },

    digestHandler: async ({ items, req, slugs, subscription }) => {
      const inboxSlug = inboxSlugOverride ?? slugs.inbox
      const users = resolveUsers(subscription)
      const digestSubject = `${items.length} notification${items.length === 1 ? '' : 's'}`

      await Promise.all(
        users.map((user) =>
          req.payload.create({
            collection: inboxSlug as never,
            data: {
              message: items.map((i) => i.text).join('\n\n---\n\n'),
              read: false,
              subject: digestSubject,
              user: user.id,
            },
            overrideAccess: true,
          }),
        ),
      )
    },
  }
}

/** Coerce a string ID to a number when it is purely numeric (SQLite int IDs). */
function coerceId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id
}

function resolveUsers(
  subscription: Record<string, unknown>,
): { email: string; id: number | string }[] {
  const raw = subscription['users']
  if (!Array.isArray(raw)) {return []}

  return raw
    .map((u) =>
      typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : null,
    )
    .filter((u): u is Record<string, unknown> => u !== null && u['id'] != null)
    .map((u) => ({ id: u['id'] as number | string, email: typeof u['email'] === 'string' ? u['email'] : '' }))
}
