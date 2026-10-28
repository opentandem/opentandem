import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Worker, SHARE_ENV } from 'node:worker_threads'
import { isPortableAbsolutePath, portableResolve } from '../../core/artifact-refs.mjs'
import { createAdapterTranslator, ADAPTER_MESSAGES_ZH } from '../../core/messages.mjs'
const source = fs.readFileSync(new URL('../../core/machine-daemon.mjs', import.meta.url), 'utf8')
const fn = name => { const at = source.indexOf(`\nfunction ${name}(`) + 1; return source.slice(at, source.indexOf('\n}\n', at) + 3) }
// The directory lane also resolves P2P paths: its source embeds these helpers by name.
const pathHelpers = ['artifactRoots', 'resolveArtifactAbsExact', 'resolveArtifactCandidate'].map(fn).join('\n')
const section = pathHelpers + source.slice(source.indexOf('function listDirs('), source.indexOf('// Manual compaction:'))
function load(WorkerImpl = Worker) {
  return vm.runInNewContext(section + '\nObject.assign(runDirectoryCommand, { status: threadLaneStatus })', { fs, os, path, Worker: WorkerImpl, SHARE_ENV, process, console, setTimeout, clearTimeout, isPortableAbsolutePath, portableResolve, createAdapterTranslator, ADAPTER_MESSAGES_ZH })
}
test('directory thread returns the real filesystem listing and preserves missing-path errors', async () => {
  const run = load()
  const result = await run({ type: 'dirs', dir: os.homedir() })
  assert.equal(result.current, os.homedir())
  assert.ok(Array.isArray(result.dirs))
  const missing = path.join(os.tmpdir(), `opentandem-absent-${process.pid}-${Date.now()}`)
  assert.equal((await run({ type: 'dirs', dir: missing })).error_code, 'ENOENT')
  assert.equal((await run({ type: 'dir_stat', dir: missing })).exists, false)
})
test('a hung thread times out without blocking heartbeat or another directory request', async () => {
  let hung, first = true, ticks = 0
  const run = load(class extends Worker {
    constructor(src, opts) {
      // The first thread never answers, like a readdir stuck behind an OS prompt.
      super(first ? 'setInterval(() => {}, 1000)' : src, opts)
      if (first) { first = false; hung = this; this.terminated = false; const t = this.terminate.bind(this); this.terminate = () => { this.terminated = true; return t() } }
    }
  })
  const heartbeat = setInterval(() => ticks++, 10)
  try {
    const [blocked, normal] = await Promise.all([
      run({ type: 'dirs', dir: os.homedir() }, 250),
      new Promise(resolve => setTimeout(resolve, 300)).then(() => run({ type: 'dirs', dir: os.tmpdir() })),
    ])
    assert.equal(blocked.error_code, 'DIRECTORY_READ_TIMEOUT')
    assert.ok(Array.isArray(normal.dirs))
    assert.ok(ticks >= 3)
    assert.equal(hung.terminated, true)
  } finally { clearInterval(heartbeat); await hung?.terminate() }
})
test('OS access denial survives the thread protocol for localized permission guidance', async () => {
  const run = load(class extends Worker {
    constructor(src, opts) {
      super("require('node:fs').readdirSync = () => { throw Object.assign(new Error('denied'), {code:'EACCES'}) };\n" + src, opts)
    }
  })
  const result = await run({ type: 'dirs', dir: os.homedir() })
  assert.equal(result.error_code, 'EACCES')
  assert.equal(result.error, 'denied')
})
test('a job queued behind a stalled one moves to a fresh thread instead of timing out with it', async () => {
  let first = true, hung
  const run = load(class extends Worker {
    constructor(src, opts) {
      super(first ? 'setInterval(() => {}, 1000)' : src, opts)
      if (first) { first = false; hung = this }
    }
  })
  try {
    const [stalled, queued] = await Promise.all([run({ type: 'dirs', dir: os.homedir() }, 200), run({ type: 'dirs', dir: os.tmpdir() })])
    assert.equal(stalled.error_code, 'DIRECTORY_READ_TIMEOUT')
    assert.ok(Array.isArray(queued.dirs))
    assert.equal(run.status().directory.timeouts, 1)
    assert.equal(run.status().directory.last_stall.job, 'dirs')
  } finally { await hung?.terminate() }
})
test('more than three threads stuck in the OS pause the lane instead of piling up', async () => {
  const stuck = []
  const run = load(class extends Worker {
    constructor(src, opts) {
      super('setInterval(() => {}, 1000)', opts)
      // A thread inside a blocking system call ignores terminate(): it never emits exit.
      this.reallyTerminate = super.terminate.bind(this)
      this.terminate = () => Promise.resolve()
      stuck.push(this)
    }
  })
  try {
    for (let i = 0; i < 4; i++) assert.equal((await run({ type: 'dirs', dir: os.homedir() }, 50)).error_code, 'DIRECTORY_READ_TIMEOUT')
    assert.equal(run.status().directory.stuck, 4)
    assert.ok(run.status().directory.paused_until)
    const started = Date.now()
    const paused = await run({ type: 'dirs', dir: os.homedir() }, 5_000)
    assert.equal(paused.error_code, 'DIRECTORY_READ_TIMEOUT')
    assert.match(paused.error, /paused/)
    assert.ok(Date.now() - started < 1_000)
    assert.equal(stuck.length, 4)
  } finally { await Promise.all(stuck.map(w => w.reallyTerminate())) }
})
test('a slow job is set aside after a second so the next folder opens on a fresh thread; its late answer still arrives', async () => {
  let first = true, slow
  const run = load(class extends Worker {
    constructor(src, opts) {
      // The first thread answers after 2.5 s, like a network folder that is slow but reachable.
      super(first ? "const { parentPort } = require('node:worker_threads'); parentPort.on('message', ({ id }) => setTimeout(() => parentPort.postMessage({ id, result: { late: true } }), 2500))" : src, opts)
      if (first) { first = false; slow = this }
    }
  })
  try {
    const started = Date.now()
    const late = run({ type: 'dirs', dir: os.homedir() })
    const next = await run({ type: 'dirs', dir: os.tmpdir() })
    assert.ok(Array.isArray(next.dirs))
    assert.ok(Date.now() - started < 2_000, `next folder took ${Date.now() - started} ms`)
    assert.equal(run.status().directory.aside, 1)
    assert.deepEqual(await late, { late: true })
    assert.equal(run.status().directory.aside, 0)
    assert.equal(run.status().directory.timeouts, 0)
  } finally { await slow?.terminate() }
})
test('only one job is set aside at a time; a third waits for a free thread', async () => {
  const hung = []
  const run = load(class extends Worker {
    constructor(src, opts) {
      super(hung.length < 2 ? 'setInterval(() => {}, 1000)' : src, opts)
      if (hung.length < 2) hung.push(this)
    }
  })
  try {
    const started = Date.now()
    const a = run({ type: 'dirs', dir: os.homedir() }, 3_000)
    const b = run({ type: 'dirs', dir: os.homedir() }, 3_000)
    const c = run({ type: 'dirs', dir: os.tmpdir() }, 3_000)
    // a is set aside after 1 s and b starts on the second (hung) thread; c must wait for a to time out.
    const answered = await c
    assert.ok(Array.isArray(answered.dirs))
    assert.ok(Date.now() - started >= 2_900, `c answered after ${Date.now() - started} ms`)
    assert.equal(hung.length, 2)
    assert.equal((await a).error_code, 'DIRECTORY_READ_TIMEOUT')
    assert.equal((await b).error_code, 'DIRECTORY_READ_TIMEOUT')
  } finally { await Promise.all(hung.map(w => w.terminate())) }
})
