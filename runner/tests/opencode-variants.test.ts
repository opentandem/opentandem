import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeAdapter, createOpencodeFiles } from '../adapters/opencode/index.mjs'
import { stubAdapterContext } from './fixtures/adapter-context'

// Drives the real OpenCode adapter through its public interface. Only the process
// boundary is faked: `opencode --version` / `opencode models --verbose` (execFile),
// `opencode serve` (spawn) and the server's HTTP API (fetch).

const listing = (variants: Record<string, unknown>) => `deepseek/deepseek-flash\n${JSON.stringify({ limit: { context: 1000000 }, variants }, null, 2)}\n`
type Api = (route: string, init?: RequestInit) => unknown | Promise<unknown>

function fakeServeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 })
  queueMicrotask(() => child.stderr.emit('data', 'opencode server listening on http://127.0.0.1:4999\n'))
  return child
}

function opencode(initialListing: string, initialVersion = '1.18.32') {
  let listingText = initialListing, version = initialVersion, failure = false
  let api: Api = () => { throw new Error('no API configured') }
  const calls: string[][] = []
  // The adapter is plain JavaScript; its results are checked by the assertions, not by types.
  const adapter: any = createOpencodeAdapter(stubAdapterContext({
    execFile: (_bin: string, args: string[], _options: unknown, cb: Function) => {
      calls.push(args)
      if (args[0] === '--version') return cb(null, version)
      cb(failure ? { code: 1 } : null, failure ? '' : listingText)
    },
    spawn: () => fakeServeChild(),
    killCompactChild: () => {},
  }))
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const route = String(url).replace('http://127.0.0.1:4999', '')
    if (failure) return new Response('', { status: 503 })
    const body = await api(route, init)
    return body === null ? new Response(null, { status: 204 }) : Response.json(body)
  })
  return {
    adapter, calls,
    fail: () => { failure = true },
    listing: (value: string) => { listingText = value },
    version: (value: string) => { version = value },
    api: (handler: Api) => { api = handler },
    /** V2 catalog: an optional empty first snapshot, then `rows`; `/default` answers `defaultModel`. */
    catalog: (rows: any[], defaultModel = rows[0], cold = false) => {
      let first = cold
      api = route => {
        if (route.endsWith('/default')) return { data: defaultModel }
        if (first) { first = false; return { data: [] } }
        return { data: rows }
      }
    },
  }
}

/** Runs an adapter call to completion under fake timers (the V2 catalog waits for a stable snapshot). */
async function settle(promise: Promise<any>): Promise<any> {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  while (!done) await vi.advanceTimersByTimeAsync(250)
  return promise
}

let home = ''
beforeEach(() => {
  // opencodeGroup reads ~/.config/opencode/opencode.json; keep the developer's own config out of it.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-opencode-home-'))
  vi.stubEnv('HOME', home)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('OpenCode provider variants', () => {
  it('surfaces native DeepSeek levels and defaults to the CLI configuration', async () => {
    const r = opencode(listing({ max: { reasoningEffort: 'max' }, low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }))
    const group = await settle(r.adapter.models())
    expect(group.models[0].slug).toBe('deepseek/deepseek-flash')
    expect(group.models[0].reasoning_levels.map((l: any) => l.effort)).toEqual(['__default__', 'low', 'high', 'max'])
    expect(group.models[0].default_reasoning_level).toBe('__default__')
    expect(group.default_effort).toBeNull()
  })

  it('does not invent reasoning levels for a model with no variants', async () => {
    const group = await settle(opencode(listing({})).adapter.models())
    expect(group.models[0].reasoning_levels.length).toBe(0)
    expect(group.models[0].default_reasoning_level).toBeUndefined()
  })

  it('excludes disabled and unpersistable custom variants', async () => {
    const group = await settle(opencode(listing({ low: {}, 'deep-thinking-budget': {}, high: { disabled: true }, __default__: {}, invalid: null })).adapter.models())
    expect(group.models[0].reasoning_levels.map((l: any) => l.effort)).toEqual(['__default__', 'low'])
  })

  it('does not retain old variants after a new scan fails to parse that model', async () => {
    const r = opencode(listing({ high: {} }))
    await settle(r.adapter.models())
    r.listing('deepseek/deepseek-flash\n{invalid\n}\n')
    expect((await settle(r.adapter.models())).models[0].reasoning_levels.length).toBe(0)
  })

  it('prefers the model set in the global OpenCode config', async () => {
    const r = opencode(`opencode/other\n${listing({})}`)
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'deepseek/deepseek-flash' }))
    expect((await settle(r.adapter.models())).default_model).toBe('deepseek/deepseek-flash')
  })

  it('starts a private native server rather than the question-disabling CLI', () => {
    const result = opencode('').adapter.command({ workdir: '/workspace' }, [], 'continue')
    expect(result.argv).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1'])
    expect(result.stdinText).toBe('')
    expect(result.cwd).toBe('/workspace')
  })

  it('reads the V2 catalog after a cold empty snapshot, including native variants and default', async () => {
    const r = opencode('', 'opencode v2.0.26')
    const model = { providerID: 'deepseek', id: 'deepseek-flash', enabled: true, limit: { context: 1000000 }, variants: [{ id: 'max' }, { id: 'low' }, { id: 'high', disabled: true }] }
    r.catalog([model, { providerID: 'deepseek', id: 'disabled', enabled: false }], model, true)
    const group = await settle(r.adapter.models())
    expect(r.calls).toEqual([['--version']])
    expect(group.models.length).toBe(1)
    expect(group.default_model).toBe('deepseek/deepseek-flash')
    expect(r.adapter.defaultModel()).toBe('deepseek/deepseek-flash')
    expect(group.models[0].reasoning_levels.map((l: any) => l.effort)).toEqual(['__default__', 'low', 'max'])
    const run = r.adapter.command({ model: group.default_model, reasoning_effort: 'max', resume_thread_id: 'session', exec_mode: 'readonly' }, ['/image.png'], 'continue')
    expect(run.argv).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1'])
    expect(run.stdinText).toBe('') // Model/variant travel over HTTP; covered by opencode-user-input.
  })

  it.each(['1.18.33', 'opencode v2.0.26'])('does not mistake a failed %s catalog for logout or discard its last good models', async version => {
    const r = opencode(listing({ high: {} }), version)
    r.catalog([{ providerID: 'deepseek', id: 'deepseek-flash', limit: { context: 1000000 }, variants: [{ id: 'high' }] }])
    await settle(r.adapter.detect())
    r.fail()
    const probe = await settle(r.adapter.detect())
    expect(probe.installed).toBe(true)
    expect(probe.login).toBe(true)
    expect(probe.models).toEqual(['deepseek/deepseek-flash'])
    expect(probe.error).toBeTruthy()
  })

  it('clears the last catalog when the installed major version changes', async () => {
    const r = opencode(listing({ high: {} }))
    await settle(r.adapter.detect())
    r.version('opencode v2.0.26')
    r.catalog([])
    r.fail()
    const probe = await settle(r.adapter.detect())
    expect(probe.installed).toBe(true)
    // Inventory only checks installation: login always equals installed, a failure shows only in error.
    expect(probe.login).toBe(true)
    expect(probe.models).toEqual([])
    expect(probe.error).toBeTruthy()
  })

  it('reports a missing binary as not installed without an error', async () => {
    const adapter: any = createOpencodeAdapter(stubAdapterContext({
      execFile: (_bin: string, _args: string[], _options: unknown, cb: Function) => cb({ code: 'ENOENT' }, ''),
    }))
    expect(await settle(adapter.detect())).toEqual({ installed: false, login: false, version: null, models: [] })
  })

  it('waits for a stable V2 catalog rather than accepting only the first free model', async () => {
    const r = opencode('', 'opencode v2.0.26')
    const free = { providerID: 'opencode', id: 'free' }, configured = { providerID: 'custom', id: 'paid', variants: [{ id: 'high' }] }
    let reads = 0
    r.api(route => route.endsWith('/default') ? { data: configured } : { data: ++reads < 3 ? [free] : [free, configured] })
    const result = await settle(r.adapter.models())
    expect(result.models.length).toBe(2)
    expect(result.default_model).toBe('custom/paid')
    expect(reads).toBeGreaterThanOrEqual(7)
  })

  it('does not turn a perpetually empty V2 startup snapshot into logout', async () => {
    const r = opencode('', 'opencode v2.0.26')
    r.catalog([])
    const result = await settle(r.adapter.detect())
    expect(result.login).toBe(true)
    expect(result.error).toMatch(/not ready/)
  })

  it.each(['completed', 'failed', 'missing'])('requires this V2 compaction request to complete (%s)', async status => {
    const r = opencode('', 'opencode v2.0.26')
    r.api(route => {
      if (route.endsWith('/compact')) return { data: { id: 'new-compaction' } }
      if (route.endsWith('/wait')) return null
      return { data: [{ id: 'old-compaction', type: 'compaction', status: 'completed' },
        ...(status === 'missing' ? [] : [{ id: 'new-compaction', type: 'compaction', status, error: { message: 'provider unavailable' } }])] }
    })
    const result = await settle(r.adapter.compact('session', '/project', 'deepseek/deepseek-flash'))
    expect(result.ok).toBe(status === 'completed' ? true : undefined)
    if (status !== 'completed') expect(result.error).toBeTruthy()
  })

  it.each([[1, 'session'], [2, 'session_v2']])('reads sessions from the OpenCode %i table', (major, table) => {
    const queries: string[] = []
    const files = createOpencodeFiles({
      fs: { existsSync: () => true }, os: { homedir: () => '/home/runner' }, path,
      SqliteDatabaseSync: class {
        prepare(sql: string) { queries.push(sql); return { get: () => ({ id: 'session' }) } }
        close() {}
      },
      cleanTitle: (title: string) => title, sessionImport: {}, state: () => ({ major }),
    })
    expect(files.session.exists('session')).toBe(true)
    expect(queries[0]).toBe(`SELECT id FROM ${table} WHERE id = ?`)
  })

  it('reports the installed major version to the session reader', async () => {
    const r = opencode('', 'opencode v2.0.26')
    await r.adapter.ready()
    expect(r.adapter.filesState()).toEqual({ major: 2 })
  })
})
