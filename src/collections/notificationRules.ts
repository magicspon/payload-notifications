import type { LexicalEditorProps } from '@payloadcms/richtext-lexical'
import type { CollectionConfig, Field, RichTextField } from 'payload'

import {
  BoldFeature,
  FixedToolbarFeature,
  HeadingFeature,
  ItalicFeature,
  lexicalEditor,
  LinkFeature,
  UnderlineFeature,
} from '@payloadcms/richtext-lexical'

import type { NotificationsPluginConfig } from '../types.js'

export function buildNotificationRulesCollection(
  options: NotificationsPluginConfig,
  slug: string,
): CollectionConfig {
  const baseFeatures = [
    HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3'] }),
    FixedToolbarFeature(),
    BoldFeature(),
    ItalicFeature(),
    UnderlineFeature(),
    LinkFeature({ maxDepth: 2 }),
    ...(options.editorFeatures ?? []),
  ] as LexicalEditorProps['features']

  const notificationEditor = lexicalEditor({ features: baseFeatures })

  // Triggers that support field conditions — used to show/hide the editor
  const fieldConditionTriggerValues = options.triggers
    .filter((t) => t.supportsFieldConditions)
    .map((t) => t.value)

  const fields: Field[] = [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'trigger',
      type: 'select',
      admin: { description: 'The event that fires this notification' },
      index: true,
      options: options.triggers.map(({ label, value }) => ({ label, value })),
      required: true,
    },
    {
      name: 'fieldConditions',
      type: 'json',
      admin: {
        condition: (data) =>
          typeof data['trigger'] === 'string' &&
          fieldConditionTriggerValues.includes(data['trigger']),
        description:
          'JSON condition builder: { logic: "and"|"or", conditions: [{ field, operator, value }] }',
        ...(options.fieldConditionsComponent
          ? { components: { Field: options.fieldConditionsComponent } }
          : {}),
      },
    },
    {
      name: 'subject',
      type: 'text',
      admin: { description: 'Supports {{fieldName}} token replacement' },
      required: true,
    },
    {
      name: 'message',
      type: 'richText',
      editor: notificationEditor as unknown as RichTextField['editor'],
      required: true,
    },
    {
      name: 'active',
      type: 'checkbox',
      admin: { position: 'sidebar' },
      defaultValue: true,
    },
    {
      name: 'createdBy',
      type: 'relationship',
      admin: { position: 'sidebar', readOnly: true },
      defaultValue: ({ user }) => (user as { id?: string } | null)?.id,
      relationTo: 'users',
    },
  ]

  return {
    slug,
    access: {
      create: ({ req }) => !!req.user,
      delete: ({ req }) => !!req.user,
      read: ({ req }) => !!req.user,
      update: ({ req }) => !!req.user,
    },
    admin: {
      defaultColumns: ['name', 'trigger', 'active'],
      group: 'Notifications',
      useAsTitle: 'name',
    },
    dbName: 'notif_rules',
    fields,
    labels: { plural: 'Notification Rules', singular: 'Notification Rule' },
  }
}
