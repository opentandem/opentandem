import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServerClient, OpenTandemError } from '../src/server/index.js'

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeServer(handler) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    return handler(call, calls)
  }
  return { fetch, calls }
}
const tokenReply = (token = 't1', ttlMs = 2 * 3600_000) => json(200, { access_token: token, token_type: 'Bearer', expires_at: new Date(Date.now() + ttlMs).toISOString() })
const make = fetch => createServerClient({ baseUrl: 'https://ot.example/', appId: 'ota_x', secret: 'ots_y', fetch })

test('exchanges a token once and reuses it; sends Bearer, puts space in the body, path is /api/open/<group>/<action>', async () => {
  const { fetch, calls } = fakeServer(c => c.url.endsWith('/token') ? tokenReply() : json(200, { ok: true }))
  const ot = make(fetch)
  await ot.sessions.list({ days: 3 }, { space: 's1' })
  await ot.sessions.list({ limit: 5 }, { space: 's1' })
  assert.equal(calls.filter(c => c.url.endsWith('/api/open/token')).length, 1)
  assert.deepEqual(calls[0].body, { app_id: 'ota_x', secret: 'ots_y' })
  assert.equal(calls[1].url, 'https://ot.example/api/open/sessions/list')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].headers.Authorization, 'Bearer t1')
  assert.deepEqual(calls[1].body, { days: 3, space: 's1' })
})

test('concurrent calls exchange only one token', async () => {
  const { fetch, calls } = fakeServer(c => c.url.endsWith('/token') ? tokenReply() : json(200, {}))
  const ot = make(fetch)
  await Promise.all([ot.sessions.list({}, { space: 's' }), ot.projects.list({}, { space: 's' }), ot.machines.list({}, { space: 's' })])
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1)
})

test('renews the token within 5 minutes of expiry', async () => {
  let n = 0
  const { fetch, calls } = fakeServer(c => c.url.endsWith('/token') ? tokenReply(`t${++n}`, 4 * 60_000) : json(200, {}))
  const ot = make(fetch)
  await ot.sessions.list({}, { space: 's' })
  await ot.sessions.list({}, { space: 's' })
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 2)
})

test('when the server rejects the token (e.g. the secret was reset), gets a new token and retries once, then throws', async () => {
  let n = 0
  const { fetch, calls } = fakeServer(c => {
    if (c.url.endsWith('/token')) return tokenReply(`t${++n}`)
    return c.headers.Authorization === 'Bearer t1' ? json(401, { error: 'invalid_token' }) : json(200, { ok: 1 })
  })
  const ot = make(fetch)
  assert.deepEqual(await ot.sessions.list({}, { space: 's' }), { ok: 1 })
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 2)

  const always = fakeServer(c => c.url.endsWith('/token') ? tokenReply() : json(401, { error: 'invalid_token' }))
  await assert.rejects(() => make(always.fetch).sessions.list({}, { space: 's' }), e => e instanceof OpenTandemError && e.code === 'invalid_token' && e.status === 401)
  assert.equal(always.calls.filter(c => !c.url.endsWith('/token')).length, 2)
})

test('errors are normalized to OpenTandemError (code, message, status)', async () => {
  const { fetch } = fakeServer(c => c.url.endsWith('/token') ? tokenReply() : json(403, { error: 'scope_not_granted', message: 'no' }))
  await assert.rejects(() => make(fetch).messages.send({ session_id: 'x', content: 'y' }, { space: 's' }),
    e => e instanceof OpenTandemError && e.code === 'scope_not_granted' && e.message === 'no' && e.status === 403)
  const bad = fakeServer(() => json(401, { error: 'invalid_credentials' }))
  await assert.rejects(() => make(bad.fetch).spaces(), e => e.code === 'invalid_credentials')
})

test('a missing space or unknown capability is rejected locally without a request', async () => {
  const { fetch, calls } = fakeServer(() => json(200, {}))
  const ot = make(fetch)
  await assert.rejects(() => ot.sessions.list({}), e => e.code === 'space_required')
  await assert.rejects(() => ot.call('nope.nope', {}, { space: 's' }), e => e.code === 'unknown_capability')
  assert.equal(calls.length, 0)
})

test('spaces() pages by offset; every capability has a matching method', async () => {
  const { fetch, calls } = fakeServer(c => c.url.endsWith('/token') ? tokenReply() : json(200, { spaces: [] }))
  const ot = make(fetch)
  await ot.spaces({ offset: 20 })
  assert.equal(calls.at(-1).url, 'https://ot.example/api/open/spaces?offset=20')
  assert.equal(calls.at(-1).method, 'GET')
  for (const [g, a] of [['projects', 'list'], ['sessions', 'list'], ['sessions', 'info'], ['messages', 'list'], ['messages', 'send'], ['machines', 'list'], ['machines', 'info'], ['schedules', 'list'], ['schedules', 'info']]) {
    assert.equal(typeof ot[g][a], 'function', `${g}.${a}`)
  }
})
