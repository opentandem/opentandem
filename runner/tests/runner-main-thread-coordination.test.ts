// 0.87.0: the Runner main thread only launches and coordinates. This checks that several coordination rules actually hold:
// the heartbeat and command channel start before the slow startup steps; one stuck command does not block later commands;
// the agent tool inventory runs only one round at a time, and if a re-collection is requested midway the old round's
// result is not written to the cache; a slow or timed-out skill scan does not hold up the heartbeat and keeps the previous index;
// system commands (killing a process) are not queued behind ordinary system commands.
import { describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import vm from 'node:vm'

const daemon = fs.readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')

function between(start: string, end: string) {
  const at = daemon.indexOf(start)
  expect(at, start).toBeGreaterThanOrEqual(0)
  const stop = daemon.indexOf(end, at + start.length)
  expect(stop, end).toBeGreaterThan(at)
  return daemon.slice(at, stop)
}

/** A top-level function, through its closing brace at column 0. */
function fn(head: string) {
  const at = daemon.indexOf(`\n${head}`)
  expect(at, head).toBeGreaterThanOrEqual(0)
  return daemon.slice(at + 1, daemon.indexOf('\n}\n', at) + 3)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('startup order', () => {
  it('heartbeats and the command channel start before CLI validation and session restore', () => {
    const at = (text: string) => { const i = daemon.indexOf(text); expect(i, text).toBeGreaterThan(0); return i }
    const acknowledged = at("bootMark('first heartbeat acknowledged')")
    const firstTick = at('\nvoid tick()\n')
    const interval = at('\nsetInterval(tick, BEAT_MS)\n')
    const commands = at('\nvoid browseLoop()\n')
    expect(acknowledged).toBeLessThan(firstTick)
    for (const started of [firstTick, interval, commands]) {
      // Adapter startup hooks run CLIs (Trae Agent: which installed program is the Agent).
      expect(started).toBeLessThan(at('await Promise.all(Object.values(ADAPTERS).map(adapter => (async () => adapter.startup?.())()'))
      expect(started).toBeLessThan(at('\nawait restoreSessions()\n'))
    }
    expect(daemon.match(/setInterval\(tick\b/g)).toHaveLength(1)
  })
})

describe('command channel', () => {
  it('keeps polling while an earlier command is still running', async () => {
    const hung = deferred<unknown>()
    const commands = [
      { request_id: 'r1', type: 'ping' },
      { request_id: 'r2', type: 'ping' },
      { request_id: 'r3', type: 'dirs', dir: '/tmp' },
    ]
    let polls = 0
    const delivered: string[] = []
    const context = {
      runnerDeleting: false, SERVER: 'http://runner.test', ID: 'm1', authHeaders: {}, POLL_MS: 5,
      AbortSignal: { timeout: () => undefined }, console,
      setTimeout, clearTimeout,
      withDeadline: (promise: unknown) => promise,
      rejectManagedKey: () => {},
      fetch: async () => {
        const cmd = commands[polls++]
        if (!cmd) return new Promise(() => {}) // the next long-poll hold
        return { status: 200, ok: true, json: async () => cmd }
      },
      runQuickBrowseCommand: (cmd: { request_id: string }) => cmd.request_id === 'r1' ? hung.promise : Promise.resolve({ ok: true }),
      runDirectoryCommand: async () => ({ dirs: [] }),
      deliverBrowse: async (requestId: string) => { delivered.push(requestId) },
    }
    vm.runInNewContext([
      between('const BACKGROUND_BROWSE_COMMANDS = ', '\n])\n') + '\n])',
      fn('function runBrowseCommandInBackground('),
      fn('async function browseLoop('),
      'void browseLoop()',
    ].join('\n'), context)
    await vi.waitFor(() => expect(polls).toBe(4))
    await vi.waitFor(() => expect(delivered.sort()).toEqual(['r2', 'r3']))
    hung.resolve({ ok: true })
    await vi.waitFor(() => expect(delivered.sort()).toEqual(['r1', 'r2', 'r3']))
  })
})

describe('runtime inventory', () => {
  function load() {
    const body = fn('async function collectRuntimeStatusesNow(')
    const codex: Array<ReturnType<typeof deferred<{ installed: boolean; version: string }>>> = []
    const idle = async () => ({ installed: false, login: false, version: null })
    const adapter = (id: string, detect: () => Promise<unknown>) => ({ id, detect, bin: () => '' })
    const context: Record<string, unknown> = {
      Date, runtimeLastGood: new Map(),
      smoothRuntimeStatus: (status: unknown) => status,
      inferRuntimeInstallInfo: () => ({}),
      ADAPTERS: {
        codex: adapter('codex', () => { const d = deferred<{ installed: boolean; version: string }>(); codex.push(d); return d.promise }),
        claude: adapter('claude', idle),
        opencode: adapter('opencode', idle),
      },
    }
    vm.runInNewContext([
      between('let runtimeStatusCache = null', '\n// A failed probe does not mean not installed'),
      body,
      'globalThis.cached = () => runtimeStatusCache',
    ].join('\n'), context)
    return { context: context as any, codex }
  }
  const codexVersion = (statuses: Array<{ runtime: string; version: string }>) => statuses.find(s => s.runtime === 'codex')?.version

  it('runs one inventory at a time and shares it with every caller', async () => {
    const { context, codex } = load()
    const first = context.collectRuntimeStatuses()
    const second = context.collectRuntimeStatuses()
    expect(codex).toHaveLength(1)
    codex[0].resolve({ installed: true, version: '1.0' })
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(codexVersion(a)).toBe('1.0')
    // Within the 5-minute cache window nothing is probed again.
    expect(await context.collectRuntimeStatuses()).toBe(a)
    expect(codex).toHaveLength(1)
  })

  it('a recollect request during an inventory starts a new one, and the stale one never overwrites it', async () => {
    const { context, codex } = load()
    const stale = context.collectRuntimeStatuses()
    context.invalidateRuntimeStatuses() // e.g. an agent was just installed
    const fresh = context.collectRuntimeStatuses()
    expect(codex).toHaveLength(2)
    codex[1].resolve({ installed: true, version: 'new' })
    expect(codexVersion(await fresh)).toBe('new')
    codex[0].resolve({ installed: true, version: 'old' })
    expect(codexVersion(await stale)).toBe('old')
    expect(codexVersion(context.cached())).toBe('new')
  })
})

describe('skill index', () => {
  function load(runOnLane: (lane: string, job: { workdirs: string[] }) => Promise<unknown>) {
    const errors: string[] = []
    const context: any = {
      crypto, Date, setTimeout, clearTimeout, runOnLane,
      console: { ...console, error: (line: string) => errors.push(line) },
    }
    vm.runInNewContext([
      between('const SKILL_SCAN_MS = ', '\nlet serverHasSkillIndex'),
      between('const SKILL_SCAN_WAIT_MS = ', '\n/**\n * The web refresh button'),
      `globalThis.state = () => ({ skillIndexCache, skillScanBackoffUntil })
       globalThis.seed = (skills, workdirs) => { skillIndexCache = skills; skillScanAt = 0; skillWorkdirs = workdirs }
       globalThis.setWorkdirs = workdirs => { skillWorkdirs = workdirs }`,
    ].join('\n'), context)
    return { context, errors }
  }
  const old = [{ name: 'old', description: 'kept', source: 'user' }]

  it('a timed-out scan keeps the previous index and is not retried every beat', async () => {
    const runOnLane = vi.fn(async () => ({ error: 'scan thread timed out', error_code: 'SCAN_TIMEOUT' }))
    const { context, errors } = load(runOnLane)
    context.seed(old, ['/w'])
    const report = await context.skillReport(true)
    expect(report.index.skills).toEqual(old)
    expect(context.state().skillIndexCache).toEqual(old)
    expect(context.state().skillScanBackoffUntil).toBeGreaterThan(Date.now())
    expect(errors.join('\n')).toMatch(/keeping the previous index/)
    await context.skillReport(true)
    expect(runOnLane).toHaveBeenCalledTimes(1)
  })

  it('a slow scan does not hold the heartbeat; its result lands on a later beat', async () => {
    const scan = deferred<unknown>()
    const runOnLane = vi.fn(() => scan.promise)
    const { context } = load(runOnLane)
    context.seed(old, ['/w'])
    const started = Date.now()
    const report = await context.skillReport(true)
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(report.index.skills).toEqual(old)
    const fresh = [{ name: 'new', description: 'just created', source: 'user' }]
    scan.resolve({ skills: fresh })
    await vi.waitFor(() => expect(context.state().skillIndexCache).toEqual(fresh))
  })

  it('drops a result scanned for a project list that has since changed', async () => {
    const scan = deferred<unknown>()
    const { context } = load(() => scan.promise)
    context.seed(old, ['/a'])
    const pending = context.refreshSkillIndex()
    context.setWorkdirs(['/a', '/b'])
    scan.resolve({ skills: [{ name: 'only-a', description: '', source: 'project' }] })
    await pending
    expect(context.state().skillIndexCache).toEqual(old)
  })
})

describe('system process lane', () => {
  function load(platform: string) {
    const started: Array<{ file: string; done: (error: Error | null, stdout: string) => void }> = []
    const context: any = {
      process: { platform },
      rawExecFile: (file: string, _args: string[], _opts: unknown, done: (error: Error | null, stdout: string) => void) => {
        if (file === 'throws') throw new Error('spawn EACCES')
        started.push({ file, done })
      },
    }
    vm.runInNewContext(fn('function systemExecState(') + fn('function systemExec('), context)
    return { context, started }
  }

  it('an urgent call (killing a process) starts before calls already waiting', async () => {
    const { context, started } = load('darwin')
    const results = ['a', 'b', 'c', 'd'].map(file => context.systemExec(file, []))
    const later = context.systemExec('later', [])
    const kill = context.systemExec('kill', [], { urgent: true })
    expect(started.map(s => s.file)).toEqual(['a', 'b', 'c', 'd'])
    started[0].done(null, 'out-a')
    expect(started.map(s => s.file)).toEqual(['a', 'b', 'c', 'd', 'kill'])
    started[1].done(null, '')
    expect(started.at(-1)!.file).toBe('later')
    expect(await results[0]).toEqual({ error: null, stdout: 'out-a' })
    for (const s of started.slice(2)) s.done(null, '')
    await Promise.all([later, kill])
  })

  it('Windows gets two slots; a spawn that throws resolves with the error and frees its slot', async () => {
    const { context, started } = load('win32')
    const failed = await context.systemExec('throws', [])
    expect(failed.error.message).toBe('spawn EACCES')
    void context.systemExec('a', []); void context.systemExec('b', []); void context.systemExec('c', [])
    expect(started.map(s => s.file)).toEqual(['a', 'b'])
  })

  it('does not share the slots that gate CLI probes', () => {
    const body = fn('function systemExec(')
    expect(body).toMatch(/\brawExecFile\(/)
    expect(body).not.toMatch(/(?<![\w.])execFile\(|winCall\(/)
  })
})
