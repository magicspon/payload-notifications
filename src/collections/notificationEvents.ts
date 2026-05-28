import type { CollectionConfig } from 'payload'

export function buildNotificationEventsCollection(
  slug: string,
  rulesSlug: string,
): CollectionConfig {
  return {
    slug,
    access: {
      create: () => false,
      delete: ({ req }) => {
        const user = req.user as { role?: string } | null
        return user?.role === 'admin'
      },
      read: ({ req }) => !!req.user,
      update: () => false,
    },
    admin: {
      defaultColumns: ['trigger', 'status', 'processedAt', 'createdAt'],
      group: 'Notifications',
      useAsTitle: 'trigger',
    },
    dbName: 'notif_events',
    fields: [
      {
        name: 'rule',
        type: 'relationship',
        admin: { readOnly: true },
        relationTo: rulesSlug as never,
      },
      {
        name: 'trigger',
        type: 'text',
        admin: { readOnly: true },
      },
      {
        name: 'contextData',
        type: 'json',
        admin: { readOnly: true },
      },
      {
        name: 'status',
        type: 'select',
        admin: { position: 'sidebar', readOnly: true },
        defaultValue: 'pending',
        index: true,
        options: [
          { label: 'Pending', value: 'pending' },
          { label: 'Processing', value: 'processing' },
          { label: 'Sent', value: 'sent' },
          { label: 'Failed', value: 'failed' },
        ],
      },
      {
        name: 'processedAt',
        type: 'date',
        admin: { position: 'sidebar', readOnly: true },
      },
      {
        name: 'deliveredImmediate',
        type: 'checkbox',
        admin: { hidden: true, readOnly: true },
        defaultValue: false,
      },
      {
        name: 'dedupeKey',
        type: 'text',
        admin: { hidden: true, readOnly: true },
        index: true,
      },
    ],
    labels: { plural: 'Notification Events', singular: 'Notification Event' },
  }
}
