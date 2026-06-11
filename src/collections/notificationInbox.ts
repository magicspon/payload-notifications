import type { CollectionConfig } from 'payload'

export function buildNotificationInboxCollection(
  slug: string,
  eventsSlug: string,
): CollectionConfig {
  return {
    slug,
    access: {
      create: () => false,
      delete: ({ req }) => {
        const user = req.user as { role?: string } | null
        return user?.role === 'admin'
      },
      read: ({ req }) => {
        const user = req.user as { id?: string; role?: string } | null
        if (!user) {return false}
        if (user.role === 'admin') {return true}
        return { user: { equals: user.id } }
      },
      update: ({ req }) => {
        const user = req.user as { id?: string; role?: string } | null
        if (!user) {return false}
        if (user.role === 'admin') {return true}
        return { user: { equals: user.id } }
      },
    },
    admin: {
      defaultColumns: ['subject', 'read', 'user', 'createdAt'],
      group: 'Notifications',
      useAsTitle: 'subject',
    },
    dbName: 'notif_inbox',
    fields: [
      {
        name: 'user',
        type: 'relationship',
        admin: { readOnly: true },
        index: true,
        relationTo: 'users',
        required: true,
      },
      {
        name: 'event',
        type: 'relationship',
        admin: {
          description: 'Source event. Empty for digest records, which collapse multiple events.',
          readOnly: true,
        },
        relationTo: eventsSlug as never,
      },
      {
        name: 'subject',
        type: 'text',
        admin: { readOnly: true },
        required: true,
      },
      {
        name: 'message',
        type: 'textarea',
        admin: { readOnly: true },
      },
      {
        name: 'read',
        type: 'checkbox',
        defaultValue: false,
      },
      {
        name: 'readAt',
        type: 'date',
        admin: { position: 'sidebar', readOnly: true },
      },
    ],
    hooks: {
      beforeChange: [
        ({ data, originalDoc }) => {
          if (data.read && !originalDoc?.read) {
            return { ...data, readAt: new Date().toISOString() }
          }
          return data
        },
      ],
    },
    labels: { plural: 'Notifications', singular: 'Notification' },
  }
}
