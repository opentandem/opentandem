import { readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import vm from 'node:vm'
import { stubAdapters } from './fixtures/adapter-context'

// Each agent's package name, native update command and Homebrew rules live in the adapter's install (runner/adapters/).
const ADAPTERS = stubAdapters()
const opencodeSource = readFileSync(new URL('../adapters/opencode/index.mjs', import.meta.url), 'utf8')

function updatePlan(input: Record<string, unknown>) {
  const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function buildAgentUpdatePlan(')
  expect(start, 'Runner 缺少 Agent 更新命令映射').toBeGreaterThan(-1)
  const end = source.indexOf('\nfunction ', start + 1)
  const fn = vm.runInNewContext(`${source.slice(start, end)}; buildAgentUpdatePlan`, { ADAPTERS })
  return fn(input)
}

describe('Runner Agent update command allow-list', () => {
  it('keeps a freshly detected OpenCode version when only the model catalog failed', () => {
    const merge = ADAPTERS.opencode.status
    expect(merge(
      { installed: true, login: null, version: '1.19.3', error: 'models timed out' },
      { runtime: 'opencode', installed: true, login: true, version: '1.19.0' },
    )).toEqual({ runtime: 'opencode', installed: true, login: true, version: '1.19.3' })
  })

  it('gives slow OpenCode and update version probes more than the generic Linux budget', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    expect(opencodeSource).toContain("const OPENCODE_VERSION_PROBE_MS = IS_WIN ? 30_000 : 20_000")
    expect(source).toContain('const AGENT_UPDATE_VERSION_PROBE_MS = 30_000')
    expect(opencodeSource).toContain("opencodeCommand(['--version'], OPENCODE_VERSION_PROBE_MS)")
    expect(source).toContain('const command = IS_WIN ? binOf(runtime) : executable')
    expect(source).toContain("execFile(command, ['--version'], { timeout: AGENT_UPDATE_VERSION_PROBE_MS")
  })

  it('updates the npm package in the installation that PATH actually selected', () => {
    expect(updatePlan({ runtime: 'codex', install_method: 'npm', executable: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', target_version: '0.163.0', managed: false })).toEqual({
      kind: 'npm', package: '@openai/codex@0.163.0', prefix: '/usr/local', global: true,
    })
    expect(updatePlan({ runtime: 'opencode', install_method: 'npm', executable: '/Users/u/.local/share/opentandem/runtimes/opencode/node_modules/opencode-ai/bin/opencode', target_version: '1.19.3', managed: true })).toEqual({
      kind: 'npm', package: 'opencode-ai@1.19.3', prefix: '/Users/u/.local/share/opentandem/runtimes/opencode', global: false,
    })
  })

  it('keeps OpenCode on its installed major and maps supported native and Homebrew updates', () => {
    expect(updatePlan({ runtime: 'opencode', install_method: 'native', executable: '/Users/u/.opencode/bin/opencode', current_version: '1.18.32', target_version: '1.19.3' })).toEqual({
      kind: 'command', file: '/Users/u/.opencode/bin/opencode', args: ['upgrade', 'v1.19.3', '--method', 'curl'],
    })
    expect(updatePlan({ runtime: 'opencode', install_method: 'native', executable: '/Users/u/.opencode/bin/opencode', current_version: '1.18.32', target_version: '2.0.1' })).toBeNull()
    expect(updatePlan({ runtime: 'claude', install_method: 'native', executable: '/Users/u/.local/bin/claude', current_version: '2.1.128', target_version: '2.1.304' })).toEqual({
      kind: 'command', file: '/Users/u/.local/bin/claude', args: ['update'],
    })
    expect(updatePlan({ runtime: 'codex', install_method: 'homebrew', executable: '/opt/homebrew/Caskroom/codex/0.159.2/codex', target_version: '0.163.0' })).toEqual({
      kind: 'brew', file: '/opt/homebrew/bin/brew', formula: 'codex', cask: true,
    })
  })

  it('binds Homebrew updates to the brew that owns the selected executable and keeps OpenCode on its major', () => {
    expect(updatePlan({ runtime: 'opencode', install_method: 'homebrew', executable: '/usr/local/Cellar/opencode/1.18.32/bin/opencode', current_version: '1.18.32', target_version: '1.19.3', homebrew_formula: 'homebrew/core/opencode' })).toEqual({
      kind: 'brew', file: '/usr/local/bin/brew', formula: 'opencode', cask: false, expected_major: 1,
    })
    expect(updatePlan({ runtime: 'codex', install_method: 'homebrew', executable: '/custom/Cellar/codex/0.159.2/bin/codex', target_version: '0.163.0' })).toBeNull()
  })

  it('derives the Windows global npm prefix from the selected shim target', () => {
    expect(updatePlan({ runtime: 'codex', install_method: 'npm', executable: 'C:/Users/u/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js', target_version: '0.163.0', managed: false })).toEqual({
      kind: 'npm', package: '@openai/codex@0.163.0', prefix: 'C:/Users/u/AppData/Roaming/npm', global: true,
    })
    expect(updatePlan({ runtime: 'codex', install_method: 'npm', executable: '/project/node_modules/@openai/codex/bin/codex.js', target_version: '0.163.0', managed: false })).toBeNull()
  })

  it('refuses unknown install sources and arbitrary target strings', () => {
    expect(updatePlan({ runtime: 'codex', install_method: 'unknown', executable: '/custom/codex', target_version: '0.163.0' })).toBeNull()
    expect(updatePlan({ runtime: 'codex', install_method: 'npm', executable: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', target_version: 'latest; rm -rf /', managed: false })).toBeNull()
  })

  it('tracks executing runtimes so an update can be rejected while that Agent is running', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    expect(source).toContain('executingRunRuntimes')
    expect(source).toContain("agentUpdateBusy")
  })

  it('keeps claimed tasks active while the matching Agent update finishes', async () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('async function waitForAgentUpdateBeforeRun(')
    expect(start, 'Runner 缺少更新等待所有权保护').toBeGreaterThan(-1)
    const end = source.indexOf('\nfunction ', start + 1)
    const activeRunIds = new Set<string>()
    const slot = { agent: 'claude', operation: 'update', state: 'running' }
    const agentInstallSlots = new Map([['claude', slot]])
    const wait = vm.runInNewContext(`${source.slice(start, end)}; waitForAgentUpdateBeforeRun`, { activeRunIds, agentInstallSlots })
    await wait({ run_id: 'run-a', runtime: 'claude' }, async () => {
      expect(activeRunIds.has('run-a')).toBe(true)
      slot.state = 'done'
    })
    expect(activeRunIds.has('run-a')).toBe(true)
  })

  it('does not hold a task for another Agent\'s update, nor for its own install', async () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('async function waitForAgentUpdateBeforeRun(')
    const end = source.indexOf('\nfunction ', start + 1)
    const activeRunIds = new Set<string>()
    const agentInstallSlots = new Map([
      ['qwen', { agent: 'qwen', operation: 'update', state: 'running' }],
      ['codex', { agent: 'codex', operation: 'install', state: 'running' }],
    ])
    const wait = vm.runInNewContext(`${source.slice(start, end)}; waitForAgentUpdateBeforeRun`, { activeRunIds, agentInstallSlots })
    const pause = vi.fn(async () => {})
    await wait({ run_id: 'run-b', runtime: 'claude' }, pause)
    await wait({ run_id: 'run-c', runtime: 'codex' }, pause)
    expect(pause).not.toHaveBeenCalled()
    expect(activeRunIds.has('run-b') && activeRunIds.has('run-c')).toBe(true)
    // Wait only while the same runtime is updating itself; whether other agents' updates finish does not matter
    const own = { agent: 'qwen', operation: 'update', state: 'running' }
    agentInstallSlots.set('qwen', own)
    let pauses = 0
    await wait({ run_id: 'run-d', runtime: 'qwen' }, async () => { if (++pauses === 2) own.state = 'done' })
    expect(pauses).toBe(2)
  })

  it('requires the detected and pending Homebrew OpenCode versions to stay on the target major', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('function agentUpdateVersionAccepted(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\nfunction ', start + 1)
    const accepted = vm.runInNewContext(`${source.slice(start, end)}; agentUpdateVersionAccepted`, { ADAPTERS })
    expect(accepted('opencode', '1.19.3', '1.19.4')).toBe(true)
    expect(accepted('opencode', '1.19.3', '2.0.1')).toBe(false)
    expect(accepted('codex', '0.163.0', '0.164.0')).toBe(true)
  })

  it('runs the low-memory guard before an npm update starts', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('async function prepareAgentUpdate(')
    const updateBlock = source.slice(start, source.indexOf('\n// Memory pre-check before a one-click install', start))
    expect(updateBlock).toContain("plan.kind === 'npm'")
    expect(updateBlock).toContain('runNpmJob(slot, npmDirKey(plan.prefix, plan.global)')
    // The memory gate is in runNpmJob: the same wait loop handles both same-directory queueing and the
    // concurrency threshold on small-memory Linux
    const gate = source.slice(source.indexOf('async function waitForInstallMemory('), source.indexOf('async function runNpmJob('))
    expect(gate).toContain('installMemoryShortfallMb(others)')
    expect(source.slice(source.indexOf('async function runNpmJob('), source.indexOf('function openAgentInstallSlot(')))
      .toContain('waitForInstallMemory(slot, true)')
  })

  it('persists a scrubbed structured failure and keeps it until an authenticated report succeeds', async () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('const AGENT_UPDATE_REPORT_FILE')
    const end = source.indexOf('\nlet runnerDeleting', start)
    expect(start).toBeGreaterThan(-1)
    const files = new Map<string, string>()
    const fs = {
      readFileSync(file: string) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file) },
      mkdirSync() {},
      writeFileSync(file: string, value: string) { files.set(file, String(value)) },
      renameSync(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from) },
      rmSync(file: string) { files.delete(file) },
    }
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true })
    const reporter = vm.runInNewContext(`${source.slice(start, end)}; ({ queueAgentUpdateFailure, flushAgentUpdateFailures })`, {
      path, crypto, fs, RUNNER_STATE_DIR: '/runner-state', process: { pid: 42, platform: 'darwin', arch: 'arm64' },
      os: { release: () => '25.0.0' }, ID: 'abcdef0123456789', SERVER: 'https://opentandem.org',
      authHeaders: { Authorization: 'Bearer runner-key' }, URLSearchParams, AbortSignal, fetch, console,
    }) as { queueAgentUpdateFailure: (...args: string[]) => void; flushAgentUpdateFailures: () => Promise<void> }
    const credential = `ot_123e4567-e89b-12d3-a456-426614174000.abcdef0123456789.${'ab'.repeat(32)}`

    reporter.queueAgentUpdateFailure('opencode', '1.19.3', 'network', `/Users/alice/project alice@example.com ${credential} ${'tail '.repeat(120)}`)
    const queuePath = path.join('/runner-state', 'agent-update-failures.json')
    const queued = JSON.parse(files.get(queuePath)!)
    expect(queued).toHaveLength(1)
    expect(queued[0].step).toBe('agent_update_opencode')
    expect(queued[0].detail.length).toBeLessThanOrEqual(500)
    expect(queued[0].detail).not.toContain('/Users/alice')
    expect(queued[0].detail).not.toContain('alice@example.com')
    expect(queued[0].detail).not.toContain(credential)
    expect(JSON.parse(queued[0].detail)).toMatchObject({ target_version: '1.19.3', reason: 'network' })

    await reporter.flushAgentUpdateFailures()
    expect(files.has(queuePath)).toBe(true)
    await reporter.flushAgentUpdateFailures()
    expect(files.has(queuePath)).toBe(false)
    expect(fetch).toHaveBeenLastCalledWith('https://opentandem.org/api/runner-install/report', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer runner-key' }),
    }))
  })

  it('records the final update failure and retries the durable queue from heartbeat and startup', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    expect(source).toContain("queueAgentUpdateFailure(id, targetVersion, slot.reason || 'other', slot.log)")
    expect(source).toMatch(/async function beat[\s\S]*?void flushAgentUpdateFailures\(\)/)
    expect(source).toMatch(/writeOtWrapper\(\)[\s\S]*?void flushAgentUpdateFailures\(\)/)
  })
})
