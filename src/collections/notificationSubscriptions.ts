import type { CollectionConfig, Field } from 'payload'

import type { ChannelDefinition } from '../types.js'

export function buildNotificationSubscriptionsCollection(
  slug: string,
  rulesSlug: string,
  channels: ChannelDefinition[],
): CollectionConfig {
  // Collect all fields contributed by channel definitions
  const channelFields: Field[] = channels.flatMap((ch) => ch.fields ?? [])

  return {
    slug,
    access: {
      create: ({ req }) => !!req.user,
      delete: ({ req }) => !!req.user,
      read: ({ req }) => !!req.user,
      update: ({ req }) => !!req.user,
    },
    admin: {
      defaultColumns: ['rule', 'schedule', 'active'],
      group: 'Notifications',
      useAsTitle: 'rule',
    },
    dbName: 'notif_subs',
    fields: [
      {
        name: 'rule',
        type: 'relationship',
        index: true,
        relationTo: rulesSlug as never,
        required: true,
      },
      {
        name: 'schedule',
        type: 'select',
        defaultValue: 'immediate',
        options: [
          { label: 'Immediate', value: 'immediate' },
          { label: 'Daily Digest', value: 'daily' },
          { label: 'Weekly Digest', value: 'weekly' },
        ],
        required: true,
      },
      {
        name: 'scheduleTime',
        type: 'text',
        admin: {
          condition: (data) => data['schedule'] !== 'immediate',
          description: 'Time to send digest (HH:MM, 24h)',
        },
        defaultValue: '08:00',
      },
      {
        name: 'scheduleDay',
        type: 'select',
        admin: {
          condition: (data) => data['schedule'] === 'weekly',
          description: 'Day of week for weekly digest',
        },
        defaultValue: '1',
        options: [
          { label: 'Sunday', value: '0' },
          { label: 'Monday', value: '1' },
          { label: 'Tuesday', value: '2' },
          { label: 'Wednesday', value: '3' },
          { label: 'Thursday', value: '4' },
          { label: 'Friday', value: '5' },
          { label: 'Saturday', value: '6' },
        ],
      },
      {
        name: 'channels',
        type: 'select',
        defaultValue: channels.length > 0 ? [channels[0].value] : [],
        hasMany: true,
        options: channels.map(({ label, value }) => ({ label, value })),
        required: true,
      },
      ...channelFields,
      {
        name: 'active',
        type: 'checkbox',
        admin: { position: 'sidebar' },
        defaultValue: true,
      },
    ],
    labels: {
      plural: 'Notification Subscriptions',
      singular: 'Notification Subscription',
    },
  }
}
