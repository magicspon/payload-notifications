# @spon/payload-notifications

A generic, channel-based notifications plugin for [Payload CMS](https://payloadcms.com) 3.0.

Define **rules** in the admin UI (what to send, on which trigger, with optional field conditions), let users create **subscriptions** (which channel, immediate or digest), and deliver through pluggable **channels** — email, webhook, and in-app inbox out of the box, or your own.

The plugin is intentionally decoupled from any particular domain: it has no opinion about _what_ fires a notification. Your app wires its own hooks and calls `queueNotificationRules`, passing a generic `contextData` bag that is substituted into templates.

---

## Features

- **Channel registry** — email, webhook, and in-app inbox built in; add custom channels with a single object.
- **Rules + subscriptions** — content editors author rules; users subscribe per channel.
- **Field conditions** — fire a rule only when a document changes in a specific way (`status` becomes `published`, etc.).
- **Template placeholders** — `{{token}}` substitution from `contextData` in subjects and Lexical message bodies (HTML-escaped).
- **Digests** — `immediate`, `daily`, or `weekly` delivery, batched per subscriber.
- **Caller-wired triggers** — no magic collection watching; you decide when to queue.
- **Configurable slugs & collection overrides** — rename collections, add fields (e.g. a tenant relationship), or merge admin config.
- **Idempotent jobs** — retries never double-send.

---

## Requirements

- `payload@^3.84.1`
- `@payloadcms/richtext-lexical` (used for the rule message field and HTML rendering)

---

## Installation

```bash
pnpm add @spon/payload-notifications
# or: npm i @spon/payload-notifications / yarn add @spon/payload-notifications
```

---

## Quick start

```ts
import { buildConfig } from 'payload'
import {
  makeEmailChannel,
  makeInboxChannel,
  makeWebhookChannel,
  makeTriggers,
  notificationsPlugin,
} from '@spon/payload-notifications'

export default buildConfig({
  // ...
  plugins: [
    notificationsPlugin({
      // The delivery channels available to subscriptions.
      channels: [
        // `makeEmailChannel` contributes the `users` relationship field, so
        // register it before `makeInboxChannel` (which reads that field).
        makeEmailChannel(async ({ to, subject, html, text }) => {
          await myMailer.send({ to, subject, html, text })
        }),
        makeInboxChannel(),
        makeWebhookChannel(),
      ],

      // The events editors can pick when authoring a rule.
      triggers: [
        ...makeTriggers('posts'), // posts.created / posts.updated / posts.field_changed
        { label: 'Custom Event', value: 'custom.event' },
      ],
    }),
  ],
})
```

This registers four collections under a **Notifications** admin group:

| Collection                  | Default slug                 | Purpose                                              |
| --------------------------- | ---------------------------- | ---------------------------------------------------- |
| Notification Rules          | `notification-rules`         | Editor-authored templates (trigger, subject, body).  |
| Notification Subscriptions  | `notification-subscriptions` | Who gets notified, on which channel, immediate/digest.|
| Notification Events         | `notification-events`        | Audit log of every fired rule and its delivery state.|
| Notifications (Inbox)       | `notification-inbox`         | In-app inbox records (used by `makeInboxChannel`).   |

It also registers two jobs: `processNotificationEvent` (queued automatically) and `sendNotificationDigest` (you schedule it — see [Digests](#digests)).

---

## Wiring triggers

The plugin never watches your collections for you. Fire a notification by calling `queueNotificationRules` from wherever the event happens — most commonly a collection `afterChange` hook.

```ts
import type { CollectionConfig } from 'payload'
import { queueNotificationRules } from '@spon/payload-notifications'

export const Posts: CollectionConfig = {
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'status', type: 'text' },
  ],
  hooks: {
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        await queueNotificationRules({
          payload: req.payload,
          trigger: operation === 'create' ? 'posts.created' : 'posts.updated',
          // Substituted into `{{token}}` placeholders. Values must be strings.
          contextData: { title: String(doc.title ?? ''), status: String(doc.status ?? '') },
          // Pass both docs to enable field-condition evaluation (see below).
          previousDoc,
          currentDoc: doc,
        })
      },
    ],
  },
}
```

`queueNotificationRules` finds every **active** rule matching the `trigger`, evaluates each rule's field conditions (when `previousDoc` _and_ `currentDoc` are supplied), and queues a `processNotificationEvent` job per matching rule. It is fire-and-forget: failures are logged, never thrown, so your hook is never blocked.

### Options

| Option           | Type                       | Description                                                                 |
| ---------------- | -------------------------- | --------------------------------------------------------------------------- |
| `payload`        | `Payload`                  | **Required.** The Payload instance (e.g. `req.payload`).                    |
| `trigger`        | `string`                   | **Required.** Matches `rule.trigger`.                                       |
| `contextData`    | `Record<string, string>`   | Token map for `{{placeholder}}` substitution.                               |
| `previousDoc`    | `Record<string, unknown>`  | Enables `changed` / `not_changed` field conditions.                         |
| `currentDoc`     | `Record<string, unknown>`  | Required (with `previousDoc`) for field-condition evaluation.               |
| `contextFilters` | `Where`                    | Extra `where` clause to scope which rules match (e.g. by tenant).           |
| `slugs`          | `{ rules?: string }`       | Override the rules slug if you customised it.                               |

> **Note:** Running queued jobs requires Payload's job system to be active — via `jobs.autoRun`, a cron hitting `/api/payload-jobs/run`, or calling `payload.jobs.run()` in a worker. See the [Payload Jobs docs](https://payloadcms.com/docs/jobs-queue/overview).

---

## Channels

A channel owns its delivery logic and any subscription fields it needs.

### Email — `makeEmailChannel(sendEmail)`

Sends one email per user in the subscription. Contributes a required `users` relationship field (defaulting to the current admin user) to subscriptions.

```ts
makeEmailChannel(async ({ to, subject, html, text }) => {
  await myMailer.send({ to, subject, html, text })
})
```

For digests, all pending items are passed to a single batched email per user.

### In-app inbox — `makeInboxChannel(inboxSlugOverride?)`

Creates an inbox record per user. It does **not** contribute a `users` field — it reads the one contributed by `makeEmailChannel`, so register email first, or add a `users` field via a [collection override](#collection-overrides). The target collection follows the plugin's resolved `slugs.inbox` automatically; pass `inboxSlugOverride` only to target a different collection.

```ts
makeInboxChannel()
```

### Webhook — `makeWebhookChannel(options?)`

POSTs the rendered notification to a per-subscription URL. Contributes a `webhookUrl` text field.

```ts
makeWebhookChannel({
  allowPrivateHosts: false, // default: reject localhost / private / link-local hosts (SSRF guard)
  timeoutMs: 10_000,        // default request timeout
})
```

Set `allowPrivateHosts: true` only when you intentionally deliver to internal services.

### Custom channels

A channel is just an object implementing `ChannelDefinition`:

```ts
import type { ChannelDefinition } from '@spon/payload-notifications'

const slackChannel: ChannelDefinition = {
  label: 'Slack',
  value: 'slack',
  // Optional: fields merged into the subscriptions collection.
  fields: [{ name: 'slackChannelId', type: 'text' }],

  // Called once per matching subscription for immediate delivery.
  handler: async ({ event, rendered, req, slugs, subscription }) => {
    await postToSlack(subscription.slackChannelId as string, rendered.text)
  },

  // Optional: batched digest delivery. Falls back to `handler` per item if omitted.
  digestHandler: async ({ items, schedule, subscription }) => {
    await postToSlack(subscription.slackChannelId as string, summarise(items))
  },
}
```

`rendered` is `{ subject, html, text }`. `event` is `{ id, trigger, contextData }`. `slugs` carries the resolved collection slugs.

---

## Field conditions

Triggers created with `supportsFieldConditions: true` (e.g. the `*.field_changed` trigger from `makeTriggers`) reveal a JSON **field conditions** editor on the rule. A rule fires only when its conditions pass against the `previousDoc` / `currentDoc` you pass to `queueNotificationRules`.

```json
{
  "logic": "and",
  "conditions": [
    { "field": "status", "operator": "equals", "value": "published" },
    { "field": "status", "operator": "changed" }
  ]
}
```

- `logic`: `"and"` (all must pass) or `"or"` (any).
- `field` supports dot paths for nested values, e.g. `"author.role"`.
- Operators: `equals`, `not_equals`, `contains`, `not_contains`, `greater_than`, `less_than`, `is_empty`, `is_not_empty`, `changed`, `not_changed`.

Rules **without** field conditions always fire for their trigger. Want a custom UI instead of raw JSON? Pass `fieldConditionsComponent` (see [Customisation](#customisation)).

You can also evaluate conditions yourself:

```ts
import { evaluateFieldConditions } from '@spon/payload-notifications'

const matches = evaluateFieldConditions(conditions, previousDoc, currentDoc)
```

---

## Template placeholders

Rule **subjects** and **message bodies** support `{{token}}` substitution from `contextData`:

- Subject: `New post: {{title}}`
- Body (Lexical rich text): `Hello {{name}}, "{{title}}" is now {{status}}.`

Missing tokens become empty strings. Values substituted into the HTML body are HTML-escaped to prevent markup/script injection; subjects are plain text.

Render a rule programmatically:

```ts
import { renderNotification } from '@spon/payload-notifications'

const { subject, html, text, renderFailed } = await renderNotification(rule, contextData)
```

---

## Digests

Each subscription has a `schedule`: `immediate` (default), `daily`, or `weekly`. Immediate subscriptions are delivered as soon as the event is processed. Digest subscriptions leave the event `pending` for the `sendNotificationDigest` job to batch and deliver.

You schedule the digest job, passing the schedule to run:

```ts
// Enqueue a daily digest run (then ensure your job queue executes it).
await payload.jobs.queue({
  task: 'sendNotificationDigest',
  input: { schedule: 'daily' }, // or 'weekly'
})
```

Wire this to a cron (e.g. via `jobs.autoRun`, an external scheduler, or a serverless cron) so it runs at your chosen time. The job renders each pending event once, batches per subscriber, and marks events `sent` or `failed` exactly once.

---

## Customisation

### Slugs

```ts
notificationsPlugin({
  channels: [/* ... */],
  triggers: [/* ... */],
  slugs: {
    rules: 'notif-rules',
    subscriptions: 'notif-subs',
    events: 'notif-events',
    inbox: 'notif-inbox',
  },
})
```

### Collection overrides

Add fields or merge deep config into any plugin collection. Extra `fields` are appended; `hooks` arrays are concatenated with the plugin's; nested objects like `admin`/`access` are shallow-merged (so a partial override won't wipe the base).

```ts
notificationsPlugin({
  channels: [/* ... */],
  triggers: [/* ... */],
  collections: {
    notificationRules: {
      // Add a tenant relationship for multitenancy...
      fields: [{ name: 'tenant', type: 'relationship', relationTo: 'tenants' }],
      admin: { group: 'Messaging' },
    },
  },
})
```

Then scope rules per tenant by passing `contextFilters` to `queueNotificationRules`:

```ts
await queueNotificationRules({
  payload: req.payload,
  trigger: 'posts.created',
  contextFilters: { tenant: { equals: doc.tenant } },
})
```

### Editor features & condition UI

```ts
notificationsPlugin({
  channels: [/* ... */],
  triggers: [/* ... */],
  // Extra Lexical features for the rule message field.
  editorFeatures: [/* ...features */],
  // Path to a custom admin component for the field-conditions editor.
  fieldConditionsComponent: '/components/FieldConditionsBuilder#FieldConditionsBuilder',
})
```

### Other options

| Option     | Type      | Description                                          |
| ---------- | --------- | ---------------------------------------------------- |
| `disabled` | `boolean` | Register collections but skip jobs (e.g. for builds).|

---

## Access control & user roles

The events and inbox collections gate `delete` (and some reads) on an admin role, checking `req.user.role === 'admin'`. If your `users` collection has no `role` field these checks simply deny non-owners — add a `role` field if you want admins to manage these records. Rules and subscriptions require any authenticated user.

---

## Programmatic API

| Export                     | Description                                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `notificationsPlugin`      | The plugin factory.                                                   |
| `makeEmailChannel`         | Built-in email channel factory.                                       |
| `makeWebhookChannel`       | Built-in webhook channel factory (with SSRF guard).                   |
| `makeInboxChannel`         | Built-in in-app inbox channel factory.                                |
| `makeTriggers`             | Generates `created` / `updated` / `field_changed` triggers for a slug.|
| `queueNotificationRules`   | Finds matching rules and queues delivery jobs.                        |
| `renderNotification`       | Renders a rule's subject/body against `contextData`.                  |
| `evaluateFieldConditions`  | Evaluates a field-conditions object against two docs.                 |

Types: `NotificationsPluginConfig`, `ChannelDefinition`, `TriggerDefinition`, `RenderedNotification`.

---

## Development

```bash
pnpm install
pnpm dev            # run the dev Payload app (./dev)
pnpm test:unit      # vitest unit tests
pnpm test:int       # integration tests (SQLite in-memory)
pnpm test           # both
pnpm typecheck
pnpm lint
```

---

## License

MIT
