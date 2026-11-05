// For your own server (Node 18+ or any runtime with fetch). Keep the secret on the server only.
//
//   import { createServerClient } from '@opentandem/plugin/server'
//   const ot = createServerClient({ baseUrl: 'https://opentandem.org', appId: 'ota_…', secret: process.env.OPENTANDEM_APP_SECRET })
//   const { spaces } = await ot.spaces()
//   const usage = await ot.sessions.list({ days: 7 }, { space: spaces[0].id })
//
// Calls act as the workspace admin who authorized the app, as they are now: if they leave the
// workspace or stop being an admin, calls fail with grant_inactive until an admin authorizes again.
import { CAPABILITIES, CAPABILITY_NAMES } from '../capabilities/index.js'
import { OpenTandemError } from './errors.js'
import { createTokenSource } from './token.js'

/**
 * @param {{ baseUrl: string, appId: string, secret: string, fetch?: typeof fetch }} opts
 */
export function createServerClient(opts) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? globalThis.fetch
  const tokens = createTokenSource({ ...opts, baseUrl, fetch: doFetch })

  async function request(path, init = {}, retried = false) {
    const token = await tokens.get()
    const res = await doFetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
    const body = await res.json().catch(() => ({}))
    // A token can stop working early (secret reset); fetch a new one once.
    if (res.status === 401 && body.error === 'invalid_token' && !retried) { tokens.clear(); return request(path, init, true) }
    if (!res.ok) throw new OpenTandemError(body.error || `http_${res.status}`, body.message, res.status)
    return body
  }

  /**
   * @param {string} name  e.g. 'sessions.list'
   * @param {Record<string, unknown>} [params]
   * @param {{ space: string }} where  The workspace to act in (see spaces()).
   */
  function call(name, params = {}, where) {
    if (!CAPABILITY_NAMES.includes(name)) return Promise.reject(new OpenTandemError('unknown_capability'))
    if (!where?.space) return Promise.reject(new OpenTandemError('space_required'))
    const [group, action] = name.split('.')
    return request(`/api/open/${group}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, space: where.space }),
    })
  }

  /** @type {Record<string, Record<string, (params?: Record<string, unknown>, where?: { space: string }) => Promise<unknown>>>} */
  const groups = {}
  for (const { name } of CAPABILITIES) {
    const [group, action] = name.split('.')
    ;(groups[group] ??= {})[action] = (params, where) => call(name, params, where)
  }

  return {
    call,
    ...groups,
    /** Workspaces that authorized this app, 20 per page. */
    spaces: ({ offset = 0 } = {}) => request(`/api/open/spaces?offset=${encodeURIComponent(offset)}`),
  }
}

export { CAPABILITIES, OpenTandemError }
