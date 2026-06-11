import type { ChannelDefinition } from '../types.js'

export type EmailSender = (args: {
  html: string
  subject: string
  text: string
  to: string
}) => Promise<void>

/**
 * Built-in email channel. Sends one email per user listed in the subscription.
 *
 * The subscription must have a `users` relationship field (contributed by this
 * channel). Each user doc must have an `email` property.
 *
 * For digest delivery, all pending items are passed as an array so the caller
 * can render a single digest email per user.
 */
export function makeEmailChannel(sendEmail: EmailSender): ChannelDefinition {
  return {
    fields: [
      {
        name: 'users',
        type: 'relationship',
        admin: {
          condition: (data) =>
            Array.isArray(data['channels']) && data['channels'].includes('email'),
        },
        defaultValue: ({ user }: { user: unknown }) => {
          const id = (user as { id?: string } | null)?.id
          return id ? [id] : []
        },
        hasMany: true,
        relationTo: 'users',
        required: true,
      },
    ],
    label: 'Email',
    value: 'email',

    handler: async ({ rendered, subscription }) => {
      const users = resolveUsers(subscription)

      for (const user of users) {
        await sendEmail({
          html: rendered.html,
          subject: rendered.subject,
          text: rendered.text,
          to: user.email,
        })
      }
    },

    digestHandler: async ({ items, schedule, subscription }) => {
      const users = resolveUsers(subscription)
      const scheduleLabel = schedule === 'daily' ? 'Daily' : 'Weekly'
      const digestSubject = `${scheduleLabel} notification digest`

      const html = items
        .map((item) => `<p><strong>${item.subject}</strong></p>${item.html}`)
        .join('<hr/>')

      const text = items.map((item) => `${item.subject}\n${item.text}`).join('\n\n---\n\n')

      for (const user of users) {
        await sendEmail({
          html,
          subject: digestSubject,
          text,
          to: user.email,
        })
      }
    },
  }
}

function resolveUsers(
  subscription: Record<string, unknown>,
): { email: string; id: string }[] {
  const raw = subscription['users']
  if (!Array.isArray(raw)) {return []}

  return raw
    .map((u) => (typeof u === 'object' && u !== null ? u : null) as null | Record<string, unknown>)
    .filter((u): u is Record<string, unknown> => u !== null && typeof u['email'] === 'string')
    .map((u) => ({ id: String(u['id']), email: u['email'] as string }))
}
