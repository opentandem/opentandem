import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { EventEmitter, once } from 'node:events'
import { spawn as spawnProcess, execFileSync as inspectProcesses, execFile as execProcess } from 'node:child_process'

import { createAdapterTranslator } from '../core/messages.mjs'

const source = fs.readFileSync(path.resolve(__dirname, '../core/machine-daemon.mjs'), 'utf8')
const codexSource = fs.readFileSync(path.resolve(__dirname, '../adapters/codex/index.mjs'), 'utf8')
const slice = (text: string, start: string, end: string) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`section anchors drifted: ${start}`)
  return text.slice(from, to)
}
const section = (start: string, end: string) => slice(source, start, end)
const codexSection = (start: string, end: string) => slice(codexSource, start, end)
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reuse-test-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const processes: any[] = []
  const signals: any[] = []
  const sandbox: any = { Date, fs, path, crypto, EventEmitter, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, execFileSync: () => '',
    os: { tmpdir: () => dir, homedir: () => dir }, process: { pid: process.pid, cwd: () => dir, env: {} },
    processIdentity: async () => 'owned', runnerVersion: () => 'test', t: createAdapterTranslator(),
    codexSandboxMode: () => 'workspace-write',
    artifactSpoolPath: (run: any) => path.join(dir, run.run_id + '.jsonl'),
    killProcessTree: (pid: number, signal: string) => signals.push([pid, signal]),
    spawn: vi.fn(() => {
      const frames: any[] = []
      const child = Object.assign(new EventEmitter(), { pid: processes.length + 1000, frames,
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: (line: string) => frames.push(JSON.parse(line)) }),
      })
      processes.push(child)
      return child
    }),
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(section('function runtimeStops()', '\nfunction runtimeInstructions(')
    + codexSection('  // Only Runner-owned Codex processes are reusable.', '  /** Codex always runs through app-server JSON-RPC')
    + codexSection('  function codexAppServerHandler(', '  /** A separate codex app-server asks for a title once')
    + section('function mcpArtifactSpool()', 'function mcpTicketTask()'), context)
  const run = (id: string, task = 'task', resume = '') => ({ run_id: id, task_id: task, resume_thread_id: resume })
  const acquire = (r: any, args = ['app-server']) => context.acquireCodexChild(r, 'codex', args, { cwd: dir, env: { HOME: dir } })
  function drive(child: any, r: any, goal?: any) {
    const events: any[] = [], replies: string[] = [], errors: string[] = []
    let done = false, buffer = ''
    const ctx = { goal, runtimeInstructions: r.runtime_instructions, instruction: r.run_id, localImages: [], resumeThreadId: r.resume_thread_id,
      reusedThreadId: child.reusedThreadId, nextRpcId: child.nextRpcId,
      isPreviousTurn: child.isPreviousTurn, rememberTurn: child.rememberTurn,
      cleanupBackground: true, reasoningParts: [], tokens: {}, contextUsage: {},
      pump: { push: (e: any) => events.push(e), finish: async () => {} }, setFullText: (s: string) => replies.push(s),
      setErrorText: (e: string) => errors.push(e), setSession: child.setThread,
      markDone: () => { done = true }, send: (frame: any) => child.stdin.write(JSON.stringify(frame)),
      stop: (discard: boolean) => done && !discard ? child.complete() : child.kill(),
    }
    const handler = context.codexAppServerHandler(ctx)
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop() || ''
      for (const line of lines) if (line) handler.line(JSON.parse(line))
    })
    child.on('close', () => handler.flush())
    child.attach()
    return { events, replies, errors, ctx, handler }
  }
  const send = (raw: any, frame: any) => raw.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
  const respond = (raw: any, method: string, result: any = {}) => {
    const frame = raw.frames.filter((f: any) => f.method === method).at(-1)
    expect(frame, method).toBeTruthy()
    send(raw, { id: frame.id, result })
  }
  const finish = (raw: any, threadId = 'thread', turnId = 'turn-1', text = 'answer') => {
    send(raw, { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text } } })
    send(raw, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
    respond(raw, 'thread/backgroundTerminals/list', { data: [] })
  }
  return { context, processes, signals, run, acquire, drive, send, respond, finish, dir }
}

describe('Runner-owned Codex app-server reuse', () => {
  it('waits for a native answer and returns it to the same request exactly once', async () => {
    vi.useFakeTimers()
    const h = harness(), r = h.run('ask'), a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.respond(raw, 'turn/start', { turn: { id: 'turn-1' } })
    h.send(raw, { id: 91, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn-1', itemId: 'item', questions: [{ id: 'scope', header: 'Scope', question: 'Which?', options: [{ label: 'Desktop', description: 'Inspect desktop' }], isOther: true }] } })
    expect(driven.events.find((e: any) => e.type === 'user_input')?.data).toMatchObject({ key: 'thread:turn-1:item', questions: [{ id: 'scope' }] })
    vi.advanceTimersByTime(30_001)
    h.respond(raw, 'thread/read', { thread: { id: 'thread' } })
    expect(raw.frames.some((f: any) => f.id === 91 && f.result)).toBe(false)
    driven.handler.answer({ key: 'stale', answers: { scope: { answers: ['Desktop'] } } })
    expect(raw.frames.some((f: any) => f.id === 91 && f.result)).toBe(false)
    const answer = { key: 'thread:turn-1:item', answers: { scope: { answers: ['Desktop'] } } }
    driven.handler.answer(answer); driven.handler.answer(answer)
    expect(raw.frames.filter((f: any) => f.id === 91 && f.result)).toEqual([{ jsonrpc: '2.0', id: 91, result: { answers: answer.answers } }])
    expect(raw.frames.filter((f: any) => f.method === 'turn/start')).toHaveLength(1)
    expect(h.signals).toEqual([])
    h.finish(raw)
  })

  it('keeps an empty completed turn distinct from failure and never replays its input', async () => {
    const h = harness(), r = h.run('received callback', 'task', 'thread')
    const a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/resume', { thread: { id: 'thread' } })
    h.finish(raw, 'thread', 'turn-1', '')
    expect(driven.replies).toEqual([])
    expect(driven.errors).toEqual([])
    expect(raw.frames.filter((f: any) => f.method === 'turn/start')).toHaveLength(1)
  })

  it('refreshes resumed developer rules before starting the original user input', async () => {
    const h = harness(), r = { ...h.run('original user text', 'task', 'thread'), runtime_instructions: 'Return result to A.' }
    const a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/resume', { thread: { id: 'thread' } })
    const frame = raw.frames.at(-1)
    expect(frame.method).toBe('thread/inject_items')
    expect(frame.params.items[0]).toMatchObject({ type: 'message', role: 'developer' })
    expect(frame.params.items[0].content[0].text).toContain('Return result to A.')
    expect(raw.frames.some((f: any) => f.method === 'turn/start')).toBe(false)
    h.respond(raw, 'thread/inject_items')
    expect(raw.frames.at(-1)).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: 'original user text' }] } })
    h.finish(raw)
    expect(driven.errors).toEqual([])
  })

  it('does not execute the user turn when instruction refresh times out', async () => {
    vi.useFakeTimers()
    const h = harness(), r = { ...h.run('never execute', 'task', 'thread'), runtime_instructions: 'Current rules.' }
    const a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/resume', { thread: { id: 'thread' } })
    expect(raw.frames.at(-1).method).toBe('thread/inject_items')
    vi.advanceTimersByTime(60_001)
    expect(driven.errors.join(' ')).toContain('thread/inject_items')
    expect(raw.frames.some((f: any) => f.method === 'turn/start')).toBe(false)
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    raw.emit('close', null, 'SIGKILL')
  })

  it('fails closed when Codex cannot refresh resumed developer instructions', async () => {
    const h = harness(), r = { ...h.run('never execute', 'task', 'thread'), runtime_instructions: 'Return result to A.' }
    const a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/resume', { thread: { id: 'thread' } })
    h.send(raw, { id: raw.frames.at(-1).id, error: { message: 'unsupported method' } })
    expect(raw.frames.some((f: any) => f.method === 'turn/start')).toBe(false)
    expect(driven.errors.join(' ')).toContain('could not refresh runtime instructions')
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    raw.emit('close', null, 'SIGKILL')
  })

  it('refreshes rules on a pooled thread before its next turn', async () => {
    const h = harness(), r1 = { ...h.run('first'), runtime_instructions: 'Old delegation.' }, a = await h.acquire(r1)
    h.drive(a, r1); const raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    expect(raw.frames.some((f: any) => f.method === 'thread/inject_items')).toBe(false)
    h.finish(raw); await Promise.resolve(); a.release()
    const r2 = { ...h.run('second', 'task', 'thread'), runtime_instructions: 'Current ordinary request.' }, b = await h.acquire(r2)
    h.drive(b, r2)
    expect(raw.frames.at(-1).method).toBe('thread/inject_items')
    expect(raw.frames.at(-1).params.items[0].content[0].text).toContain('Current ordinary request.')
    expect(raw.frames.filter((f: any) => f.method === 'turn/start')).toHaveLength(1)
    h.respond(raw, 'thread/inject_items'); h.finish(raw, 'thread', 'turn-2'); b.release(); raw.emit('close', 0)
  })

  it.each(['initialize', 'thread/resume', 'turn/start'])('bounds an unresponsive %s without replaying input', async method => {
    vi.useFakeTimers()
    const h = harness(), r = h.run('stalled', 'task', method === 'thread/resume' ? 'thread' : ''), a = await h.acquire(r)
    const driven = h.drive(a, r), raw = h.processes[0]
    if (method !== 'initialize') h.respond(raw, 'initialize')
    if (method === 'turn/start') h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    vi.advanceTimersByTime(60_001)
    expect(driven.errors.join(' ')).toContain('did not respond')
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    expect(h.processes).toHaveLength(1)
    expect(raw.frames.filter((f: any) => f.method === 'turn/start')).toHaveLength(method === 'turn/start' ? 1 : 0)
    raw.emit('close', null, 'SIGKILL')
  })

  it('allows long silent inference when app-server answers read-only liveness requests', async () => {
    vi.useFakeTimers()
    const h = harness(), r = h.run('long'), a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.respond(raw, 'turn/start', { turn: { id: 'turn-1' } })
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(30_000)
      h.respond(raw, 'thread/read', { thread: { id: 'thread' } })
    }
    expect(h.signals).toEqual([]); expect(driven.errors).toEqual([])
    h.finish(raw); a.release()
    const reads = raw.frames.filter((f: any) => f.method === 'thread/read').length
    vi.advanceTimersByTime(120_000)
    expect(raw.frames.filter((f: any) => f.method === 'thread/read')).toHaveLength(reads)
    expect(h.signals).toEqual([])
    raw.emit('close', 0)
  })

  it('retires a live but unresponsive server during a submitted turn', async () => {
    vi.useFakeTimers()
    const h = harness(), r = h.run('hung'), a = await h.acquire(r), driven = h.drive(a, r), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.respond(raw, 'turn/start', { turn: { id: 'turn-1' } })
    vi.advanceTimersByTime(90_001)
    expect(driven.errors.join(' ')).toContain('thread/read')
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    expect(raw.frames.filter((f: any) => f.method === 'turn/start')).toHaveLength(1)
    raw.emit('close', null, 'SIGKILL')
  })

  it('reuses one process/thread while settling each reply and changing only the current artifact spool', async () => {
    const h = harness(), r1 = h.run('first'), a = await h.acquire(r1)
    const first = h.drive(a, r1), raw = h.processes[0], close = vi.fn()
    a.on('close', close)
    expect(raw.frames[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } })
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.finish(raw)
    await Promise.resolve()
    expect(close).toHaveBeenCalledExactlyOnceWith(0, null)
    expect(first.replies).toEqual(['answer'])
    expect(h.signals).toEqual([])
    await expect(h.acquire(h.run('too-early', 'task', 'thread'))).rejects.toThrow('already executing')
    expect(JSON.parse(fs.readFileSync(h.context.codexArtifactContextPath(r1), 'utf8')).spool).toBe('')
    a.release()
    const r2 = h.run('second', 'task', 'thread'), b = await h.acquire(r2)
    const second = h.drive(b, r2)
    expect(h.processes).toHaveLength(1)
    expect(raw.frames.filter((f: any) => f.method === 'initialize')).toHaveLength(1)
    expect(raw.frames.filter((f: any) => f.method === 'thread/start')).toHaveLength(1)
    expect(raw.frames.filter((f: any) => f.method === 'thread/resume')).toHaveLength(0)
    expect(raw.frames.filter((f: any) => f.method === 'turn/start').map((f: any) => f.params.input[0].text)).toEqual(['first', 'second'])
    const ids = raw.frames.filter((f: any) => f.id).map((f: any) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    h.send(raw, { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
    h.send(raw, { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'stale' } } })
    expect(second.replies).toEqual([])
    h.context.process.env.SOPHON_ARTIFACT_CONTEXT = h.context.codexArtifactContextPath(r2)
    expect(h.context.mcpArtifactSpool()).toBe(path.join(h.dir, 'second.jsonl'))
    h.finish(raw, 'thread', 'turn-2', 'second answer')
    expect(second.replies).toEqual(['second answer'])
    expect(h.context.mcpArtifactSpool()).toBe('')
    b.release()
    raw.emit('close', 0)
  })

  it('keeps different tasks isolated and rejects concurrent turns for one task', async () => {
    const h = harness(), a = await h.acquire(h.run('a', 'task-a')), b = await h.acquire(h.run('b', 'task-b'))
    expect(a.pid).not.toBe(b.pid)
    await expect(h.acquire(h.run('c', 'task-a'))).rejects.toThrow('already executing')
    a.on('error', () => {}); b.on('error', () => {})
    a.attach(); b.attach()
    for (const raw of h.processes) raw.emit('close', 1)
  })

  it.each(['model', 'permission', 'directory', 'thread'])('waits for old process exit when %s changes', async change => {
    const h = harness(), a = await h.acquire(h.run('first'))
    a.setThread('thread'); a.attach(); a.complete(); await Promise.resolve(); a.release()
    const next = h.acquire(h.run('next', 'task', change === 'thread' ? 'another' : 'thread'), ['app-server', change])
    // The config fingerprint is read asynchronously, so the retirement lands a tick later.
    await vi.waitFor(() => expect(h.signals).toContainEqual([a.pid, 'SIGTERM']))
    expect(h.processes).toHaveLength(1)
    h.processes[0].emit('close', null, 'SIGTERM')
    const b = await next
    expect(h.processes).toHaveLength(2)
    expect(b.reusedThreadId).toBe('')
    const driven = h.drive(b, h.run('next', 'task', 'thread'))
    h.respond(h.processes[1], 'initialize')
    expect(h.processes[1].frames.at(-1).method).toBe('thread/resume')
    expect(driven.replies).toEqual([])
    h.processes[1].emit('close', 1)
  })

  it('retains the acquisition lock across the old close event and replacement spawn', async () => {
    const h = harness(), a = await h.acquire(h.run('first'))
    a.setThread('thread'); a.attach(); a.complete(); await Promise.resolve(); a.release()
    const replacement = h.acquire(h.run('second', 'task', 'thread'), ['new-model'])
    h.processes[0].emit('close', 0)
    await expect(h.acquire(h.run('third', 'task', 'thread'), ['new-model'])).rejects.toThrow('already executing')
    const b = await replacement
    expect(h.processes).toHaveLength(2)
    b.attach(); h.processes[1].emit('close', 0)
  })

  it.each(['config.toml', 'auth.json'])('retires the old process after %s changes on disk', async file => {
    const h = harness(), a = await h.acquire(h.run('first'))
    a.setThread('thread'); a.attach(); a.complete(); await Promise.resolve(); a.release()
    fs.mkdirSync(path.join(h.dir, '.codex'))
    fs.writeFileSync(path.join(h.dir, '.codex', file), 'local fixture')
    const replacement = h.acquire(h.run('second', 'task', 'thread'))
    await vi.waitFor(() => expect(h.signals).toContainEqual([a.pid, 'SIGTERM']))
    h.processes[0].emit('close', 0)
    const b = await replacement
    expect(h.processes).toHaveLength(2)
    b.attach(); h.processes[1].emit('close', 0)
  })

  it('retires idle processes after five minutes and resumes the native thread next time', async () => {
    vi.useFakeTimers()
    const h = harness(), a = await h.acquire(h.run('first'))
    a.setThread('thread'); a.attach(); a.complete(); await Promise.resolve(); a.release()
    vi.advanceTimersByTime(5 * 60_000)
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    h.processes[0].emit('close', 0)
    const b = await h.acquire(h.run('next', 'task', 'thread'))
    h.drive(b, h.run('next', 'task', 'thread')); h.respond(h.processes[1], 'initialize')
    expect(h.processes[1].frames.at(-1)).toMatchObject({ method: 'thread/resume', params: { threadId: 'thread' } })
    h.processes[1].emit('close', 0)
  })

  it('kills cancelled or crashed groups without creating a replacement or replaying input', async () => {
    const h = harness(), a = await h.acquire(h.run('first'))
    h.drive(a, h.run('first')); h.respond(h.processes[0], 'initialize'); h.respond(h.processes[0], 'thread/start', { thread: { id: 'thread' } })
    a.kill()
    h.processes[0].emit('close', null, 'SIGKILL')
    // 0.87.0: killing the process group at the end goes through the system process lane (async); the process pool slot is only freed after that cleanup finishes
    await vi.waitFor(() => expect(h.signals).toEqual([[a.pid, 'SIGTERM'], [a.pid, 'SIGKILL']]))
    expect(h.processes).toHaveLength(1)
    await vi.waitFor(() => expect(h.context.codexSessions().size).toBe(0))
  })

  it('terminates outstanding exec sessions before completing the logical run', async () => {
    const h = harness(), a = await h.acquire(h.run('first')), close = vi.fn()
    h.drive(a, h.run('first')); a.on('close', close)
    const raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.send(raw, { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
    h.respond(raw, 'thread/backgroundTerminals/list', { data: [{ processId: '42' }] })
    expect(raw.frames.at(-1)).toMatchObject({ method: 'thread/backgroundTerminals/terminate', params: { threadId: 'thread', processId: '42' } })
    expect(close).not.toHaveBeenCalled()
    h.respond(raw, 'thread/backgroundTerminals/terminate', { terminated: true })
    h.respond(raw, 'thread/backgroundTerminals/list', { data: [] })
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    a.release(); raw.emit('close', 0)
  })

  it('retires the complete process after child-thread activity while preserving the root answer', async () => {
    const h = harness(), a = await h.acquire(h.run('first'))
    const driven = h.drive(a, h.run('first')), raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.send(raw, { method: 'thread/started', params: { thread: { id: 'child' } } })
    h.send(raw, { method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } })
    expect(h.signals).toEqual([])
    h.send(raw, { method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: 'root answer' } } })
    h.send(raw, { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } })
    expect(driven.replies).toEqual(['root answer'])
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    raw.emit('close', null, 'SIGTERM')
    await vi.waitFor(() => expect(h.context.codexSessions().size).toBe(0))
  })

  it('falls back to process termination if background cleanup stalls', async () => {
    vi.useFakeTimers()
    const h = harness(), a = await h.acquire(h.run('first'))
    h.drive(a, h.run('first')); const raw = h.processes[0]
    h.respond(raw, 'initialize'); h.respond(raw, 'thread/start', { thread: { id: 'thread' } })
    h.send(raw, { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } })
    vi.advanceTimersByTime(5_000)
    expect(h.signals).toContainEqual([a.pid, 'SIGTERM'])
    raw.emit('close', 0)
  })

  it('retires a matching idle session before compaction and refuses an active one', async () => {
    const h = harness(), a = await h.acquire(h.run('first'))
    a.setThread('thread'); a.attach()
    await expect(h.context.closeCodexSessions('thread')).rejects.toThrow('still executing')
    a.complete(); await Promise.resolve(); a.release()
    let retired = false
    const retiring = h.context.closeCodexSessions('thread').then(() => { retired = true })
    await Promise.resolve(); expect(retired).toBe(false)
    h.processes[0].emit('close', 0); await retiring
    expect(retired).toBe(true)
  })
})

describe('Codex independently grouped descendants', () => {
  it('reaps only observed descendants after their parent exits, without touching another task or recycled PIDs', async () => {
    const h = harness(), killed: any[] = []
    const row = (parent: number, identity: string) => ({ parent, started: identity, identity })
    let snapshot = new Map([
      [100, row(1, 'root-a')], [110, row(100, 'exec-a')], [111, row(110, 'worker-a')],
      [200, row(1, 'root-b')], [210, row(200, 'exec-b')],
    ])
    h.context.codexProcessSnapshot = () => snapshot
    h.context.process.kill = (pid: number, signal: string) => killed.push([pid, signal])
    const a = h.context.trackCodexProcesses(100), b = h.context.trackCodexProcesses(200)
    await a.capture(); await b.capture()
    // The app-server died. Its exec session was reparented and its sibling
    // session is still active; a recycled PID now owns an unrelated child.
    snapshot = new Map([
      [110, row(1, 'recycled')], [112, row(110, 'unrelated')], [111, row(1, 'worker-a')],
      [200, row(1, 'root-b')], [210, row(200, 'exec-b')],
    ])
    await a.signal('SIGKILL')
    expect(killed).toEqual([[111, 'SIGKILL']])
    await b.signal('SIGTERM')
    expect(killed).toEqual([[111, 'SIGKILL'], [210, 'SIGTERM']])
  })

  it('preserves observed ancestry across a failed scan and only kills an orphan after a fresh successful scan', async () => {
    const h = harness(), killed: any[] = []
    const row = (parent: number, identity: string) => ({ parent, started: identity, identity })
    let snapshot: Map<number, any> | null = new Map([[100, row(1, 'root')], [110, row(100, 'owned-exec')]])
    h.context.codexProcessSnapshot = () => snapshot
    h.context.process.kill = (pid: number, signal: string) => killed.push([pid, signal])
    const tracker = h.context.trackCodexProcesses(100)
    await tracker.capture()
    const cached = h.context.__openTandemCodexProcessSnapshot
    snapshot = null // e.g. ps timeout; known descendants must survive this gap.
    expect(await tracker.capture()).toBeNull()
    expect(h.context.__openTandemCodexProcessSnapshot).toBe(cached)
    await tracker.signal('SIGKILL')
    expect(killed).toEqual([]) // A cached PID identity is not enough to signal.
    snapshot = new Map([[110, row(1, 'owned-exec')]]) // Root died during the failed scan.
    await tracker.signal('SIGKILL')
    expect(killed).toEqual([[110, 'SIGKILL']])
  })

  it('returns null for a failed process inspection instead of an empty successful snapshot', async () => {
    const h = harness()
    h.context.systemExec = async () => ({ error: new Error('process inspection timed out'), stdout: '' })
    expect(await h.context.codexProcessSnapshot()).toBeNull()
  })

  it('does not let an older scan that finishes late drop descendants a newer scan recorded', async () => {
    const h = harness(), killed: any[] = []
    const row = (parent: number, identity: string) => ({ parent, started: identity, identity })
    const pending: ((rows: Map<number, any>) => void)[] = []
    h.context.codexProcessSnapshot = () => new Promise(resolve => pending.push(resolve))
    h.context.process.kill = (pid: number, signal: string) => killed.push([pid, signal])
    const tracker = h.context.trackCodexProcesses(100)
    const older = tracker.capture(), newer = tracker.capture()
    pending[1](new Map([[100, row(1, 'root')], [110, row(100, 'exec')]]))
    await newer
    pending[0](new Map([[100, row(1, 'root')]])) // Taken before exec started.
    await older
    h.context.codexProcessSnapshot = async () => new Map([[110, row(1, 'exec')]]) // Root died; exec reparented.
    await tracker.signal('SIGKILL')
    expect(killed).toEqual([[110, 'SIGKILL']])
  })

  it.each(['darwin', 'win32'])('shares periodic snapshots between owners on %s but forces fresh signal and event scans', async platform => {
    vi.useFakeTimers()
    const h = harness(), scan = vi.fn(() => new Map())
    h.context.process.platform = platform
    h.context.codexProcessSnapshot = scan
    const a = h.context.trackCodexProcesses(100), b = h.context.trackCodexProcesses(200)
    a.start(); b.start()
    expect(scan).toHaveBeenCalledTimes(2) // Each start deliberately forces inspection.
    await vi.advanceTimersByTimeAsync(0) // Let the forced scans land.
    if (platform === 'win32') {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(scan).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
    } else await vi.advanceTimersByTimeAsync(1_000)
    expect(scan).toHaveBeenCalledTimes(3) // Both periodic owners share one scan.
    a.signal('SIGKILL')
    expect(scan).toHaveBeenCalledTimes(4) // Same timestamp, but identity must be fresh.
    b.capture()
    expect(scan).toHaveBeenCalledTimes(5) // An item/started also bypasses the cache.
    a.pause(); b.pause()
  })

  it('stops periodic process inspection when a run becomes idle', async () => {
    vi.useFakeTimers()
    const h = harness(), scan = vi.fn(() => new Map())
    h.context.codexProcessSnapshot = scan
    const tracker = h.context.trackCodexProcesses(100)
    tracker.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(scan).toHaveBeenCalledTimes(2)
    tracker.pause()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scan).toHaveBeenCalledTimes(2)
  })
})

// No provider or database is involved: these are temporary OS processes that
// reproduce Codex exec's separate process group and post-crash reparenting.
it.each([
  ['English', '  501     1 Mon Oct 26 13:51:59 2026\n  777   501 Mon Oct 26 13:52:00 2026\n'],
  ['Chinese', '  501     1 五 10月/23 14:42:51 2026\n  777   501 五 10月/23 14:42:52 2026\n'],
])('reads the process table whatever the %s locale prints for start times', async (_locale, stdout) => {
  const sandbox = vm.createContext({ process: { platform: 'darwin' }, systemExec: async () => ({ error: null, stdout }), Date, setInterval, clearInterval })
  vm.runInContext(codexSection('  async function codexProcessSnapshot()', '  async function acquireCodexChild('), sandbox)
  const tracker = sandbox.trackCodexProcesses(501)
  const rows = await tracker.capture()
  expect(rows.get(777)).toMatchObject({ parent: 501 })
  expect(rows.get(777).identity).toBe(stdout.split('\n')[1].replace(/^\s*777\s+501\s+/, ''))
})

it.skipIf(process.platform === 'win32')('kills a real detached exec descendant after its app-server parent is SIGKILLed', async () => {
  const systemExec = (file: string, args: string[], { timeout = 10_000 } = {}) => new Promise(resolve =>
    execProcess(file, args, { encoding: 'utf8', timeout }, (error, stdout) => resolve({ error, stdout: String(stdout ?? '') })))
  const sandbox = vm.createContext({ process, systemExec, Date, setInterval, clearInterval })
  vm.runInContext(codexSection('  async function codexProcessSnapshot()', '  async function acquireCodexChild('), sandbox)
  const childCode = 'setInterval(() => {}, 1000)'
  const rootCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}); child.unref(); console.log(child.pid); setInterval(()=>{},1000)`
  const root = spawnProcess(process.execPath, ['-e', rootCode], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const unrelated = spawnProcess(process.execPath, ['-e', childCode], { detached: true, stdio: 'ignore' })
  const tracker = sandbox.trackCodexProcesses(root.pid)
  let childPid = 0
  const exists = (pid: number) => {
    try {
      const state = inspectProcesses('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return !!state && !state.startsWith('Z')
    } catch { return false }
  }
  try {
    tracker.start()
    const [data] = await once(root.stdout!, 'data')
    childPid = Number(data.toString().trim())
    expect(childPid).toBeGreaterThan(1)
    expect(Number(inspectProcesses('ps', ['-p', String(childPid), '-o', 'pgid='], { encoding: 'utf8' }).trim())).toBe(childPid)
    await tracker.capture()
    const exited = once(root, 'exit')
    root.kill('SIGKILL')
    await exited
    expect(exists(childPid)).toBe(true)
    tracker.pause()
    await tracker.signal('SIGKILL')
    await vi.waitFor(() => expect(exists(childPid)).toBe(false), { timeout: 2_000 })
    expect(exists(unrelated.pid!)).toBe(true)
  } finally {
    tracker.pause()
    await tracker.signal('SIGKILL')
    root.kill('SIGKILL')
    unrelated.kill('SIGKILL')
  }
})
