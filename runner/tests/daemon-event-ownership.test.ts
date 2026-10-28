import { describe, expect, it } from 'vitest'
import { stubAdapters } from './fixtures/adapter-context'

// Parsers live in each runtime's adapter (runner/adapters/); the matching adapter is found by the original function name.
const ADAPTERS = stubAdapters()
const ADAPTER_OF: Record<string, string> = {
  codexAppServerHandler: 'codex', claudeHandler: 'claude', opencodeHandler: 'opencode', geminiHandler: 'gemini',
  antigravityHandler: 'antigravity', kiroHandler: 'kiro', copilotHandler: 'copilot', cursorAgentHandler: 'cursor_agent',
}
function parser(name: string, resumeThreadId = 'root') {
  const events: any[] = [], sessions: string[] = [], answers: string[] = [], errors: string[] = []
  let stopped = 0, done = 0
  const ctx = {
    resumeThreadId, runtime: 'claude', model: '', instruction: 'continue', localImages: [],
    reasoningParts: [], tokens: { input: 0, output: 0 }, contextUsage: {},
    pump: { push: (event: any) => events.push(event) }, send() {},
    setSession: (id: string) => sessions.push(id), setFullText: (text: string) => answers.splice(0, answers.length, text),
    setErrorText: (text: string) => errors.push(text),
    stop: () => { stopped++ }, markDone: () => { done++ },
  }
  const handler = ADAPTERS[ADAPTER_OF[name]].handler(ctx)
  return { handler, ctx, events, sessions, answers, errors,
    get stopped() { return stopped }, get done() { return done } }
}

describe('main execution owns its reply and completion', () => {
  it('Codex child completion cannot kill a root that is still working', () => {
    const p = parser('codexAppServerHandler')
    p.handler.line({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', phase: 'final_answer', text: 'local work done' } } })
    p.handler.line({ method: 'thread/tokenUsage/updated', params: { threadId: 'child', tokenUsage: { total: { inputTokens: 900, outputTokens: 20 }, last: { inputTokens: 900, outputTokens: 20 } } } })
    p.handler.line({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } })
    expect(p.answers).toEqual([])
    expect(p.ctx.tokens).toEqual({ input: 0, output: 0 })
    expect(p.done).toBe(0)
    expect(p.stopped).toBe(0)
    p.handler.line({ method: 'item/completed', params: { threadId: 'root', item: { type: 'agentMessage', phase: 'final_answer', text: 'published' } } })
    p.handler.line({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } } })
    expect(p.answers).toEqual(['published'])
    expect(p.done).toBe(1)
    expect(p.stopped).toBe(1)
  })

  it('Codex foreign failures, goal terminals and missing ownership cannot stop the root', () => {
    const p = parser('codexAppServerHandler')
    p.handler.line({ method: 'turn/failed', params: { threadId: 'child', turn: { error: 'child failed' } } })
    p.handler.line({ method: 'thread/goal/updated', params: { threadId: 'child', goal: { status: 'complete' } } })
    p.handler.line({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    expect(p.errors).toEqual([])
    expect(p.done).toBe(0)
    expect(p.stopped).toBe(0)
  })

  it('Codex resume usage is a baseline, then counts only fresh responses across turns', () => {
    const p = parser('codexAppServerHandler')
    const usage = (turnId: string, input: number, output: number, lastInput: number, lastOutput: number) =>
      p.handler.line({ method: 'thread/tokenUsage/updated', params: { threadId: 'root', turnId,
        tokenUsage: { total: { inputTokens: input, outputTokens: output }, last: { inputTokens: lastInput, outputTokens: lastOutput } } } })
    usage('old', 1000, 100, 400, 40)
    expect(p.ctx.tokens).toEqual({ input: 0, output: 0 })
    p.handler.line({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'current' } } })
    usage('current', 1600, 130, 600, 30)
    usage('current', 2300, 180, 700, 50)
    usage('current', 2300, 180, 700, 50)
    usage('old', 1000, 100, 400, 40)
    expect(p.ctx.tokens).toEqual({ input: 1300, output: 80 })
    p.handler.line({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'goal-next' } } })
    usage('goal-next', 3100, 240, 800, 60)
    expect(p.ctx.tokens).toEqual({ input: 2100, output: 140 })
  })

  it('Claude ignores child results even when they carry the parent session ID', () => {
    const p = parser('claudeHandler')
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'root' }
    p.handler.line({ ...result, parent_tool_use_id: 'task-tool', result: 'child done', usage: { input_tokens: 10 } })
    p.handler.line({ ...result, session_id: 'child', result: 'foreign done' })
    expect(p.answers).toEqual([])
    expect(p.sessions).toEqual([])
    p.handler.line({ ...result, parent_tool_use_id: null, result: 'root done' })
    expect(p.answers).toEqual(['root done'])
  })

  it('OpenCode step and child-session finishes do not replace the root answer', () => {
    const p = parser('opencodeHandler')
    p.handler.line({ type: 'text', sessionID: 'root', part: { messageID: 'root-answer', text: 'root answer' } })
    p.handler.line({ type: 'text', sessionID: 'child', part: { messageID: 'child-answer', text: 'child answer' } })
    p.handler.line({ type: 'step_finish', sessionID: 'child', part: { tokens: { input: 99 } } })
    p.handler.flush()
    expect(p.answers).toEqual(['root answer'])
    expect(p.sessions).toEqual(['root'])
    expect(p.ctx.tokens.input).toBe(0)
    expect(p.stopped).toBe(0)
  })

  it('OpenCode preserves the V2 error message and rejects foreign errors', () => {
    const p = parser('opencodeHandler')
    p.handler.line({ type: 'error', sessionID: 'child', error: { type: 'unknown', message: 'foreign error' } })
    p.handler.line({ type: 'error', sessionID: 'root', error: { type: 'unknown', message: 'provider unavailable' } })
    expect(p.errors).toEqual(['provider unavailable'])
  })

  it.each([
    ['geminiHandler', { type: 'init', session_id: 'child' }, { type: 'message', role: 'assistant', session_id: 'child', content: 'foreign' }],
    ['antigravityHandler', { event: 'init', conversation_id: 'child' }, { event: 'result', result: { conversation_id: 'child', status: 'SUCCESS', response: 'foreign' } }],
    ['kiroHandler', { type: 'sessionUpdate', data: { sessionId: 'child' } }, { type: 'runFinished', data: { sessionId: 'child', status: 'success', finalText: 'foreign' } }],
    ['copilotHandler', { type: 'result', sessionId: 'child', exitCode: 1 }, { type: 'assistant.message', sessionId: 'child', data: { phase: 'final_answer', content: 'foreign' } }],
    ['cursorAgentHandler', { type: 'system', subtype: 'init', session_id: 'child' }, { type: 'result', session_id: 'child', subtype: 'success', result: 'foreign' }],
  ])('%s rejects explicitly foreign session events', (name, init, result) => {
    const p = parser(name as string)
    p.handler.line(init)
    p.handler.line(result)
    p.handler.flush()
    expect(p.sessions).toEqual([])
    expect(p.answers).toEqual([])
    expect(p.errors).toEqual([])
    const rootResult = JSON.parse(JSON.stringify(result).replaceAll('child', 'root').replaceAll('foreign', 'root answer'))
    p.handler.line(rootResult)
    p.handler.flush()
    expect(p.answers).toEqual(['root answer'])
  })

  it('a new stream binds once and preserves events without an ownership field', () => {
    const p = parser('geminiHandler', '')
    p.handler.line({ type: 'init', session_id: 'root' })
    p.handler.line({ type: 'init', session_id: 'child' })
    p.handler.line({ type: 'message', role: 'assistant', content: 'root answer' })
    p.handler.flush()
    expect(p.sessions).toEqual(['root'])
    expect(p.answers).toEqual(['root answer'])
  })
})
