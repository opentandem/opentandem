import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, OpenTandemError } from '../src/client/index.js'

// A fake console: `host` is the parent window, `page` is the iframe's window.
function pair(onPost) {
  const listeners = []
  const host = { postMessage: (msg, origin) => onPost(msg, origin, deliver) }
  const page = { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn) } }
  const deliver = (data, source = host) => listeners.forEach(fn => fn({ source, data }))
  return { host, page, deliver }
}

test('sends ready on start; ot.context resolves once the host replies with context', async () => {
  const { host, page, deliver } = pair(msg => { if (msg.type === 'ready') queueMicrotask(() => deliver({ opentandem: 1, type: 'context', locale: 'zh', app: { id: 'a', name: 'A' } })) })
  const ot = createClient({ target: host, self: page })
  assert.deepEqual(await ot.context, { locale: 'zh', app: { id: 'a', name: 'A' } })
})

test('a call sends the capability name and params to the host and matches the result by id', async () => {
  const sent = []
  const { host, page } = pair((msg, origin, deliver) => {
    sent.push(msg)
    if (msg.type === 'call') queueMicrotask(() => deliver({ opentandem: 1, type: 'result', id: msg.id, ok: true, data: { echo: msg.params } }))
  })
  const ot = createClient({ target: host, self: page })
  assert.deepEqual(await ot.sessions.list({ days: 3 }), { echo: { days: 3 } })
  const call = sent.find(m => m.type === 'call')
  assert.equal(call.capability, 'sessions.list')
  assert.equal(call.opentandem, 1)
})

test('concurrent calls do not mix up results', async () => {
  const pending = []
  const { host, page, deliver } = pair(msg => { if (msg.type === 'call') pending.push(msg) })
  const ot = createClient({ target: host, self: page })
  const a = ot.sessions.list({ limit: 1 }); const b = ot.machines.list({})
  deliver({ opentandem: 1, type: 'result', id: pending[1].id, ok: true, data: 'B' })
  deliver({ opentandem: 1, type: 'result', id: pending[0].id, ok: true, data: 'A' })
  assert.equal(await a, 'A'); assert.equal(await b, 'B')
})

test('a failed result becomes OpenTandemError; a member declining a write is user_denied', async () => {
  const { host, page } = pair((msg, o, deliver) => {
    if (msg.type === 'call') queueMicrotask(() => deliver({ opentandem: 1, type: 'result', id: msg.id, ok: false, error: msg.capability === 'messages.send' ? 'user_denied' : 'scope_not_granted' }))
  })
  const ot = createClient({ target: host, self: page })
  await assert.rejects(() => ot.messages.send({ session_id: 's', content: 'x' }), e => e instanceof OpenTandemError && e.code === 'user_denied')
  await assert.rejects(() => ot.sessions.list({}), e => e.code === 'scope_not_granted')
})

test('only trusts messages from the host window: other sources, unmarked messages and unknown ids are ignored', async () => {
  const pending = []
  const { host, page, deliver } = pair(msg => { if (msg.type === 'call') pending.push(msg) })
  const ot = createClient({ target: host, self: page })
  let settled = false
  const p = ot.sessions.list({}).then(v => { settled = true; return v })
  const id = pending[0].id
  deliver({ opentandem: 1, type: 'result', id, ok: true, data: 'EVIL' }, { other: 'window' })
  deliver({ type: 'result', id, ok: true, data: 'EVIL' })
  deliver({ opentandem: 1, type: 'result', id: 'unknown', ok: true, data: 'EVIL' })
  deliver({ opentandem: 1, type: 'context', locale: 'en', app: {} }, { other: 'window' })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(settled, false)
  deliver({ opentandem: 1, type: 'result', id, ok: true, data: 'OK' })
  assert.equal(await p, 'OK')
})
