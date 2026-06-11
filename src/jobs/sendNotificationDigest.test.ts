import type { Mock } from 'vitest'

import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { ChannelDefinition } from '../types.js'

import { renderNotification } from '../utils/renderNotification.js'
import { makeSendNotificationDigestTask } from './sendNotificationDigest.js'

vi.mock('../utils/renderNotification.js', () => ({ renderNotification: vi.fn() }))
const renderMock = renderNotification as unknown as Mock

const EVENTS = 'notification-events'
const SUBS = 'notification-subscriptions'

type FakeOptions = {
  events?: Record<string, unknown>[]
  subscriptions?: Record<string, unknown>[]
}

function createPayload(opts: FakeOptions = {}) {
  const update = vi.fn().mockResolvedValue({})
  const find = vi.fn(({ collection }: { collection: string }) => {
    if (collection === EVENTS) {
      return { docs: opts.events ?? [] }
    }
    if (collection === SUBS) {
      return { docs: opts.subscriptions ?? [] }
    }
    return { docs: [] }
  })
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  return { find, logger, update }
}

function run(
  payload: ReturnType<typeof createPayload>,
  channels: ChannelDefinition[],
  schedule: unknown = 'daily',
) {
  const task = makeSendNotificationDigestTask(channels, {})
  return (task.handler as (args: unknown) => Promise<{ output: { processed: string } }>)({
    input: { schedule },
    req: { payload } as never,
  })
}

function makeChannel(
  value: string,
  digestHandler?: Mock,
  handler = vi.fn().mockResolvedValue(undefined),
): ChannelDefinition {
  return { digestHandler, handler, label: value, value }
}

// An event whose `rule` is an embedded object (depth: 1) so renderItem renders it.
function makeEvent(id: string, ruleId: string) {
  return {
    id,
    contextData: {},
    rule: { id: ruleId, subject: 'S' },
    trigger: 'posts.created',
  }
}

beforeEach(() => {
  renderMock.mockReset()
  renderMock.mockResolvedValue({ html: '<p>x</p>', renderFailed: false, subject: 'S', text: 'x' })
})

describe('sendNotificationDigest — guards', () => {
  test('warns and processes nothing on an unrecognised schedule', async () => {
    const payload = createPayload()
    const res = await run(payload, [], 'hourly')

    expect(res.output.processed).toBe('0')
    expect(payload.logger.warn).toHaveBeenCalled()
    expect(payload.find).not.toHaveBeenCalled()
  })

  test('processes nothing when there are no pending events', async () => {
    const payload = createPayload({ events: [] })
    const res = await run(payload, [makeChannel('inbox')])

    expect(res.output.processed).toBe('0')
  })

  test('processes nothing when no subscription matches the pending events', async () => {
    const payload = createPayload({ events: [makeEvent('e1', 'rule1')], subscriptions: [] })
    const res = await run(payload, [makeChannel('inbox')])

    expect(res.output.processed).toBe('0')
    expect(payload.update).not.toHaveBeenCalled()
  })
})

describe('sendNotificationDigest — delivery', () => {
  test('batches matching events into a single digestHandler call and marks them sent', async () => {
    const digestHandler = vi.fn().mockResolvedValue(undefined)
    const channel = makeChannel('inbox', digestHandler)
    const payload = createPayload({
      events: [makeEvent('e1', 'rule1'), makeEvent('e2', 'rule1')],
      subscriptions: [{ channels: ['inbox'], rule: { id: 'rule1' }, schedule: 'daily' }],
    })

    const res = await run(payload, [channel])

    expect(digestHandler).toHaveBeenCalledTimes(1)
    expect(digestHandler.mock.calls[0][0].items).toHaveLength(2)
    expect(res.output.processed).toBe('2')
    // Both events finalised as 'sent'.
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    )
  })

  test('falls back to the per-event handler when the channel has no digestHandler', async () => {
    const channel = makeChannel('inbox')
    const payload = createPayload({
      events: [makeEvent('e1', 'rule1'), makeEvent('e2', 'rule1')],
      subscriptions: [{ channels: ['inbox'], rule: { id: 'rule1' }, schedule: 'daily' }],
    })

    const res = await run(payload, [channel])

    expect(channel.handler).toHaveBeenCalledTimes(2)
    expect(res.output.processed).toBe('2')
  })

  test('marks events failed when the digestHandler throws', async () => {
    const digestHandler = vi.fn().mockRejectedValue(new Error('down'))
    const channel = makeChannel('inbox', digestHandler)
    const payload = createPayload({
      events: [makeEvent('e1', 'rule1')],
      subscriptions: [{ channels: ['inbox'], rule: { id: 'rule1' }, schedule: 'daily' }],
    })

    const res = await run(payload, [channel])

    expect(payload.logger.error).toHaveBeenCalled()
    expect(res.output.processed).toBe('0')
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })

  test('marks an event failed when it cannot be rendered', async () => {
    renderMock.mockResolvedValue({ html: '', renderFailed: true, subject: '', text: '' })
    const digestHandler = vi.fn().mockResolvedValue(undefined)
    const channel = makeChannel('inbox', digestHandler)
    const payload = createPayload({
      events: [makeEvent('e1', 'rule1')],
      subscriptions: [{ channels: ['inbox'], rule: { id: 'rule1' }, schedule: 'daily' }],
    })

    const res = await run(payload, [channel])

    expect(digestHandler).not.toHaveBeenCalled()
    expect(res.output.processed).toBe('0')
  })
})
