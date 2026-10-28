// The downloadable Runner is one file built by buildRunnerBundle: every
// relative import is followed, each module runs in its own scope, and Node
// built-ins inside modules come from process.getBuiltinModule. Self-update
// runs `node --check` and the `self-test` subcommand on a candidate before it
// replaces the running Runner.
import { describe, expect, it, vi } from 'vitest'
import vm from 'node:vm'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRunnerBundle } from '../build/bundle.mjs'
import { buildBundle } from './fixtures/runner-sources.mjs'

function sandbox() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'runner-bundle-'))
}

describe('buildRunnerBundle', () => {
  it('scopes modules, shares one instance per module and keeps entry built-ins as imports', async () => {
    const dir = sandbox()
    try {
      fs.mkdirSync(path.join(dir, 'lib'))
      fs.writeFileSync(path.join(dir, 'lib', 'a.mjs'), "import nodePath from 'node:path'\nconst helper = 'a'\nexport const counter = { n: 0 }\nexport function join(...parts) { counter.n++; return nodePath.join(...parts) + helper }\n")
      fs.writeFileSync(path.join(dir, 'lib', 'b.mjs'), "import { join, counter as shared } from './a.mjs'\nimport data from './data.json' with { type: 'json' }\nconst helper = 'b'\nexport function both() { return [join('x', 'y'), shared.n, data.name, helper] }\n")
      fs.writeFileSync(path.join(dir, 'lib', 'data.json'), '{"name":"golden"}')
      fs.writeFileSync(path.join(dir, 'main.mjs'), "#!/usr/bin/env node\n// header\nimport fs from 'node:fs'\nimport { both } from './lib/b.mjs'\nimport { counter } from './lib/a.mjs'\nconst DAEMON_VERSION = '9.9.9'\nconst RUNNER_BUNDLED = false\nconsole.log(JSON.stringify([...both(), counter.n, typeof fs.readFileSync, DAEMON_VERSION]))\n")
      const bundle = await buildRunnerBundle(path.join(dir, 'main.mjs'), dir)
      expect(bundle.startsWith('#!/usr/bin/env node\n')).toBe(true)
      expect(bundle).toMatch(/^import fs from 'node:fs'$/m)
      expect(bundle).toMatch(/^const DAEMON_VERSION = '9\.9\.9'$/m)
      expect(bundle).not.toMatch(/from '\.\.?\//)
      const out = path.join(dir, 'bundle.mjs')
      fs.writeFileSync(out, bundle)
      const result = JSON.parse(execFileSync(process.execPath, [out], { encoding: 'utf8' }))
      expect(result).toEqual([`x${path.sep}ya`, 1, 'golden', 'b', 1, 'function', '9.9.9'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects imports the bundle cannot honour', async () => {
    const dir = sandbox()
    try {
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export function present() {}\n')
      fs.writeFileSync(path.join(dir, 'missing.mjs'), "import { absent } from './a.mjs'\n")
      await expect(buildRunnerBundle(path.join(dir, 'missing.mjs'), dir)).rejects.toThrow(/does not export/)
      fs.writeFileSync(path.join(dir, 'pkg.mjs'), "import x from 'some-package'\n")
      await expect(buildRunnerBundle(path.join(dir, 'pkg.mjs'), dir)).rejects.toThrow(/node: built-ins/)
      fs.writeFileSync(path.join(dir, 'c1.mjs'), "import { c2 } from './c2.mjs'\nexport const c1 = 1\n")
      fs.writeFileSync(path.join(dir, 'c2.mjs'), "import { c1 } from './c1.mjs'\nexport const c2 = 2\n")
      fs.writeFileSync(path.join(dir, 'cycle.mjs'), "import { c1 } from './c1.mjs'\n")
      await expect(buildRunnerBundle(path.join(dir, 'cycle.mjs'), dir)).rejects.toThrow(/cycle/)
      fs.writeFileSync(path.join(dir, 'b.mjs'), 'const a = 1\nexport { a }\n')
      fs.writeFileSync(path.join(dir, 'reexport.mjs'), "import { a } from './b.mjs'\n")
      await expect(buildRunnerBundle(path.join(dir, 'reexport.mjs'), dir)).rejects.toThrow(/export form/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Runner self-test', () => {
  const credentials = ['--server', 'http://127.0.0.1:9', '--id', 'self-test-machine', '--key', 'ot_self.test.key']

  it('evaluates the whole served bundle and exits 0 before the main loop', async () => {
    const dir = sandbox()
    try {
      const file = path.join(dir, 'machine-daemon.mjs')
      fs.writeFileSync(file, await buildBundle())
      const env = { ...process.env, HOME: dir, USERPROFILE: dir }
      execFileSync(process.execPath, ['--check', file])
      const run = spawnSync(process.execPath, [file, 'self-test', ...credentials], { env, encoding: 'utf8', timeout: 60_000 })
      expect(run.stderr).not.toMatch(/Error/)
      expect(run.status).toBe(0)
      expect(run.stdout).toMatch(/^self-test ok \d+\.\d+\.\d+/m)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails when the candidate throws while loading', async () => {
    const dir = sandbox()
    try {
      const file = path.join(dir, 'machine-daemon.mjs')
      const script = await buildBundle()
      fs.writeFileSync(file, script.replace('\nif (SUBCOMMAND === \'self-test\') {', "\nthrow new Error('candidate broken')\nif (SUBCOMMAND === 'self-test') {"))
      const run = spawnSync(process.execPath, [file, 'self-test', ...credentials], { env: { ...process.env, HOME: dir, USERPROFILE: dir }, encoding: 'utf8', timeout: 60_000 })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toMatch(/candidate broken/)
      expect(fs.existsSync(path.join(dir, '.sophon', 'runner-state'))).toBe(true)
      const stateDir = path.join(dir, '.sophon', 'runner-state')
      const fatal = fs.readdirSync(stateDir).flatMap(scope => fs.readdirSync(path.join(stateDir, scope))).filter(name => name === 'last-fatal.json')
      expect(fatal).toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([[false, 0, 1], [true, 1, 0]])('self-update with RUNNER_BUNDLED=%s downloads %i time(s) and logs a source skip %i time(s)', async (bundled, downloads, skips) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'machine-daemon.mjs'), 'utf8')
    const body = source.slice(source.indexOf('async function maybeUpdateDaemon('), source.indexOf('async function beat('))
    const logs: string[] = []
    const fetch = vi.fn(async () => { throw new Error('offline') })
    const context = vm.createContext({
      RUNNER_BUNDLED: bundled, runnerDeleting: false, daemonUpdateStarting: false, sourceUpdateLogged: '',
      compareDaemonVersions: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }), DAEMON_VERSION: '1.0.0',
      activeRunIds: new Set(), executingRunIds: new Set(), localPreviewManager: { activeSessionCount: () => 0 },
      p2pRunner: { transferBusy: () => false }, updateNotBefore: { version: '2.0.0', at: 0 }, updateRejected: {},
      MANAGED_MODE: '', MANAGED_BY_SUPERVISOR: false, SERVER: 'https://example.test', RUNNER_SCOPE: 'scope',
      withDeadline: (p: Promise<unknown>) => p, fetch, AbortSignal, URL, Date, Math, path, os, process,
      console: { log: (line: string) => logs.push(line), error: () => {}, warn: () => {} },
    })
    // A sandbox script is not a module; the supervisor branch that reads import.meta is not taken here.
    vm.runInContext(body.replaceAll('import.meta.url', 'undefined'), context)
    for (let i = 0; i < 2; i++) await context.maybeUpdateDaemon({ version: '2.0.0', url: '/api/daemon-script' })
    expect(fetch.mock.calls.length).toBe(downloads ? 2 : 0)
    expect(logs.filter(line => line.includes('running from source')).length).toBe(skips)
  })

  it('marks the bundle as bundled and refuses an entry without exactly one marker', async () => {
    const bundle = await buildBundle()
    expect(bundle).toMatch(/^const RUNNER_BUNDLED = true$/m)
    expect(bundle).not.toMatch(/^const RUNNER_BUNDLED = false$/m)
    const dir = sandbox()
    try {
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1\n')
      fs.writeFileSync(path.join(dir, 'main.mjs'), "import { a } from './a.mjs'\nconsole.log(a)\n")
      await expect(buildRunnerBundle(path.join(dir, 'main.mjs'), dir)).rejects.toThrow(/RUNNER_BUNDLED/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('self-update verifies the candidate before it replaces the running file', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'machine-daemon.mjs'), 'utf8')
    const body = source.slice(source.indexOf('async function maybeUpdateDaemon('), source.indexOf('async function beat('))
    expect(body.indexOf('await verifyDaemonCandidate(temp)')).toBeGreaterThan(0)
    expect(body.indexOf('await verifyDaemonCandidate(temp)')).toBeLessThan(body.indexOf('fs.renameSync(temp, target)'))
  })
})
