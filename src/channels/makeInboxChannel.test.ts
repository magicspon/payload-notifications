import type { PayloadRequest } from 'payload'

import { describe, expect, test, vi } from 'vitest'

import type { ResolvedSlugs } from '../types.js'

import { makeInboxChannel } from './makeInboxChannel.js'

const slugs: ResolvedSlugs = {
  events: 'notification-events',
  inbox: 'custom-inbox',
  rules: 'notification-rules',
  subscriptions: 'notification-subscriptions',
}

function makeReq(create: ReturnType<typeof vi.fn>): PayloadRequest {
  return { payload: { create } } as unknown as PayloadRequest
}

describe('makeInboxChannel — slug resolution', () => {
  test('writes to the resolved inbox slug from injected slugs', async () => {
    const create = vi.fn().mockResolvedValue({})
    const channel = makeInboxChannel()

    await channel.handler({
      event: { id: '1', contextData: {}, trigger: 'posts.created' },
      rendered: { html: '<p>hi</p>', subject: 'Subject', text: 'hi' },
      req: makeReq(create),
      slugs,
      subscription: { users: [{ id: 7, email: 'a@test.example' }] },
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ collection: 'custom-inbox' }))
  })

  test('explicit override slug takes precedence over injected slugs', async () => {
    const create = vi.fn().mockResolvedValue({})
    const channel = makeInboxChannel('override-inbox')

    await channel.digestHandler!({
      items: [{ contextData: {}, html: '', subject: 'S', text: 'T', trigger: 'posts.created' }],
      req: makeReq(create),
      schedule: 'daily',
      slugs,
      subscription: { users: [{ id: 7, email: 'a@test.example' }] },
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ collection: 'override-inbox' }))
  })
})
