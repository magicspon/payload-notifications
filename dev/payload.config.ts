import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { makeEmailChannel, makeInboxChannel, makeTriggers, makeWebhookChannel, notificationsPlugin } from '@spon/payload-notifications'
import path from 'path'
import { buildConfig } from 'payload'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

export default buildConfig({
  admin: {
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'status', type: 'text' },
      ],
    },
    {
      slug: 'media',
      fields: [],
      upload: {
        staticDir: path.resolve(dirname, 'media'),
      },
    },
  ],
  db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL ?? 'file:./dev.db',
    },
  }),
  editor: lexicalEditor(),
  email: testEmailAdapter,
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    notificationsPlugin({
      channels: [
        makeEmailChannel(({ subject, to }) => {
          // In dev, log emails to the Payload logger via onInit instead of sending
          void Promise.resolve(`email → ${to}: ${subject}`)
          return Promise.resolve()
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
  secret: process.env.PAYLOAD_SECRET || 'test-secret_key',
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
