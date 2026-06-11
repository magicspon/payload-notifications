import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import {
  makeEmailChannel,
  makeInboxChannel,
  makeTriggers,
  makeWebhookChannel,
  notificationsPlugin,
  queueNotificationRules,
} from '@spon/payload-notifications'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

// ─── Shared Lexical fixture ───────────────────────────────────────────────────

const EMPTY_LEXICAL = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Hello {{name}}',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    format: '',
    indent: 0,
    version: 1,
  },
}

// ─── Test harness ─────────────────────────────────────────────────────────────

const sendEmail = vi.fn().mockResolvedValue(undefined)

let payload: Payload

beforeAll(async () => {
  const config = buildConfig({
    admin: { disable: true },
    collections: [
      { slug: 'users', auth: true, fields: [] },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'status', type: 'text' },
        ],
      },
    ],
    db: sqliteAdapter({ client: { url: ':memory:' } }),
    editor: lexicalEditor(),
    plugins: [
      notificationsPlugin({
        channels: [
          makeEmailChannel(async (args) => {
            await sendEmail(args)
          }),
          makeInboxChannel(),
          makeWebhookChannel(),
        ],
        triggers: [
          ...makeTriggers('posts'),
          { label: 'Custom Event', value: 'custom.event' },
        ],
      }),
    ],
    secret: 'test-secret-32-chars-minimum-abcd',
    typescript: { outputFile: '/tmp/payload-types-notifications-int.ts' },
  })

  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  await payload.destroy()
})

beforeEach(() => {
  sendEmail.mockClear()
  vi.restoreAllMocks()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0
async function createUser(prefix = 'user') {
  _counter++
  return payload.create({
    collection: 'users',
    data: { email: `${prefix}-${_counter}@test.example`, password: 'password123' },
    overrideAccess: true,
  })
}

async function createRule(overrides: Record<string, unknown> = {}) {
  return payload.create({
    collection: 'notification-rules',
    data: {
      name: 'Test Rule',
      active: true,
      message: EMPTY_LEXICAL,
      subject: 'Hello {{name}}',
      trigger: 'posts.created',
      ...overrides,
    },
    overrideAccess: true,
  })
}

async function createSubscription(
  ruleId: number | string,
  userIds: (number | string)[],
  overrides: Record<string, unknown> = {},
) {
  return payload.create({
    collection: 'notification-subscriptions',
    data: {
      active: true,
      channels: ['email'],
      rule: ruleId,
      schedule: 'immediate',
      users: userIds,
      ...overrides,
    },
    overrideAccess: true,
  })
}

async function runProcessTask(input: Record<string, unknown>, jobId?: string) {
  const registeredTasks = (
    payload as unknown as {
      config: { jobs?: { tasks?: Array<{ handler: (args: unknown) => Promise<{ output: { eventId: string } }>; slug: string }> } }
    }
  ).config.jobs?.tasks ?? []

  const task = registeredTasks.find((t) => t.slug === 'processNotificationEvent')
  if (!task) {throw new Error('processNotificationEvent task not registered')}

  const adminUser = await createUser('admin-task')

  return task.handler({
    input,
    job: jobId ? { id: jobId } : {},
    req: { payload, user: adminUser },
    tasks: {},
  })
}

/**
 * The digest job operates globally over all pending events, so prior tests in
 * this shared in-memory DB leave state behind. Drain it for an isolated run.
 */
async function resetNotifications() {
  for (const collection of [
    'notification-events',
    'notification-subscriptions',
    'notification-inbox',
  ] as const) {
    await payload.delete({ collection, overrideAccess: true, where: { id: { exists: true } } })
  }
}

async function runDigestTask(schedule: 'daily' | 'weekly') {
  const registeredTasks = (
    payload as unknown as {
      config: { jobs?: { tasks?: Array<{ handler: (args: unknown) => Promise<unknown>; slug: string }> } }
    }
  ).config.jobs?.tasks ?? []

  const task = registeredTasks.find((t) => t.slug === 'sendNotificationDigest')
  if (!task) {throw new Error('sendNotificationDigest task not registered')}

  const adminUser = await createUser('admin-digest')

  return task.handler({
    input: { schedule },
    job: {},
    req: { payload, user: adminUser },
    tasks: {},
  }) as Promise<{ output: { processed: string } }>
}

// ─── Collection registration ──────────────────────────────────────────────────

describe('collection registration', () => {
  test('notification-rules is registered', async () => {
    const result = await payload.find({ collection: 'notification-rules', limit: 0 })
    expect(result.totalDocs).toBeGreaterThanOrEqual(0)
  })

  test('notification-events is registered', async () => {
    const result = await payload.find({ collection: 'notification-events', limit: 0 })
    expect(result.totalDocs).toBeGreaterThanOrEqual(0)
  })

  test('notification-subscriptions is registered', async () => {
    const result = await payload.find({ collection: 'notification-subscriptions', limit: 0 })
    expect(result.totalDocs).toBeGreaterThanOrEqual(0)
  })

  test('notification-inbox is registered', async () => {
    const result = await payload.find({ collection: 'notification-inbox', limit: 0 })
    expect(result.totalDocs).toBeGreaterThanOrEqual(0)
  })
})

// ─── queueNotificationRules ───────────────────────────────────────────────────

describe('queueNotificationRules', () => {
  test('queues one job per matching active rule', async () => {
    await createRule({ name: 'Queue Rule 1', trigger: 'custom.event' })
    await createRule({ name: 'Queue Rule 2', trigger: 'custom.event' })
    await createRule({ name: 'Queue Rule Inactive', active: false, trigger: 'custom.event' })

    const before = await payload.find({ collection: 'payload-jobs', limit: 0 })

    await queueNotificationRules({ payload, trigger: 'custom.event' })

    const after = await payload.find({ collection: 'payload-jobs', limit: 0 })
    expect(after.totalDocs).toBeGreaterThanOrEqual(before.totalDocs + 2)
  })

  test('queues no jobs when trigger has no matching rules', async () => {
    const before = await payload.find({ collection: 'payload-jobs', limit: 0 })
    await queueNotificationRules({ payload, trigger: 'trigger.that.does.not.exist' })
    const after = await payload.find({ collection: 'payload-jobs', limit: 0 })
    expect(after.totalDocs).toBe(before.totalDocs)
  })

  test('respects contextFilters', async () => {
    await createRule({ name: 'Context Filter Match', trigger: 'posts.updated' })
    await createRule({ name: 'Context Filter No Match', trigger: 'posts.updated' })

    const before = await payload.find({ collection: 'payload-jobs', limit: 0 })

    await queueNotificationRules({
      contextFilters: { name: { equals: 'Context Filter Match' } },
      payload,
      trigger: 'posts.updated',
    })

    const after = await payload.find({ collection: 'payload-jobs', limit: 0 })
    expect(after.totalDocs).toBe(before.totalDocs + 1)
  })

  test('evaluates fieldConditions and skips rules that do not match', async () => {
    await createRule({
      name: 'Field Cond Rule',
      fieldConditions: {
        conditions: [{ field: 'status', operator: 'equals', value: 'published' }],
        logic: 'and',
      },
      trigger: 'posts.field_changed',
    })

    const before = await payload.find({ collection: 'payload-jobs', limit: 0 })

    // Does NOT match — status is still draft
    await queueNotificationRules({
      contextFilters: { name: { equals: 'Field Cond Rule' } },
      currentDoc: { status: 'draft' },
      payload,
      previousDoc: { status: 'draft' },
      trigger: 'posts.field_changed',
    })

    const afterNoMatch = await payload.find({ collection: 'payload-jobs', limit: 0 })
    expect(afterNoMatch.totalDocs).toBe(before.totalDocs)

    // Matches — status changed to published
    await queueNotificationRules({
      contextFilters: { name: { equals: 'Field Cond Rule' } },
      currentDoc: { status: 'published' },
      payload,
      previousDoc: { status: 'draft' },
      trigger: 'posts.field_changed',
    })

    const afterMatch = await payload.find({ collection: 'payload-jobs', limit: 0 })
    expect(afterMatch.totalDocs).toBe(before.totalDocs + 1)
  })
})

// ─── processNotificationEvent — rule guard ────────────────────────────────────

describe('processNotificationEvent — rule guard', () => {
  test('returns empty eventId when rule does not exist', async () => {
    const result = await runProcessTask({ contextData: {}, ruleId: 'nonexistent-id' })
    expect(result.output.eventId).toBe('')
  })

  test('returns empty eventId when rule is inactive', async () => {
    const rule = await createRule({ active: false })
    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })
    expect(result.output.eventId).toBe('')
  })
})

// ─── processNotificationEvent — event creation ────────────────────────────────

describe('processNotificationEvent — event creation', () => {
  test('creates a notification-event and returns its id', async () => {
    const rule = await createRule()
    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    expect(result.output.eventId).toBeTruthy()
    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect(event).toBeDefined()
  })

  test('stores contextData on the event', async () => {
    const rule = await createRule()
    const result = await runProcessTask({ contextData: { name: 'Bob', score: '99' }, ruleId: rule.id })

    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    const ctx = (event as { contextData?: Record<string, string> }).contextData
    expect(ctx?.name).toBe('Bob')
    expect(ctx?.score).toBe('99')
  })
})

// ─── processNotificationEvent — email channel ────────────────────────────────

describe('processNotificationEvent — email channel', () => {
  test('sends one email per user in the subscription', async () => {
    const rule = await createRule()
    const userA = await createUser('a')
    const userB = await createUser('b')
    await createSubscription(rule.id, [userA.id, userB.id])

    await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id })

    expect(sendEmail).toHaveBeenCalledTimes(2)
    const recipients = sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to)
    expect(recipients).toContain(userA.email)
    expect(recipients).toContain(userB.email)
  })

  test('replaces {{name}} token in subject', async () => {
    const rule = await createRule()
    const user = await createUser('token')
    await createSubscription(rule.id, [user.id])

    await runProcessTask({ contextData: { name: 'Alice' }, ruleId: rule.id })

    const call = sendEmail.mock.calls[0][0] as { subject: string }
    expect(call.subject).toBe('Hello Alice')
  })

  test('marks event sent when all subscriptions are immediate', async () => {
    const rule = await createRule()
    const user = await createUser('sent')
    await createSubscription(rule.id, [user.id])

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('sent')
  })

  test('marks event pending when a digest subscription also exists', async () => {
    const rule = await createRule()
    const userA = await createUser('mixed-imm')
    const userB = await createUser('mixed-dig')
    await createSubscription(rule.id, [userA.id], { schedule: 'immediate' })
    await createSubscription(rule.id, [userB.id], { schedule: 'daily' })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('pending')
  })
})

// ─── processNotificationEvent — digest subscription ──────────────────────────

describe('processNotificationEvent — digest subscription', () => {
  test('does not call sendEmail and leaves event pending for daily subscription', async () => {
    const rule = await createRule()
    const user = await createUser('daily')
    await createSubscription(rule.id, [user.id], { schedule: 'daily' })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    expect(sendEmail).not.toHaveBeenCalled()
    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('pending')
  })
})

// ─── processNotificationEvent — webhook channel ──────────────────────────────

describe('processNotificationEvent — webhook channel', () => {
  test('fires webhook once per subscription', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const rule = await createRule()
    const user = await createUser('wh')
    await createSubscription(rule.id, [user.id], {
      channels: ['webhook'],
      webhookUrl: 'https://example.com/hook',
    })

    await runProcessTask({ contextData: {}, ruleId: rule.id })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('marks event failed when webhook-only subscription fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

    const rule = await createRule()
    const user = await createUser('wh-fail')
    await createSubscription(rule.id, [user.id], {
      channels: ['webhook'],
      webhookUrl: 'https://example.com/hook',
    })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('failed')
  })

  test('marks event sent when webhook fails but email channel also configured and succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

    const rule = await createRule()
    const user = await createUser('wh-fail-email-ok')
    await createSubscription(rule.id, [user.id], {
      channels: ['webhook', 'email'],
      webhookUrl: 'https://example.com/hook',
    })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const event = await payload.findByID({
      id: result.output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('sent')
  })
})

// ─── processNotificationEvent — in-app inbox channel ─────────────────────────

describe('processNotificationEvent — in-app inbox channel', () => {
  test('creates one inbox record per user when in_app channel fires', async () => {
    const rule = await createRule()
    const userA = await createUser('inbox-a')
    const userB = await createUser('inbox-b')
    await createSubscription(rule.id, [userA.id, userB.id], {
      channels: ['email', 'in_app'],
    })

    const result = await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id })

    const { docs: inbox } = await payload.find({
      collection: 'notification-inbox',
      overrideAccess: true,
      where: { event: { equals: result.output.eventId } },
    })
    expect(inbox).toHaveLength(2)
    const inboxUserIds = inbox.map((r) =>
      String(typeof r.user === 'object' ? (r.user as { id: number | string }).id : r.user),
    )
    expect(inboxUserIds).toContain(String(userA.id))
    expect(inboxUserIds).toContain(String(userB.id))
  })

  test('inbox record is marked unread on creation', async () => {
    const rule = await createRule()
    const user = await createUser('inbox-unread')
    await createSubscription(rule.id, [user.id], { channels: ['in_app'] })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    const { docs: inbox } = await payload.find({
      collection: 'notification-inbox',
      overrideAccess: true,
      where: { event: { equals: result.output.eventId } },
    })
    expect(inbox[0]).toBeDefined()
    expect((inbox[0] as { read?: boolean }).read).toBe(false)
  })

  test('readAt is stamped when read is toggled on', async () => {
    const rule = await createRule()
    const user = await createUser('inbox-read')
    await createSubscription(rule.id, [user.id], { channels: ['in_app'] })

    const result = await runProcessTask({ contextData: {}, ruleId: rule.id })

    const { docs: inbox } = await payload.find({
      collection: 'notification-inbox',
      overrideAccess: true,
      where: { event: { equals: result.output.eventId } },
    })
    const record = inbox[0] as { id: string; read?: boolean; readAt?: string }
    expect(record).toBeDefined()

    const updated = await payload.update({
      id: record.id,
      collection: 'notification-inbox',
      data: { read: true },
      overrideAccess: true,
    })
    expect((updated as { readAt?: string }).readAt).toBeTruthy()
  })
})

// ─── processNotificationEvent — idempotency ──────────────────────────────────

describe('processNotificationEvent — idempotency', () => {
  test('a retry with the same job id reuses the event and does not re-send', async () => {
    const rule = await createRule({ name: 'Idempotent Rule' })
    const user = await createUser('idem')
    await createSubscription(rule.id, [user.id], { channels: ['email'] })

    const jobId = `job-${_counter}-${Date.now()}`
    const first = await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id }, jobId)
    const second = await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id }, jobId)

    // Same event reused, email sent once.
    expect(second.output.eventId).toBe(first.output.eventId)
    expect(sendEmail).toHaveBeenCalledTimes(1)

    const { totalDocs } = await payload.find({
      collection: 'notification-events',
      overrideAccess: true,
      where: { dedupeKey: { equals: `pne:${jobId}` } },
    })
    expect(totalDocs).toBe(1)
  })

  test('different job ids create distinct events', async () => {
    const rule = await createRule({ name: 'Distinct Jobs Rule' })
    const user = await createUser('distinct')
    await createSubscription(rule.id, [user.id], { channels: ['email'] })

    const a = await runProcessTask({ contextData: {}, ruleId: rule.id }, `job-a-${Date.now()}`)
    const b = await runProcessTask({ contextData: {}, ruleId: rule.id }, `job-b-${Date.now()}`)

    expect(a.output.eventId).not.toBe(b.output.eventId)
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })
})

// ─── sendNotificationDigest ──────────────────────────────────────────────────

describe('sendNotificationDigest', () => {
  beforeEach(async () => {
    await resetNotifications()
  })

  test('delivers a daily email digest and marks the event sent exactly once', async () => {
    const rule = await createRule({ name: 'Digest Rule' })
    const user = await createUser('digest-email')
    await createSubscription(rule.id, [user.id], { channels: ['email'], schedule: 'daily' })

    const { output } = await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id })
    expect(sendEmail).not.toHaveBeenCalled() // digest defers delivery

    const result = await runDigestTask('daily')

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(result.output.processed).toBe('1')

    const event = await payload.findByID({
      id: output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('sent')
  })

  test('does not double-count when a subscription has multiple channels', async () => {
    const rule = await createRule({ name: 'Digest Multi-Channel' })
    const user = await createUser('digest-multi')
    await createSubscription(rule.id, [user.id], {
      channels: ['email', 'in_app'],
      schedule: 'daily',
    })

    await runProcessTask({ contextData: {}, ruleId: rule.id })
    const result = await runDigestTask('daily')

    // One event delivered, counted once regardless of channel count.
    expect(result.output.processed).toBe('1')
  })

  test('creates an in-app inbox digest record (regression: event field optional)', async () => {
    const rule = await createRule({ name: 'Inbox Digest Rule' })
    const user = await createUser('digest-inbox')
    await createSubscription(rule.id, [user.id], { channels: ['in_app'], schedule: 'daily' })

    await runProcessTask({ contextData: { name: 'World' }, ruleId: rule.id })

    const before = await payload.find({
      collection: 'notification-inbox',
      overrideAccess: true,
      where: { user: { equals: user.id } },
    })

    const result = await runDigestTask('daily')
    expect(result.output.processed).toBe('1')

    const after = await payload.find({
      collection: 'notification-inbox',
      overrideAccess: true,
      where: { user: { equals: user.id } },
    })
    expect(after.totalDocs).toBe(before.totalDocs + 1)
  })

  test('leaves events pending when no subscription matches the schedule', async () => {
    const rule = await createRule({ name: 'Weekly-only Rule' })
    const user = await createUser('digest-weekly')
    await createSubscription(rule.id, [user.id], { channels: ['email'], schedule: 'weekly' })

    const { output } = await runProcessTask({ contextData: {}, ruleId: rule.id })

    // A daily run must not touch a weekly subscriber's pending event.
    const result = await runDigestTask('daily')
    expect(result.output.processed).toBe('0')

    const event = await payload.findByID({
      id: output.eventId,
      collection: 'notification-events',
      overrideAccess: true,
    })
    expect((event as { status?: string }).status).toBe('pending')
  })
})
