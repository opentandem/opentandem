import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubAdapters } from './fixtures/adapter-context'
import { createAdapterTranslator } from '../core/messages.mjs'

// Runs the real slot / queue / memory-gate code from the Runner: the install-and-update section is cut out
// of machine-daemon.mjs and executed in a vm, with only its external dependencies (detection, the actual
// npm command, heartbeat...) replaced by fakes.
const SOURCE = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
const REGION_START = SOURCE.indexOf('const NPM_REGISTRIES')
const REGION_END = SOURCE.indexOf('/**\n * First-use hook')

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T = void>() {
  let resolve!: (value?: T) => void
  const promise = new Promise<T>(r => { resolve = r as (value?: T) => void })
  return { promise, resolve }
}
const meminfo = (availableMb: number, swapMb = 0) =>
  `MemTotal:  524288 kB\nMemAvailable:  ${availableMb * 1024} kB\nSwapFree:  ${swapMb * 1024} kB\n`

type Slot = { agent: string, operation: string, target_version: string, state: string, reason: string, log: string }
type Env = {
  context: vm.Context
  start: (id: string, operation?: string, target?: string) => Promise<Record<string, unknown>>
  status: (id?: string, since?: number) => Record<string, any>
  slots: Map<string, Slot>
  override: (name: string, fn: unknown) => void
  failures: ReturnType<typeof vi.fn>
  setMeminfo: (text: string) => void
  setNow: (ms: number) => void
}

// The memory gate's wait loop is a 1ms timer: at the end of each case, set memory very high so the
// ones still waiting are released and finish.
const loaded: Env[] = []
afterEach(() => { for (const env of loaded.splice(0)) env.setMeminfo(meminfo(1_000_000)) })

function loadRunner(opts: { platform?: string, mem?: string } = {}): Env {
  let mem = opts.mem ?? meminfo(4000)
  let now = 1_000_000
  const failures = vi.fn()
  const context = vm.createContext({
    t: createAdapterTranslator(),
    AGENT_INSTALLS: {
      codex: { kind: 'npm', dir: '/managed/codex' },
      claude: { kind: 'npm', dir: '/managed/claude' },
      qwen: { kind: 'npm', dir: '/managed/qwen' },
      kimi: { kind: 'script', url: 'https://example.invalid/install.sh' },
    },
    IS_WIN: false, DAEMON_VERSION: 'test', executingRunRuntimes: new Map(), ADAPTERS: stubAdapters(),
    os: { homedir: () => '/home/u' }, path,
    process: { platform: opts.platform ?? 'linux', env: {} },
    fs: { readFileSync: () => mem },
    // Wait interval shortened to 1ms; Date replaced by a controllable clock to verify the 15-minute maximum wait
    setTimeout: (fn: () => void) => setTimeout(fn, 1),
    Date: { now: () => now },
    queueAgentUpdateFailure: failures, flushAgentUpdateFailures: () => Promise.resolve(),
    binOf: (id: string) => id, resolveRuntimeExecutable: () => '/usr/local/lib/node_modules/pkg/bin/cli.js',
    compareDaemonVersions: () => 1, AGENT_RUNTIMES_DIR: '/managed',
    beat: async () => true, rescanModelsNow: async () => ({}), collectRuntimeStatuses: async () => [],
  })
  vm.runInContext(SOURCE.slice(REGION_START, REGION_END), context)
  const api = vm.runInContext('({ startAgentInstall, agentInstallStatus, agentInstallSlots })', context) as {
    startAgentInstall: Env['start'], agentInstallStatus: Env['status'], agentInstallSlots: Map<string, Slot>,
  }
  const env: Env = {
    context, start: api.startAgentInstall, status: api.agentInstallStatus, slots: api.agentInstallSlots, failures,
    override(name, fn) { (context as any).__override = fn; vm.runInContext(`${name} = __override`, context) },
    setMeminfo(text) { mem = text },
    setNow(ms) { now = ms },
  }
  loaded.push(env)
  return env
}

/** Fake performAgentUpdate: records the start order and stays "running" until the gate is released. */
function fakeUpdates(env: Env, ids: string[]) {
  const started: string[] = []
  const gates = Object.fromEntries(ids.map(id => [id, deferred()])) as Record<string, ReturnType<typeof deferred>>
  env.override('performAgentUpdate', async (slot: Slot, id: string) => {
    started.push(id)
    ;(env.context as any).installLogAppend(slot, `running ${id}\n`)
    await gates[id].promise
    return { state: 'done' }
  })
  return { started, gates }
}
/**
 * Drive the real prepareAgentUpdate to the queueing step: version detection and install source are fakes,
 * and the plan is taken from plans[id].
 */
function fakePlans(env: Env, plans: Record<string, Record<string, unknown>>) {
  env.override('probeAgentUpdateVersion', async () => ({ version: '1.0.0' }))
  env.override('rememberRuntimeVersion', (runtime: string) => ({ runtime, version: '1.0.0' }))
  env.override('buildAgentUpdatePlan', (input: { runtime: string }) => plans[input.runtime] ?? null)
}
const npmPlan = (prefix: string, global = true) => ({ kind: 'npm', package: 'pkg@2.0.0', prefix, global })

describe('Runner per-Agent install/update slots', () => {
  it('reserves the Agent slot synchronously so the same concurrent request starts one update', async () => {
    const env = loadRunner()
    let prepares = 0
    env.override('prepareAgentUpdate', async () => { prepares++; return { state: 'done' } })
    const [first, second] = await Promise.all([
      env.start('codex', 'update', '0.163.0'), env.start('codex', 'update', '0.163.0'),
    ])
    await flush()
    expect(first).toEqual({ state: 'running', agent: 'codex', operation: 'update', target_version: '0.163.0' })
    expect(second).toEqual(first)
    expect(prepares).toBe(1)
  })

  it('lets different Agents update at the same time and keeps their logs apart', async () => {
    const env = loadRunner()
    const done = { codex: deferred(), qwen: deferred() }
    env.override('prepareAgentUpdate', async (slot: Slot, id: 'codex' | 'qwen') => {
      ;(env.context as any).installLogAppend(slot, `log from ${id}\n`)
      await done[id].promise
      return { state: 'done' }
    })
    const a = await env.start('codex', 'update', '0.163.0')
    const b = await env.start('qwen', 'update', '2.0.0')
    expect(a).toEqual({ state: 'running', agent: 'codex', operation: 'update', target_version: '0.163.0' })
    expect(b).toEqual({ state: 'running', agent: 'qwen', operation: 'update', target_version: '2.0.0' })
    expect([...env.slots.values()].map(s => s.state)).toEqual(['running', 'running'])
    expect(env.status('codex').text).toContain('log from codex')
    expect(env.status('codex').text).not.toContain('log from qwen')
    expect(env.status('qwen').text).toContain('log from qwen')
    expect(env.status('qwen').text).not.toContain('log from codex')

    done.codex.resolve()
    await flush()
    expect(env.status('codex').state).toBe('done')
    expect(env.status('qwen').state).toBe('running')
  })

  it('also lets an Agent install start while another Agent is updating', async () => {
    const env = loadRunner()
    env.override('prepareAgentUpdate', () => new Promise(() => {}))
    const gate = deferred()
    env.override('performAgentInstall', async () => { await gate.promise; return { state: 'done' } })
    await env.start('codex', 'update', '0.163.0')
    expect(await env.start('qwen', 'install')).toEqual({ state: 'running', agent: 'qwen', operation: 'install' })
    expect(env.status('qwen').operation).toBe('install')
    gate.resolve()
    await flush()
    expect(env.status('qwen').state).toBe('done')
    expect(env.status('codex').state).toBe('running')
  })

  it('rejects a different request for the same running Agent and answers the same one idempotently', async () => {
    const env = loadRunner()
    let prepares = 0
    env.override('prepareAgentUpdate', () => { prepares++; return new Promise(() => {}) })
    await env.start('codex', 'update', '0.163.0')
    expect(await env.start('codex', 'update', '0.164.0')).toEqual({ error: 'busy', agent: 'codex' })
    expect(await env.start('codex', 'install')).toEqual({ error: 'busy', agent: 'codex' })
    expect(await env.start('codex', 'update', '0.163.0')).toEqual({ state: 'running', agent: 'codex', operation: 'update', target_version: '0.163.0' })
    expect(prepares).toBe(1)
  })

  it('keeps the existing rejections for an unsupported Agent, bad version and a running task', async () => {
    const env = loadRunner()
    env.override('prepareAgentUpdate', async () => ({ state: 'done' }))
    expect((await env.start('nope', 'update', '1.0.0')).error).toContain('nope')
    expect(await env.start('codex', 'update', 'latest')).toEqual({ error: 'unsupported_update' })
    ;(env.context as any).executingRunRuntimes.set('run-1', 'codex')
    expect(await env.start('codex', 'update', '0.163.0')).toEqual({ error: 'agentUpdateBusy' })
    expect(env.slots.has('codex')).toBe(false)
  })

  it('records a failed update per Agent with that Agent\'s own reason and log', async () => {
    const env = loadRunner()
    env.override('prepareAgentUpdate', async (slot: Slot, id: string) => {
      ;(env.context as any).installLogAppend(slot, `boom ${id}\n`)
      return id === 'codex' ? { state: 'failed', reason: 'network' } : { state: 'done' }
    })
    await env.start('codex', 'update', '0.163.0')
    await env.start('qwen', 'update', '2.0.0')
    await flush()
    expect(env.failures).toHaveBeenCalledTimes(1)
    const [agent, target, reason, log] = env.failures.mock.calls[0]
    expect([agent, target, reason]).toEqual(['codex', '0.163.0', 'network'])
    expect(log).toContain('boom codex')
    expect(log).not.toContain('boom qwen')
    expect(env.status('qwen')).toMatchObject({ state: 'done' })
  })
})

describe('Runner agentInstallStatus', () => {
  it('returns one Agent\'s own slot, or idle when it has none', async () => {
    const env = loadRunner()
    env.override('prepareAgentUpdate', async (slot: Slot) => {
      ;(env.context as any).installLogAppend(slot, 'hello\n')
      return new Promise(() => {})
    })
    await env.start('qwen', 'update', '2.0.0')
    const qwen = env.status('qwen', 0)
    expect(qwen).toMatchObject({ agent: 'qwen', operation: 'update', target_version: '2.0.0', state: 'running' })
    expect(qwen.text).toContain('hello')
    expect(qwen.next).toBe(qwen.text.length)
    expect(qwen).not.toHaveProperty('slots')
    expect(env.status('codex')).toEqual({ agent: 'codex', state: 'idle', text: '', next: 0 })
    expect(env.status('nope').error).toContain('nope')
  })

  it('without an id returns the most recently started running slot plus a log-free slots summary', async () => {
    const env = loadRunner()
    const results: Record<string, { state: string, reason?: string }> = { codex: { state: 'done' } }
    const never = new Promise(() => {})
    env.override('prepareAgentUpdate', async (slot: Slot, id: string) => {
      ;(env.context as any).installLogAppend(slot, `log ${id}\n`)
      return results[id] ?? never
    })
    expect(env.status('')).toEqual({
      agent: '', operation: 'install', target_version: undefined, state: 'idle', reason: undefined, text: '', next: 0, slots: [],
    })
    await env.start('codex', 'update', '0.163.0')
    await flush()
    // none running: pick the one that started most recently
    expect(env.status('')).toMatchObject({ agent: 'codex', state: 'done' })
    await env.start('qwen', 'update', '2.0.0')
    await env.start('claude', 'update', '3.0.0')
    const all = env.status('', 0)
    // several running: pick the one that started most recently
    expect(all).toMatchObject({ agent: 'claude', operation: 'update', target_version: '3.0.0', state: 'running' })
    expect(all.text).toContain('log claude')
    expect(all.text).not.toContain('log qwen')
    expect(all.slots).toEqual([
      { agent: 'codex', operation: 'update', target_version: '0.163.0', state: 'done' },
      { agent: 'qwen', operation: 'update', target_version: '2.0.0', state: 'running' },
      { agent: 'claude', operation: 'update', target_version: '3.0.0', state: 'running' },
    ])
    for (const row of all.slots) expect(row).not.toHaveProperty('text')
    // reopening a finished codex makes it the most recently started
    results.codex = undefined as never
    await env.start('codex', 'update', '0.170.0')
    expect(env.status('')).toMatchObject({ agent: 'codex', target_version: '0.170.0', state: 'running' })
    expect(env.status('').slots.map((row: { agent: string }) => row.agent)).toEqual(['qwen', 'claude', 'codex'])
  })

  it('reports the failure reason of a finished slot in the summary', async () => {
    const env = loadRunner()
    env.override('prepareAgentUpdate', async () => ({ state: 'failed', reason: 'disk' }))
    await env.start('codex', 'update', '0.163.0')
    await flush()
    expect(env.status('').slots).toEqual([{ agent: 'codex', operation: 'update', target_version: '0.163.0', state: 'failed', reason: 'disk' }])
  })
})

describe('Runner npm directory queue', () => {
  it('runs updates that share one npm directory one after another and says so in the log', async () => {
    const env = loadRunner()
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/usr/local') })
    const { started, gates } = fakeUpdates(env, ['codex', 'qwen'])
    await env.start('codex', 'update', '2.0.0')
    await env.start('qwen', 'update', '2.0.0')
    await flush()
    expect(started).toEqual(['codex'])
    expect(env.status('qwen')).toMatchObject({ state: 'running' })
    expect(env.status('qwen').text).toContain('[opentandem] waiting for another update in the same npm directory…')
    expect(env.status('codex').text).not.toContain('waiting for another update')
    gates.codex.resolve()
    await flush()
    expect(started).toEqual(['codex', 'qwen'])
    expect(env.status('codex').state).toBe('done')
    expect(env.status('qwen').state).toBe('running')
    gates.qwen.resolve()
    await flush()
    expect(env.status('qwen').state).toBe('done')
  })

  it('serves three updates on the same directory in the order they arrived', async () => {
    const env = loadRunner()
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/usr/local'), claude: npmPlan('/usr/local') })
    const { started, gates } = fakeUpdates(env, ['codex', 'qwen', 'claude'])
    await env.start('codex', 'update', '2.0.0')
    await env.start('qwen', 'update', '2.0.0')
    await env.start('claude', 'update', '2.0.0')
    await flush()
    expect(started).toEqual(['codex'])
    gates.codex.resolve(); await flush()
    expect(started).toEqual(['codex', 'qwen'])
    gates.qwen.resolve(); await flush()
    expect(started).toEqual(['codex', 'qwen', 'claude'])
  })

  it('keeps going when an earlier update in the same directory fails', async () => {
    const env = loadRunner()
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/usr/local') })
    const started: string[] = []
    const gate = deferred()
    env.override('performAgentUpdate', async (_slot: Slot, id: string) => {
      started.push(id)
      if (id === 'codex') { await gate.promise; throw new Error('npm exploded') }
      return { state: 'done' }
    })
    await env.start('codex', 'update', '2.0.0')
    await env.start('qwen', 'update', '2.0.0')
    await flush()
    gate.resolve()
    await flush()
    expect(started).toEqual(['codex', 'qwen'])
    expect(env.status('codex')).toMatchObject({ state: 'failed', reason: 'other' })
    expect(env.status('qwen').state).toBe('done')
  })

  it('does not queue updates in different npm directories, or a global and a local one with the same prefix', async () => {
    const env = loadRunner()
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/home/u/.local/share/opentandem/runtimes/qwen', false), claude: npmPlan('/usr/local', false) })
    const { started, gates } = fakeUpdates(env, ['codex', 'qwen', 'claude'])
    await env.start('codex', 'update', '2.0.0')
    await env.start('qwen', 'update', '2.0.0')
    await env.start('claude', 'update', '2.0.0')
    await flush()
    expect(started.sort()).toEqual(['claude', 'codex', 'qwen'])
    for (const id of ['codex', 'qwen', 'claude']) expect(env.status(id).text).not.toContain('waiting for another update')
    for (const id of ['codex', 'qwen', 'claude']) gates[id].resolve()
    await flush()
    expect(env.status('').slots.map((row: { state: string }) => row.state)).toEqual(['done', 'done', 'done'])
  })

  it('does not queue brew or native command updates', async () => {
    const env = loadRunner()
    fakePlans(env, {
      codex: { kind: 'brew', file: '/opt/homebrew/bin/brew', formula: 'codex', cask: true },
      claude: { kind: 'command', file: '/home/u/.local/bin/claude', args: ['update'] },
    })
    const { started, gates } = fakeUpdates(env, ['codex', 'claude'])
    await env.start('codex', 'update', '2.0.0')
    await env.start('claude', 'update', '2.0.0')
    await flush()
    expect(started.sort()).toEqual(['claude', 'codex'])
    gates.codex.resolve(); gates.claude.resolve()
  })
})

describe('Runner Linux low-memory gate with parallel npm', () => {
  it('only checks Linux, and still demands 400MB for a single npm', () => {
    const env = loadRunner({ platform: 'darwin', mem: meminfo(10) })
    const check = vm.runInContext('installMemoryShortfallMb', env.context) as (n?: number) => number | null
    expect(check()).toBeNull()
    const linux = loadRunner({ mem: meminfo(399) })
    const linuxCheck = vm.runInContext('installMemoryShortfallMb', linux.context) as (n?: number) => number | null
    expect(linuxCheck()).toBe(399)
    linux.setMeminfo(meminfo(300, 100))
    expect(linuxCheck()).toBeNull()
    linux.setMeminfo(meminfo(700))
    expect(linuxCheck(0)).toBeNull()
    expect(linuxCheck(1)).toBe(700) // one npm already running: threshold is 800MB
    linux.setMeminfo(meminfo(800))
    expect(linuxCheck(1)).toBeNull()
  })

  it('fails an npm update straight away when nothing else runs npm and memory is under 400MB', async () => {
    const env = loadRunner({ mem: meminfo(300) })
    fakePlans(env, { codex: npmPlan('/usr/local') })
    const { started } = fakeUpdates(env, ['codex'])
    await env.start('codex', 'update', '2.0.0')
    await flush()
    expect(started).toEqual([])
    expect(env.status('codex')).toMatchObject({ state: 'failed', reason: 'other' })
    expect(env.status('codex').text).toContain('only 300 MB of free memory plus swap is available; update stopped.')
    expect(env.failures).toHaveBeenCalledWith('codex', '2.0.0', 'other', expect.stringContaining('only 300 MB'))
  })

  it('keeps the low_memory receipt for a fresh install when nothing else runs npm', async () => {
    const env = loadRunner({ mem: meminfo(300) })
    expect(await env.start('codex', 'install')).toEqual({ error: 'low_memory', available_mb: 300 })
    expect(await env.start('kimi', 'install')).toEqual({ error: 'low_memory', available_mb: 300 })
    expect(env.slots.size).toBe(0)
  })

  it('queues instead of failing while another npm is running, and starts once memory allows', async () => {
    const env = loadRunner({ mem: meminfo(1000) })
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/home/u/.local/share/opentandem/runtimes/qwen', false) })
    const { started, gates } = fakeUpdates(env, ['codex', 'qwen'])
    await env.start('codex', 'update', '2.0.0')
    await flush()
    expect(started).toEqual(['codex'])
    env.setMeminfo(meminfo(600)) // enough for one npm (400), not enough for two in parallel (800)
    await env.start('qwen', 'update', '2.0.0')
    await flush(); await flush()
    expect(started).toEqual(['codex'])
    expect(env.status('qwen')).toMatchObject({ state: 'running' })
    expect(env.status('qwen').text).toContain('[opentandem] waiting for free memory while another npm command is running…')
    env.setMeminfo(meminfo(900))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual(['codex', 'qwen'])
    expect(env.status('qwen').state).toBe('running')
    gates.codex.resolve(); gates.qwen.resolve()
    await flush()
    expect(env.status('qwen').state).toBe('done')
  })

  it('fails the waiting update like a single one once the other npm is gone and memory is still under 400MB', async () => {
    const env = loadRunner({ mem: meminfo(1000) })
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/home/u/.local/share/opentandem/runtimes/qwen', false) })
    const { started, gates } = fakeUpdates(env, ['codex', 'qwen'])
    await env.start('codex', 'update', '2.0.0')
    await flush()
    env.setMeminfo(meminfo(600))
    await env.start('qwen', 'update', '2.0.0')
    await flush()
    expect(env.status('qwen').state).toBe('running')
    env.setMeminfo(meminfo(300))
    gates.codex.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual(['codex'])
    expect(env.status('qwen')).toMatchObject({ state: 'failed', reason: 'other' })
    expect(env.status('qwen').text).toContain('only 300 MB of free memory plus swap is available; update stopped.')
  })

  it('gives up waiting for memory after 15 minutes', async () => {
    const env = loadRunner({ mem: meminfo(1000) })
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/home/u/.local/share/opentandem/runtimes/qwen', false) })
    const { started } = fakeUpdates(env, ['codex', 'qwen'])
    await env.start('codex', 'update', '2.0.0')
    await flush()
    env.setMeminfo(meminfo(600))
    await env.start('qwen', 'update', '2.0.0')
    await flush()
    expect(env.status('qwen').state).toBe('running')
    env.setNow(1_000_000 + 15 * 60_000 + 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual(['codex'])
    expect(env.status('qwen')).toMatchObject({ state: 'failed', reason: 'other' })
    expect(env.status('qwen').text).toContain('after waiting 15 minutes')
  })

  it('starts an install as a queued running job (not low_memory) while another npm is running', async () => {
    const env = loadRunner({ mem: meminfo(1000) })
    fakePlans(env, { codex: npmPlan('/usr/local') })
    fakeUpdates(env, ['codex'])
    const installs: string[] = []
    env.override('performAgentInstall', async (_slot: Slot, id: string) => { installs.push(id); return { state: 'done' } })
    await env.start('codex', 'update', '2.0.0')
    await flush()
    env.setMeminfo(meminfo(600))
    expect(await env.start('qwen', 'install')).toEqual({ state: 'running', agent: 'qwen', operation: 'install' })
    expect(await env.start('kimi', 'install')).toEqual({ state: 'running', agent: 'kimi', operation: 'install' })
    await flush()
    expect(installs).toEqual([])
    env.setMeminfo(meminfo(1000))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(installs.sort()).toEqual(['kimi', 'qwen'])
  })

  it('counts two npm jobs that start in the same tick, so the second one sees the first', async () => {
    const env = loadRunner({ mem: meminfo(600) })
    fakePlans(env, { codex: npmPlan('/usr/local'), qwen: npmPlan('/home/u/.local/share/opentandem/runtimes/qwen', false) })
    const { started } = fakeUpdates(env, ['codex', 'qwen'])
    await Promise.all([env.start('codex', 'update', '2.0.0'), env.start('qwen', 'update', '2.0.0')])
    await flush(); await flush()
    expect(started).toEqual(['codex']) // 600MB is enough for one npm, not for two
    expect(env.status('qwen').text).toContain('waiting for free memory')
  })
})
