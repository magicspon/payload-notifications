// fallow-ignore-file security-sink
// The two fetch() calls below post to operator/subscriber-configured webhook
// URLs — that is the channel's entire purpose. Both destinations are routed
// through resolveUrl(), which rejects non-http(s) schemes and (unless
// allowPrivateHosts is set) private/localhost/link-local hosts via isPrivateHost
// as SSRF defence-in-depth. Reviewed: the non-literal-URL candidates are
// intended behaviour, not an unguarded sink.
import type { ChannelDefinition } from '../types.js'

export type WebhookChannelOptions = {
  /**
   * Allow webhook URLs that resolve to localhost / private network ranges.
   * Defaults to `false` as a defence-in-depth measure against SSRF. Enable only
   * when you intentionally deliver to internal services.
   */
  allowPrivateHosts?: boolean
  /** Request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number
}

/**
 * Built-in webhook channel. Fires one POST request per subscription regardless
 * of user count. Validates the URL, rejects non-HTTP(S) and (by default)
 * private/localhost hosts, and applies an abort timeout.
 *
 * For digest delivery, all rendered items are posted in a single request body.
 */
export function makeWebhookChannel(options: WebhookChannelOptions = {}): ChannelDefinition {
  const { allowPrivateHosts = false, timeoutMs = 10_000 } = options

  return {
    fields: [
      {
        name: 'webhookUrl',
        type: 'text',
        admin: {
          condition: (data) =>
            Array.isArray(data['channels']) && data['channels'].includes('webhook'),
          description: 'URL to POST notification payloads to',
        },
      },
    ],
    label: 'Webhook',
    value: 'webhook',

    handler: async ({ event, rendered, subscription }) => {
      const url = resolveUrl(subscription, allowPrivateHosts)
      if (!url) {return}

      const res = await fetch(url.toString(), {
        body: JSON.stringify({
          event,
          html: rendered.html,
          subject: rendered.subject,
          text: rendered.text,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        throw new Error(`Webhook delivery failed with status ${res.status}`)
      }
    },

    digestHandler: async ({ items, schedule, subscription }) => {
      const url = resolveUrl(subscription, allowPrivateHosts)
      if (!url) {return}

      const res = await fetch(url.toString(), {
        body: JSON.stringify({ items, schedule }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        throw new Error(`Webhook digest delivery failed with status ${res.status}`)
      }
    },
  }
}

function resolveUrl(
  subscription: Record<string, unknown>,
  allowPrivateHosts: boolean,
): null | URL {
  const raw = subscription['webhookUrl']
  if (typeof raw !== 'string' || !raw) {return null}

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid webhook URL: ${raw}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Webhook URL must use http(s): ${raw}`)
  }

  if (!allowPrivateHosts && isPrivateHost(url.hostname)) {
    throw new Error(`Webhook URL points to a private or local host: ${url.hostname}`)
  }

  return url
}

/**
 * Best-effort check for localhost / private / link-local / reserved hosts.
 * This is defence-in-depth, not a full SSRF guard — it cannot catch hostnames
 * that resolve to private IPs via DNS.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true
  }

  // IPv6 loopback / link-local / unique-local
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number)
    if (a === 10) {return true}
    if (a === 127) {return true}
    if (a === 169 && b === 254) {return true}
    if (a === 172 && b >= 16 && b <= 31) {return true}
    if (a === 192 && b === 168) {return true}
  }

  return false
}
