import type { Mock } from 'vitest'

import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { ChannelDefinition } from '../types.js'

import { renderNotification } from '../utils/renderNotification.js'
import { makeProcessNotificationEventTask } from './processNotificationEvent.js'

vi.mock('../utils/renderNotification.js', () => ({ renderNotification: vi.fn() }))
const renderMock = renderNotification as unknown as Mock

const EVENTS = 'notification-events'
const SUBS = 'notification-subscriptions'

type FakeOptions = {
  existingEvents?: Record<string, unknown>[]
  rule?: null | Record<string, unknown>
  subscriptions?: Record<string, unknown>[]
}

function createPayload(opts: FakeOptions = {}) {
  const create = vi.fn().mockResolvedValue({ id: 'evt-created' })
  const update = vi.fn().mockResolvedValue({})
  const findByID = vi.fn().mockResolvedValue(opts.rule ?? null)
  const find = vi.fn(({ collection }: { collection: string }) => {
    if (collection === EVENTS) {
      return { docs: opts.existingEvents ?? [] }
    }
    if (collection === SUBS) {
      return { docs: opts.subscriptions ?? [] }
    }
    return { docs: [] }
  })
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  return { create, find, findByID, logger, update }
}

function run(
  payload: ReturnType<typeof createPayload>,
  channels: ChannelDefinition[],
  input: Record<string, unknown> = { contextData: {}, ruleId: 'rule1' },
  job: unknown = { id: 'job1' },
) {
  const task = makeProcessNotificationEventTask(channels, {})
  return (task.handler as (args: unknown) => Promise<{ output: { eventId: string } }>)({
    input,
    job,
    req: { payload } as never,
  })
}

function makeChannel(value: string, handler = vi.fn().mockResolvedValue(undefined)): ChannelDefinition {
  return { handler, label: value, value }
}

const activeRule = { active: true, message: null, subject: 'Hi', trigger: 'posts.created' }

beforeEach(() => {
  renderMock.mockReset()
  renderMock.mockResolvedValue({ html: '<p>x</p>', renderFailed: false, subject: 'Hi', text: 'x' })
})

describe('processNotificationEvent — guards', () => {
  test('returns empty eventId and creates nothing when the rule is missing', async () => {
    const payload = createPayload({ rule: null })
    const res = await run(payload, [makeChannel('inbox')])

    expect(res.output.eventId).toBe('')
    expect(payload.create).not.toHaveBeenCalled()
  })

  test('returns empty eventId when the rule is inactive', async () => {
    const payload = createPayload({ rule: { ...activeRule, active: false } })
    const res = await run(payload, [makeChannel('inbox')])

    expect(res.output.eventId).toBe('')
    expect(payload.create).not.toHaveBeenCalled()
  })
})

describe('processNotificationEvent — immediate delivery', () => {
  test('delivers to a matching channel and settles the event as sent', async () => {
    const channel = makeChannel('inbox')
    const payload = createPayload({
      rule: activeRule,
      subscriptions: [{ channels: ['inbox'], schedule: 'immediate' }],
    })

    await run(payload, [channel])

    // Claims delivery before sending, then settles 'sent'.
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deliveredImmediate: true } }),
    )
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    )
    expect(channel.handler).toHaveBeenCalledTimes(1)
  })

  test('settles failed when the only channel handler throws', async () => {
    const channel = makeChannel('inbox', vi.fn().mockRejectedValue(new Error('boom')))
    const payload = createPayload({
      rule: activeRule,
      subscriptions: [{ channels: ['inbox'], schedule: 'immediate' }],
    })

    await run(payload, [channel])

    expect(payload.logger.error).toHaveBeenCalled()
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })

  test('settles failed and skips delivery when rendering fails', async () => {
    renderMock.mockResolvedValue({ html: '', renderFailed: true, subject: '', text: '' })
    const channel = makeChannel('inbox')
    const payload = createPayload({
      rule: activeRule,
      subscriptions: [{ channels: ['inbox'], schedule: 'immediate' }],
    })

    await run(payload, [channel])

    expect(channel.handler).not.toHaveBeenCalled()
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })
})

describe('processNotificationEvent — idempotency & digest', () => {
  test('reuses an existing event and never re-sends after a prior delivery', async () => {
    const channel = makeChannel('inbox')
    const payload = createPayload({
      existingEvents: [{ id: 'evt-old', deliveredImmediate: true }],
      rule: activeRule,
      subscriptions: [{ channels: ['inbox'], schedule: 'immediate' }],
    })

    const res = await run(payload, [channel])

    expect(res.output.eventId).toBe('evt-old')
    expect(payload.create).not.toHaveBeenCalled()
    expect(channel.handler).not.toHaveBeenCalled()
  })

  test('leaves the event pending when only digest subscriptions exist', async () => {
    const channel = makeChannel('inbox')
    const payload = createPayload({
      rule: activeRule,
      subscriptions: [{ channels: ['inbox'], schedule: 'daily' }],
    })

    await run(payload, [channel])

    expect(channel.handler).not.toHaveBeenCalled()
    // No status update — the digest run finalises it.
    expect(payload.update).not.toHaveBeenCalled()
  })

  test('keeps the event pending after immediate delivery when a digest sub also exists', async () => {
    const channel = makeChannel('inbox')
    const payload = createPayload({
      rule: activeRule,
      subscriptions: [
        { channels: ['inbox'], schedule: 'immediate' },
        { channels: ['inbox'], schedule: 'weekly' },
      ],
    })

    await run(payload, [channel])

    expect(channel.handler).toHaveBeenCalledTimes(1)
    // Claimed delivery, but never settled status — left pending for the digest.
    expect(payload.update).toHaveBeenCalledTimes(1)
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deliveredImmediate: true } }),
    )
  })
})
