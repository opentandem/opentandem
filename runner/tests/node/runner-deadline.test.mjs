import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { readAdapter, readRunnerSource } from '../fixtures/runner-sources.mjs'
// withDeadline lives in the adapters' shared utilities (runner/core/agent-kit/kit.mjs) and is used by both the core and the adapters;
// the wait points are spread across the core and the adapters, so labels are searched in both.
const kit = readAdapter('kit')
const source = readRunnerSource()
const start = kit.indexOf('export function withDeadline(')
const section = kit.slice(start, kit.indexOf('\n}\n', start) + 2).replace(/^export /, '')
const logs = []
const withDeadline = vm.runInNewContext(section + '\nwithDeadline', {
  setTimeout, clearTimeout, Promise, console: { error: m => logs.push(m) },
})
const never = () => new Promise(() => {})

test('a wait that never settles falls back after the deadline', async () => {
  assert.equal(await withDeadline(never(), 50, 'quota collection', 'last good'), 'last good')
  assert.equal(await withDeadline(never(), 50, 'model catalog', () => 'cached'), 'cached')
  assert.equal(await withDeadline(never(), 50, 'heartbeat response', null), null)
  assert.ok(logs.some(m => m.includes('quota collection stalled')))
})

test('without a fallback the deadline rejects so the caller takes its error path', async () => {
  await assert.rejects(withDeadline(never(), 50, 'outbox delivery'), /outbox delivery timed out/)
})

test('a wait that finishes in time is returned untouched, including its own error', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'x', 0), 7)
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1000, 'x', 0), /boom/)
})

test('one stuck item does not hold back the others in the same inventory', async () => {
  const t0 = Date.now()
  const [runtimes, quotas] = await Promise.all([
    withDeadline(never(), 80, 'runtime inventory', () => ['cached runtimes']),
    withDeadline(Promise.resolve(['fresh quota']), 80, 'quota collection', null),
  ])
  assert.deepEqual(runtimes, ['cached runtimes'])
  assert.deepEqual(quotas, ['fresh quota'])
  assert.ok(Date.now() - t0 < 1000)
})

test('every loop that used to freeze on one wait now has a deadline', () => {
  for (const label of [
    "'system metrics'", "'runtime inventory'", "'model catalog'", "'quota collection'",
    "'heartbeat'", "'heartbeat response'", "'outbox delivery'", "'command poll'",
    '`command ${cmd.type}`', "'command reply'", "'self-update download'",
    "'closing Codex sessions'", "'OpenCode inventory'",
  ]) assert.ok(source.includes(label), `missing deadline: ${label}`)
})
