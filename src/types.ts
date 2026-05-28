import type { CollectionConfig, Field, Payload, PayloadRequest, Where } from 'payload'

export type TriggerDefinition = {
  label: string
  supportsFieldConditions?: boolean
  value: string
}

export type RenderedNotification = {
  html: string
  subject: string
  text: string
}

/** Fully-resolved collection slugs, injected into channel handlers at runtime. */
export type ResolvedSlugs = {
  events: string
  inbox: string
  rules: string
  subscriptions: string
}

export type ChannelHandlerArgs = {
  event: { contextData: Record<string, string>; id: string; trigger: string }
  rendered: RenderedNotification
  req: PayloadRequest
  slugs: ResolvedSlugs
  subscription: Record<string, unknown>
}

export type DigestChannelHandlerArgs = {
  items: Array<{ contextData: Record<string, string>; trigger: string } & RenderedNotification>
  req: PayloadRequest
  schedule: 'daily' | 'weekly'
  slugs: ResolvedSlugs
  subscription: Record<string, unknown>
}

export type ChannelDefinition = {
  digestHandler?: (args: DigestChannelHandlerArgs) => Promise<void>
  fields?: Field[]
  handler: (args: ChannelHandlerArgs) => Promise<void>
  label: string
  value: string
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export type CollectionOverride = {
  fields?: Field[]
} & DeepPartial<CollectionConfig>

export type NotificationsPluginConfig = {
  channels: ChannelDefinition[]
  /** Extra fields / deep overrides merged into each plugin collection. */
  collections?: {
    notificationEvents?: CollectionOverride
    notificationInbox?: CollectionOverride
    notificationRules?: CollectionOverride
    notificationSubscriptions?: CollectionOverride
  }
  disabled?: boolean
  /** Additional Lexical editor features for the rules message field. */
  editorFeatures?: unknown[]
  /** Path to a custom admin component for the fieldConditions JSON editor. */
  fieldConditionsComponent?: string
  slugs?: {
    events?: string
    inbox?: string
    rules?: string
    subscriptions?: string
  }
  triggers: TriggerDefinition[]
}

// ─── Internal shapes ──────────────────────────────────────────────────────────

export type NotificationRuleShape = {
  active?: boolean | null
  fieldConditions?: unknown
  id: string
  message: unknown
  name: string
  subject: string
  trigger: string
}

export type NotificationEventShape = {
  contextData?: null | Record<string, string>
  createdAt: string
  id: string
  processedAt?: null | string
  rule: { id?: string; name?: string; subject?: string } | string
  status?: string
  trigger: string
}

// ─── Field conditions ─────────────────────────────────────────────────────────

export type FieldConditionOperator =
  | 'changed'
  | 'contains'
  | 'equals'
  | 'greater_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'less_than'
  | 'not_changed'
  | 'not_contains'
  | 'not_equals'

export type FieldCondition = {
  field: string
  operator: FieldConditionOperator
  value?: number | string
}

export type FieldConditions = {
  conditions: FieldCondition[]
  logic: 'and' | 'or'
}

// ─── queueNotificationRules options ──────────────────────────────────────────

export type QueueNotificationRulesOptions = {
  contextData?: Record<string, string>
  contextFilters?: Where
  currentDoc?: Record<string, unknown>
  payload: Payload
  previousDoc?: Record<string, unknown>
  slugs?: NotificationsPluginConfig['slugs']
  trigger: string
}
