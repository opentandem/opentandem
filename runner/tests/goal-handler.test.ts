// Unit tests for the daemon-side state machine of codex goal mode: codexAppServerArgs / codexAppServerHandler are extracted
// from the Codex adapter (runner/adapters/codex/index.mjs) and driven with a stub ctx through a full sequence of JSON-RPC frames,
// verifying handshake order, event translation, goal terminal-state handling and the default token budget.
// The frame shapes were verified by a real-machine probe (2026-09-25); what is locked here is the daemon's translation logic.
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createAdapterTranslator } from '../core/messages.mjs'

const source = fs.readFileSync(path.resolve(__dirname, '../adapters/codex/index.mjs'), 'utf8')
const section = (start: string, end: string) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`section anchors drifted: ${start.slice(0, 40)}`)
  return source.slice(from, to)
}

function makeContext() {
  const timers: { ms: number; fn: () => void }[] = []
  const context = vm.createContext({
    runnerVersion: () => '0.50.0-test',
    t: createAdapterTranslator(),
    runtimeInstructions: () => '规则文本',
    toolServerSpec: () => ({ command: 'node', args: ['mcp.mjs'], env: { SOPHON_X: '1' } }),
    setTimeout: ((fn: () => void, ms: number) => { timers.push({ ms, fn }); return 1 }) as unknown as typeof setTimeout,
    clearTimeout: () => {},
  })
  vm.runInContext(
    section('  function codexSandboxMode(', '  /** codex app-server → StreamEvents')
    + section('  function codexAppServerHandler(', '  /** A separate codex app-server asks for a title once')
    + '\nglobalThis.codexAppServerArgs = codexAppServerArgs; globalThis.codexAppServerHandler = codexAppServerHandler',
    context,
  )
  return { context, timers }
}

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const frames: any[] = []
  const events: any[] = []
  return {
    frames, events,
    pump: { push: (e: any) => events.push(e) },
    reasoningParts: [] as any[],
    tokens: { input: 0, output: 0 },
    contextUsage: {},
    instruction: '开始执行目标',
    localImages: [],
    goal: { objective: '把测试修绿' },
    resumeThreadId: '',
    send: (o: any) => frames.push(o),
    stop: vi.fn(),
    markDone: vi.fn(),
    setFullText: vi.fn(),
    setErrorText: vi.fn(),
    setSession: vi.fn(),
    ...overrides,
  } as any
}

const resp = (id: number, result: unknown) => ({ id, result })
const notify = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: 'th-1', ...params } })

describe('codexAppServerArgs', () => {
  it('spawns app-server with -c overrides and keeps stdin open', () => {
    const { context } = makeContext()
    const args = (context as any).codexAppServerArgs({ exec_mode: 'standard', model: 'gpt-5.6-terra', reasoning_effort: 'low' })
    expect(args.argv[0]).toBe('app-server')
    expect(args.argv).toContain('-c')
    expect(args.argv.join(' ')).toContain('sandbox_mode="workspace-write"')
    expect(args.argv.join(' ')).toContain('model="gpt-5.6-terra"')
    expect(args.argv.join(' ')).toContain('model_reasoning_effort="low"')
    expect(args.argv.join(' ')).toContain('developer_instructions="规则文本"')
    expect(args.argv.join(' ')).toContain('mcp_servers.opentandem.default_tools_approval_mode="approve"')
    expect(args.argv.join(' ')).toContain('mcp_servers.opentandem.env.SOPHON_X="1"')
    expect(args.stdinText).toBe('')
    expect(args.keepStdinOpen).toBe(true)
  })

  it('maps exec modes to codex sandbox modes', () => {
    const { context } = makeContext()
    const goalArgs = (exec_mode: string) => (context as any).codexAppServerArgs({ exec_mode }).argv.join(' ')
    expect(goalArgs('readonly')).toContain('sandbox_mode="read-only"')
    expect(goalArgs('yolo')).toContain('sandbox_mode="danger-full-access"')
    expect(goalArgs('full')).toContain('sandbox_mode="danger-full-access"')
  })
})

describe('codexAppServerHandler happy path', () => {
  it('drives initialize → thread/start → goal/clear → goal/set → turn/start and translates events', () => {
    const { context, timers } = makeContext()
    const ctx = makeCtx()
    const handler = (context as any).codexAppServerHandler(ctx)
    const line = (m: any) => handler.line(m)

    // the initialize request is sent on construction (frames[0]); id1 initialize -> initialized + thread/start
    expect(ctx.frames[0]).toMatchObject({ id: 1, method: 'initialize' })
    line(resp(1, {}))
    expect(ctx.frames[1]).toMatchObject({ method: 'initialized' })
    expect(ctx.frames[2]).toMatchObject({ id: 2, method: 'thread/start' })

    // id2 thread/start → setSession + goal/clear
    line(resp(2, { thread: { id: 'th-1' } }))
    expect(ctx.setSession).toHaveBeenCalledWith('th-1')
    expect(ctx.frames[3]).toMatchObject({ id: 3, method: 'thread/goal/clear', params: { threadId: 'th-1' } })

    // id3 clear -> goal/set (token budget defaults to 2M)
    line(resp(3, {}))
    expect(ctx.frames[4]).toMatchObject({ id: 4, method: 'thread/goal/set', params: { threadId: 'th-1', objective: '把测试修绿', tokenBudget: 2_000_000 } })

    // id4 goal/set active -> turn/start, and the first instruction carries no /goal prefix
    line(resp(4, { goal: { status: 'active' } }))
    expect(ctx.frames[5]).toMatchObject({ id: 5, method: 'turn/start', params: { threadId: 'th-1', input: [{ type: 'text', text: '开始执行目标' }] } })

    // event translation: command -> tool_event; commentary -> reasoning; final_answer -> content_delta
    line(notify('item/started', { item: { type: 'commandExecution', id: 'cmd1', command: 'npm test' } }))
    line(notify('item/completed', { item: { type: 'commandExecution', id: 'cmd1', command: 'npm test', status: 'completed', aggregatedOutput: 'ok' } }))
    line(notify('item/completed', { item: { type: 'agentMessage', id: 'a1', text: '先跑一遍看看', phase: 'commentary' } }))
    line(notify('item/completed', { item: { type: 'agentMessage', id: 'a2', text: '第一轮结果', phase: 'final_answer' } }))
    expect(ctx.events.map((e: any) => e.type)).toEqual(['tool_event', 'tool_event', 'reasoning_delta', 'content_delta'])
    expect(ctx.events[1].data).toMatchObject({ id: 'cmd1', status: 'done', output: 'ok' })
    expect(ctx.setFullText).toHaveBeenCalledWith('第一轮结果')

    // multi-turn continuation: the second final_answer is appended rather than overwriting
    line(notify('item/completed', { item: { type: 'agentMessage', id: 'a3', text: '第二轮结果', phase: 'final_answer' } }))
    expect(ctx.setFullText).toHaveBeenLastCalledWith('第一轮结果\n\n第二轮结果')

    // token usage
    line(notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 7 }, last: { inputTokens: 100, outputTokens: 7 } } }))
    expect(ctx.tokens).toEqual({ input: 100, output: 7 })

    // goal complete: it must not stop on a timer; it must wait for the final reply and the main turn to complete
    line(notify('thread/goal/updated', { goal: { status: 'complete' } }))
    expect(ctx.stop).not.toHaveBeenCalled()
    expect(ctx.markDone).not.toHaveBeenCalled()
    // Since 10d70da96d each protocol request has its own 60-second response timeout; what is locked here is "never stop the goal on a timer", ruling out only that kind
    expect(timers.filter(t => t.ms !== 60_000)).toEqual([])
    line(notify('item/completed', { item: { type: 'agentMessage', text: '目标最终结果', phase: 'final_answer' } }))
    expect(ctx.setFullText).toHaveBeenLastCalledWith('第一轮结果\n\n第二轮结果\n\n目标最终结果')
    line(notify('turn/completed', { turn: { status: 'completed' } }))
    expect(ctx.markDone).toHaveBeenCalledTimes(1)
    expect(ctx.stop).toHaveBeenCalledTimes(1)
  })
})

describe('codexAppServerHandler failure paths', () => {
  it('keeps a resumed completed goal alive until the new turn returns its final answer', () => {
    const { context, timers } = makeContext()
    const ctx = makeCtx({ resumeThreadId: 'th-1', goal: undefined })
    const handler = (context as any).codexAppServerHandler(ctx)
    handler.line(resp(1, {}))
    // resume replays the old goal's complete, which must not be used to stop this resumed run
    handler.line(notify('thread/goal/updated', { goal: { status: 'complete' } }))
    handler.line(resp(2, { thread: { id: 'th-1' } }))
    expect(ctx.frames.at(-1)).toMatchObject({ method: 'turn/start' })
    // Since 10d70da96d each protocol request has its own 60-second response timeout; what is locked here is "never stop the goal on a timer", ruling out only that kind
    expect(timers.filter(t => t.ms !== 60_000)).toEqual([])
    expect(ctx.stop).not.toHaveBeenCalled()
    expect(ctx.markDone).not.toHaveBeenCalled()
    handler.line(notify('item/completed', { item: { type: 'agentMessage', text: '已有发布结果，未重复发布', phase: 'final_answer' } }))
    handler.line(notify('turn/completed', { turn: { status: 'completed' } }))
    expect(ctx.setFullText).toHaveBeenCalledWith('已有发布结果，未重复发布')
    expect(ctx.markDone).toHaveBeenCalledTimes(1)
    expect(ctx.stop).toHaveBeenCalledTimes(1)
  })

  it('resumes an existing thread with excludeTurns', () => {
    const { context } = makeContext()
    const ctx = makeCtx({ resumeThreadId: 'th-old' })
    const handler = (context as any).codexAppServerHandler(ctx)
    expect(ctx.frames[0]).toMatchObject({ id: 1, method: 'initialize' })
    handler.line(resp(1, {}))
    expect(ctx.frames[2]).toMatchObject({ id: 2, method: 'thread/resume', params: { threadId: 'th-old', excludeTurns: true } })
  })

  it('stops with a readable error when goal/set is rejected', () => {
    const { context } = makeContext()
    const ctx = makeCtx()
    const handler = (context as any).codexAppServerHandler(ctx)
    handler.line(resp(1, {}))
    handler.line(resp(2, { thread: { id: 'th-1' } }))
    handler.line(resp(3, {}))
    handler.line({ id: 4, error: { message: 'objective too long' } })
    expect(ctx.setErrorText).toHaveBeenCalledWith(expect.stringContaining('objective too long'))
    expect(ctx.stop).toHaveBeenCalledTimes(1)
    expect(ctx.frames.some((f: any) => f.method === 'turn/start')).toBe(false)
  })

  it('treats budgetLimited as terminal failure without marking success', () => {
    const { context, timers } = makeContext()
    const ctx = makeCtx()
    const handler = (context as any).codexAppServerHandler(ctx)
    handler.line(resp(1, {}))
    handler.line(resp(2, { thread: { id: 'th-1' } }))
    handler.line(resp(3, {}))
    handler.line(resp(4, { goal: { status: 'active' } }))
    handler.line(notify('thread/goal/updated', { goal: { status: 'budgetLimited' } }))
    expect(ctx.setErrorText).toHaveBeenCalledWith(expect.stringContaining('预算'))
    timers.at(-1)!.fn()
    expect(ctx.markDone).not.toHaveBeenCalled()
    expect(ctx.stop).toHaveBeenCalledTimes(1)
  })
})
