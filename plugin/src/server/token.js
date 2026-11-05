// App ID + secret → access token, cached and renewed before it expires (tokens last 2 hours).
import { OpenTandemError } from './errors.js'

const RENEW_BEFORE_MS = 5 * 60_000

/**
 * @param {{ baseUrl: string, appId: string, secret: string, fetch?: typeof fetch }} opts
 */
export function createTokenSource({ baseUrl, appId, secret, fetch: doFetch = globalThis.fetch }) {
  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null
  /** @type {Promise<string> | null} */
  let inflight = null

  async function fetchToken() {
    const res = await doFetch(`${baseUrl}/api/open/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, secret }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new OpenTandemError(body.error || `http_${res.status}`, body.message, res.status)
    cached = { token: body.access_token, expiresAt: Date.parse(body.expires_at) }
    return cached.token
  }

  return {
    async get() {
      if (cached && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.token
      inflight ??= fetchToken().finally(() => { inflight = null })
      return inflight
    },
    /** Drop the cached token, e.g. after the secret was reset. */
    clear() { cached = null },
  }
}
