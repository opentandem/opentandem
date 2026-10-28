import { afterAll, beforeAll, describe, expect, it, vi, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
// 0.68.0: executeRun references the tool summary and the local conversation store through globals; the sandbox
// provides the real summary implementation and sets the local store to null (nothing is written locally).
import { summarizeToolEvents } from '../core/tool-summary.mjs'
import { resolveTraeAgentBin } from '../adapters/trae-agent/index.mjs'
import { stubAdapters } from './fixtures/adapter-context'
import { sanitizeRuntimeDetail } from '../core/agent-kit/kit.mjs'
import { createGeminiFiles } from '../adapters/gemini/index.mjs'
import { createAdapterTranslator } from '../core/messages.mjs'

const source = fs.readFileSync(path.resolve(__dirname, '../core/machine-daemon.mjs'), 'utf8')
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const quiet = { log() {}, error() {}, warn() {} }

// The agent adapters (runner/adapters/) are real modules with the real fs and os: their
// credential files (~/.gemini/.env, ~/.config/opencode/opencode.json) come from a temporary HOME.
const savedEnv = { HOME: process.env.HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY, KIMI_API_KEY: process.env.KIMI_API_KEY }
let fakeHome = ''
beforeAll(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-recovery-home-'))
  fs.mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.gemini', '.env'), 'GEMINI_API_KEY=test-secret\n')
  fs.mkdirSync(path.join(fakeHome, '.config', 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: { kimi: { options: { apiKey: 'kimi-secret' } } } }))
  process.env.HOME = fakeHome
  delete process.env.GEMINI_API_KEY
  delete process.env.KIMI_API_KEY
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('Trae Agent binary resolution', () => {
  const context = { resolveTraeAgentBin }

  it('ignores TraeCode and falls back to the isolated Trae Agent protocol', async () => {
    const probe = vi.fn((candidate: string) => candidate === '/usr/local/bin/traecode'
      ? 'Usage: traecli exec [OPTIONS]'
      : 'Usage: trae-cli run [OPTIONS]\n  -t, --trajectory-file TEXT')
    expect(await context.resolveTraeAgentBin('/usr/local/bin/traecode', '/isolated/trae-cli', probe)).toBe('/isolated/trae-cli')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps an explicitly configured binary only when it speaks the Agent protocol', async () => {
    const probe = vi.fn(() => 'Usage: trae-cli run [OPTIONS]\n  -t, --trajectory-file TEXT')
    expect(await context.resolveTraeAgentBin('/custom/trae-agent', '/isolated/trae-cli', probe)).toBe('/custom/trae-agent')
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

function executionHarness(outcome: 'success' | 'partial-error' | 'spawn-error' | 'claude' | 'qwen-retry' | 'pi-provider-error' | 'dsh-success' | 'dsh-empty' | 'copilot' | 'kiro' | 'trae' | 'codefuse' | 'cline' | 'cursor' | 'controlled') {
  const events: any[] = []
  const journalWrites: any[] = []
  const rpcWrites: any[] = []
  const timeline: any[] = []
  const finish = vi.fn(async () => { timeline.push({ kind: 'finish', events: [...events] }) })
  let childReady!: () => void
  const ready = new Promise<void>(resolve => { childReady = resolve })
  const processKill = vi.fn()
  let argv: string[] = [], instruction = '', bin = '', spawnEnv: Record<string, string> = {}
  const qwenSessionId = 'qwen-session'
  const qwenTranscript = JSON.stringify({
    timestamp: new Date().toISOString(), type: 'system', subtype: 'ui_telemetry',
    systemPayload: { uiEvent: {
      'event.name': 'qwen-code.api_error',
      error_message: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Daily request quota exceeded' } }),
    } },
  }) + '\n'
  const child = Object.assign(new EventEmitter(), {
    pid: 24680, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end(text?: string) { if (text !== undefined) instruction = text }, write(text: string) { const frame = JSON.parse(text); rpcWrites.push(frame); if (argv[0] === 'app-server') childReady(); if (outcome === 'cline') queueMicrotask(() => answerCline(frame)); if (frame?.type === 'user' && typeof frame.message?.content === 'string') instruction = frame.message.content; return true } }), kill: vi.fn(),
  })
  // Claude Code stream-json: init gives session_id, assistant gives thinking/tool_use, user gives tool_result,
  // and result gives the final answer and usage (cache-hit input is counted under cache_*).
  const CLAUDE_LINES = [
    { type: 'system', subtype: 'init', session_id: 'claude-session' },
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: '先看一眼目录' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] } },
    { type: 'system', subtype: 'thinking_tokens', tokens: 42 },
    { type: 'result', subtype: 'success', result: '目录里有两个文件', session_id: 'claude-session',
      usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50_000, output_tokens: 17 } },
  ]
  // Cline over ACP: a JSON-RPC peer. The prompt streams a thought, narration, a tool call (after a
  // refused edit permission) and the answer, and updates the session manifest the adapter reads usage from.
  const clineSend = (frame: any) => child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'))
  const clineUpdate = (update: any) => clineSend({ method: 'session/update', params: { sessionId: 'cline-session', update } })
  const answerCline = (frame: any) => {
    if (frame.method === undefined) return
    if (frame.method === 'initialize') clineSend({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (frame.method === 'session/new') clineSend({ id: frame.id, result: { sessionId: 'cline-session' } })
    else if (frame.method === 'session/set_config_option') clineSend({ id: frame.id, result: { configOptions: [] } })
    else if (frame.method === 'session/set_mode') clineSend({ id: frame.id, result: {} })
    else if (frame.method === 'session/prompt') {
      clineUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看一眼目录' } })
      clineUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在处理。' } })
      clineSend({ id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'cline-session', toolCall: { toolCallId: 'e1', kind: 'edit' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } })
      clineUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_commands: {"commands":["pwd"]}', kind: 'execute', status: 'pending' })
      clineUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: [{ result: '/tmp', success: true }] })
      clineUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CLINE_OK' } })
      const dir = path.join(os.homedir(), '.cline', 'data', 'sessions', 'cline-session')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'cline-session.json'), JSON.stringify({ metadata: { aggregateUsage: { inputTokens: 15, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1 } } }))
      clineSend({ id: frame.id, result: { stopReason: 'end_turn' } })
    }
  }
  const spawn = (spawnBin: string, args: string[], options: { env?: Record<string, string> } = {}) => {
    argv = args
    bin = spawnBin
    spawnEnv = options.env || {}
    queueMicrotask(() => {
      // The Codex app-server child comes from the adapter's process pool, which still awaits a few
      // steps after spawning: for it, "ready" means its first protocol frame was written.
      if (args[0] !== 'app-server') childReady()
      if (outcome === 'controlled') return
      if (outcome === 'spawn-error') child.emit('error', new Error('ENOENT'))
      else if (outcome === 'claude') {
        for (const line of CLAUDE_LINES) child.stdout.emit('data', Buffer.from(JSON.stringify(line) + '\n'))
      }
      else if (outcome === 'pi-provider-error') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'session', id: 'pi-session' }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant', content: [], stopReason: 'error',
            errorMessage: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Daily request quota exceeded' } }),
          },
        })))
      }
      else if (outcome === 'qwen-retry') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: qwenSessionId }) + '\n'))
        child.stderr.emit('data', Buffer.from('[qwen-code] Waiting for API capacity... attempt 3, retry in 45s\n'))
      }
      else if (outcome === 'dsh-success') child.stdout.emit('data', Buffer.from('DSH_OK\n'))
      else if (outcome === 'dsh-empty') { /* upstream exits 0 without writing either stream */ }
      else if (outcome === 'copilot') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'pwd' } } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'c1', result: { content: '/tmp' } } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant.message', data: { phase: 'final_answer', content: 'COPILOT_OK' } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', sessionId: 'copilot-session', exitCode: 0 }) + '\n'))
      }
      else if (outcome === 'kiro') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'metadata', data: { sessionId: 'kiro-session' } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'kiro-session', update: { sessionUpdate: 'tool_call', toolCallId: 'k1', title: 'Running: pwd' } } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'kiro-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'k1', status: 'completed', rawOutput: { items: [{ Json: { stdout: '/tmp\n' } }] } } } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'kiro-session', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'KIRO_OK' } } } }) + '\n'))
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'runFinished', data: { sessionId: 'kiro-session', status: 'success', finalText: 'KIRO_OK' } }) + '\n'))
      }
      else if (outcome === 'trae') {
        const resultFile = args[args.indexOf('--trajectory-file') + 1]
        fs.writeFileSync(resultFile, JSON.stringify({
          success: true, final_result: '', agent_steps: [
            { llm_response: { content: 'TRAE_OK', usage: { input_tokens: 10, output_tokens: 2 }, tool_calls: [{ call_id: 't1', name: 'bash', arguments: { command: 'pwd' } }] } },
            { llm_messages: [{ tool_result: { call_id: 't1', success: true, result: '/tmp' } }], llm_response: { usage: { input_tokens: 11, output_tokens: 3 }, tool_calls: [{ call_id: 'done', name: 'task_done', arguments: {} }] } },
          ],
        }))
        child.stdout.emit('data', Buffer.from('Rich console output that must not become the answer'))
      }
      else if (outcome === 'codefuse') child.stdout.emit('data', Buffer.from('CODEFUSE_OK\n'))
      else if (outcome === 'cline') return // ACP peer: answers the adapter's frames in answerCline
      else if (outcome === 'cursor') {
        const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'cursor-session'
        const lines = [
          { type: 'system', subtype: 'init', session_id: sessionId },
          { type: 'thinking', subtype: 'delta', text: '先创建文件' },
          { type: 'assistant', message: { content: [{ type: 'text', text: '正在处理。' }] }, timestamp_ms: 1 },
          { type: 'tool_call', subtype: 'started', call_id: 'cursor-tool', tool_call: { editToolCall: { args: { path: '/tmp/a.txt' } } } },
          { type: 'tool_call', subtype: 'completed', call_id: 'cursor-tool', tool_call: { editToolCall: { args: { path: '/tmp/a.txt' }, result: { success: { path: '/tmp/a.txt' } } } } },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'CURSOR_OK' }] }, session_id: sessionId },
          { type: 'result', subtype: 'success', result: '正在处理。CURSOR_OK', session_id: sessionId, usage: { inputTokens: 12, outputTokens: 3 } },
        ]
        for (const line of lines) child.stdout.emit('data', Buffer.from(JSON.stringify(line) + '\n'))
      }
      else child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial output' } }) + '\n'))
      child.emit('close', ['success', 'claude', 'pi-provider-error', 'dsh-success', 'dsh-empty', 'copilot', 'kiro', 'trae', 'codefuse', 'cline', 'cursor'].includes(outcome) ? 0 : 1)
    })
    return child
  }
  const context = vm.createContext({
    t: createAdapterTranslator(), EventEmitter, crypto, queueMicrotask, clearTimeout, RUNNER_SCOPE: 'runner-scope', console: quiet, activeRunIds: new Set(), executingRunIds: new Set(), executingRunRuntimes: new Map(), ensureCommandOnPath: async () => {}, binOf: (runtime: string) => runtime, makeEventPump: () => ({ push: (event: any) => { events.push(event); timeline.push({ kind: 'event', event }) }, finish }),
    maybeProbeRuntimeModels() {}, prepareRecovery: async () => {}, expandSkillMarkers: (s: string) => s, path,
    downloadImage: async () => '/tmp/image.png', process: { env: { DSH_PROVIDER_KEY: 'glm-secret' }, platform: 'darwin', execPath: 'node', pid: 123, cwd: () => '/tmp', kill: processKill }, CODEX_BIN: 'codex', SERVER: 'local', ID: 'machine', TOKEN_FILE: null, KEY: 'key', os: { homedir: () => '/Users/test', tmpdir: () => '/tmp' },
    execFileSync: () => 'HTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\nHTTPSEnable : 1\n',
    systemExec: async () => ({ error: null, stdout: 'HTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\nHTTPSEnable : 1\n' }),
    spawn, DAEMON_VERSION: 'test', processIdentity: () => 'identity', saveExecution(record: any) { const copy = { ...record }; journalWrites.push(copy); timeline.push({ kind: 'journal', record: copy }) }, setInterval: () => 1, clearInterval() {}, setTimeout: () => ({ unref() {} }),
    runtimeSessionPath: async () => '', knownSessionFile: () => '', lookupSessionFile: async () => '', sessionFileForEvent: async () => '',
    // Adapter file readers run on the scan thread in the Runner; here only Qwen's transcript is found.
    adapterFileCall: async (_runtime: string, method: string, _args: unknown[], fallback: unknown) =>
      outcome === 'qwen-retry' && method === 'transcriptDiagnostics.file' ? `/tmp/chats/${qwenSessionId}.jsonl` : fallback,
    rememberSessionFile: () => {}, runOnLane: async (_lane: string, job: any) => job?.type === 'session_path' && job.runtime === 'qwen' && outcome === 'qwen-retry' ? { path: `/tmp/chats/${qwenSessionId}.jsonl` } : ({}), sessionStillExists: async (...args: any[]) => context.sessionExists(...args), OPENTANDEM_HELP_RULE: 'Use the OpenTandem help tool for product questions.',
    qwenSessionPath: () => outcome === 'qwen-retry' ? `/tmp/chats/${qwenSessionId}.jsonl` : '',
    CLAUDE_BIN: 'claude', OPENCODE_BIN: 'opencode', GEMINI_BIN: 'gemini', KIMI_BIN: 'kimi',
    ANTIGRAVITY_BIN: 'agy', QWEN_BIN: 'qwen', PI_BIN: 'pi', DSH_BIN: 'dsh', DSH_ENTRY: 'dsh-entry.js', sessionExists: () => true,
    COPILOT_BIN: 'copilot', KIRO_BIN: 'kiro-cli', CODEBUDDY_BIN: 'codebuddy',
    TRAE_AGENT_BIN: 'trae-cli', TRAE_AGENT_CONFIG: '/tmp/trae.yaml', CODEFUSE_BIN: 'cfuse', CLINE_BIN: 'cline', kimiCodingApiKey: () => 'kimi-secret', KIMI_CODING_BASE_URL: 'https://api.kimi.com/coding/v1', IS_WIN: false,
    CURSOR_AGENT_BIN: 'agent',
    summarizeToolEvents, sanitizeRuntimeDetail, localStore: null, localUtcNow: () => '2026-01-01 00:00:00',
    uploadArtifacts: async () => [], Buffer, fs: {
      existsSync: (file: string) => (outcome === 'qwen-retry' && String(file).endsWith(`/chats/${qwenSessionId}.jsonl`))
        || (outcome === 'trae' && String(file).startsWith('/tmp/opentandem-trae-')),
      readdirSync: (dir: string) => outcome === 'qwen-retry' && String(dir).endsWith('/.qwen/projects') ? ['project'] : [],
      statSync: () => ({ size: Buffer.byteLength(qwenTranscript) }),
      openSync: () => 1,
      readSync: (_fd: number, target: Buffer) => Buffer.from(qwenTranscript).copy(target),
      closeSync: () => {},
      // The Qwen transcript poll reads asynchronously (0.87.0).
      promises: {
        stat: async () => ({ size: Buffer.byteLength(qwenTranscript) }),
        open: async () => ({ read: async (target: Buffer) => ({ bytesRead: Buffer.from(qwenTranscript).copy(target) }), close: async () => {} }),
      },
      mkdtempSync: fs.mkdtempSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      rmSync: fs.rmSync,
      chmodSync: fs.chmodSync,
      symlinkSync: fs.symlinkSync,
      readFileSync: (file: string) => String(file).startsWith('/tmp/opentandem-trae-')
        ? fs.readFileSync(file)
        : String(file).endsWith('/.config/opencode/opencode.json')
          ? JSON.stringify({ provider: { kimi: { options: { apiKey: 'kimi-secret' } } } })
          : 'GEMINI_API_KEY=test-secret\n',
      unlinkSync: (file: string) => fs.unlinkSync(file),
    }, outboxPath: () => '',
  })
  // The real adapters, given the same fake process and timers as the Runner code above.
  // Executable names the adapters read from SOPHON_<KEY> (ctx.config), as a Runner configured with them.
  const configured: Record<string, string> = {
    CLAUDE_BIN: 'claude', CODEX_BIN: 'codex', OPENCODE_BIN: 'opencode', GEMINI_BIN: 'gemini', KIMI_BIN: 'kimi', ANTIGRAVITY_BIN: 'agy',
    QWEN_BIN: 'qwen', PI_BIN: 'pi', DSH_BIN: 'dsh', COPILOT_BIN: 'copilot', KIRO_BIN: 'kiro-cli', CODEBUDDY_BIN: 'codebuddy',
    TRAE_AGENT_BIN: 'trae-cli', TRAE_AGENT_CONFIG: '/tmp/trae.yaml', CODEFUSE_BIN: 'cfuse', CLINE_BIN: 'cline', CURSOR_AGENT_BIN: 'agent',
  }
  context.ADAPTERS = stubAdapters({
    config: (key: string) => configured[key], configKey: (key: string) => `SOPHON_${key}`,
    toolCommandDir: () => '/Users/test/.sophon/bin',
    spawn, processIdentity: async () => 'identity', killProcessTree: async (...args: unknown[]) => context.killProcessTree?.(...args),
    runtimeInstructions: (run: unknown) => context.runtimeInstructions(run), toolServerSpec: (run: unknown) => context.scheduleMcpServerSpec(run),
    runtimeStops: () => context.runtimeStops(), artifactSpoolPath: (run: unknown) => context.artifactSpoolPath(run),
    persistOverlay: async () => {}, killCompactChild: () => {},
    // CodeFuse reads its default agent profile with its own Python before each run.
    execFileNow: async (_file: string, args: string[]) => {
      if (args[0] === '-c') return { error: null, stdout: JSON.stringify({ name: 'default', description: 'Default', tools: null, model: '', system_prompt: 'Default prompt' }) }
      return { error: new Error('not available in this test'), stdout: '' }
    },
    systemExec: async () => ({ error: null, stdout: '' }),
  })
  // Since 0.12.0, argv assembly and stdout parsing are split into standalone functions per runtime (codexArgs /
  // claudeArgs / codexHandler / claudeHandler) that belong to the same section as executeRun, so the cut starts
  // from the header of that section so that executeRun gets the functions it depends on.
  context.finishExecutingRun = (runId: string) => { context.executingRunIds.delete(runId); context.executingRunRuntimes.delete(runId) }
  // executeRun wraps its pump so events keep their order while thread_started waits for its session file.
  vm.runInContext(section('function orderedEventPump(', '// Durable execution journal'), context)
  // scheduleMcpEnv (in the runtime section) passes run.server_tools through these two.
  vm.runInContext(section('function serverToolsEnv(', 'function mcpServerTools('), context)
  const runtimeSource = section('const RUNTIMES = ', '// ---------------------------------------------------------------------------\n// Artifact upload')
    .replaceAll('fileURLToPath(import.meta.url)', JSON.stringify('/tmp/machine-daemon.mjs'))
  vm.runInContext(section('const userChoicesRule = ', '\n// Execution tool registry') + '\n' + runtimeSource + '\nglobalThis.executeRun = executeRun', context)
  // Help materialization is covered by agent-help.test.ts; keep recovery fixtures in memory.
  context.writeOpentandemHelp = () => '/tmp/opentandem-help.md'
  return { events, journalWrites, rpcWrites, timeline, finish, child, ready, line: (frame: any) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n')), context, processKill, get argv() { return argv }, get instruction() { return instruction }, get bin() { return bin }, get spawnEnv() { return spawnEnv } }
}

describe('Gemini runtime', () => {
  it('does not resume a Gemini session that never produced a Gemini message', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-gemini-session-'))
    const chats = path.join(temp, '.gemini', 'tmp', 'project', 'chats')
    const sessionId = 'f9b33182-4fd1-4786-8fd0-fbbc1a0151d2'
    const sessionFile = path.join(chats, 'session-2026-09-16T13-06-f9b33182.jsonl')
    const geminiSessionExists = (id: string) => createGeminiFiles({ fs, path, os: { homedir: () => temp } }).session.exists(id)
    try {
      fs.mkdirSync(chats, { recursive: true })
      fs.writeFileSync(sessionFile, [
        JSON.stringify({ sessionId, projectHash: 'project', kind: 'main' }),
        JSON.stringify({ id: 'user-1', type: 'user', content: [{ text: 'hello' }] }),
      ].join('\n') + '\n')
      expect(geminiSessionExists(sessionId)).toBe(false)

      fs.appendFileSync(sessionFile, JSON.stringify({ id: 'gemini-1', type: 'gemini', content: [{ text: 'hello back' }] }) + '\n')
      expect(geminiSessionExists(sessionId)).toBe(true)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('injects the user Gemini key only into the Gemini child environment', async () => {
    const h = executionHarness('success')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'gemini', prompt: 'p', exec_mode: 'readonly', images: [] })
    expect(h.bin).toBe('gemini')
    expect(h.argv).toContain('plan')
    expect(h.spawnEnv.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
    expect(h.spawnEnv.GEMINI_API_KEY).toBe('test-secret')
    expect(h.spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(h.spawnEnv.HTTP_PROXY).toBe('http://127.0.0.1:7897')

    const kimi = executionHarness('success')
    await kimi.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'kimi', prompt: 'p', exec_mode: 'full', images: [] })
    expect(kimi.spawnEnv.GEMINI_API_KEY).toBeUndefined()
    expect(kimi.spawnEnv.HTTPS_PROXY).toBeUndefined()
  })
})

describe('Gemini-key backed runtimes', () => {
  it.each([
    ['antigravity', 'agy', 'gemini-3.6-flash-low'],
    ['qwen', 'qwen', 'qwen/gemini-3.5-flash'],
    ['pi', 'pi', 'pi/gemini-3.5-flash'],
  ] as const)('%s receives only the local Gemini key and proxy', async (runtime, expectedBin, model) => {
    const h = executionHarness('success')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime, prompt: 'p', model, exec_mode: 'readonly', images: [] })
    expect(h.bin).toBe(expectedBin)
    expect(h.spawnEnv.GEMINI_API_KEY).toBe('test-secret')
    expect(h.spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(h.argv[h.argv.indexOf('--model') + 1]).toBe(model.replace(/^(qwen|pi)\//, ''))
  })

  it('surfaces Pi provider failures even though Pi exits 0', async () => {
    const h = executionHarness('pi-provider-error')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'pi', prompt: 'p', model: 'pi/gemini-3.5-flash', exec_mode: 'full', images: [] })
    const error = h.events.find(e => e.type === 'error')?.data.message
    expect(error).toContain('429 RESOURCE_EXHAUSTED')
    expect(error).toContain('Daily request quota exceeded')
    expect(h.events.some(e => e.type === 'message_complete')).toBe(false)
  })

  it('streams Qwen 429 and retry wait diagnostics into Thinking before exit', async () => {
    const h = executionHarness('qwen-retry')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'qwen', prompt: 'p', model: 'qwen/gemini-3.5-flash', exec_mode: 'full', images: [] })
    const progress = h.events.filter(e => e.type === 'reasoning_delta').map(e => e.data.text)
    expect(progress.some(text => text.includes('429 RESOURCE_EXHAUSTED') && text.includes('Daily request quota exceeded'))).toBe(true)
    expect(progress.some(text => text.includes('正在等待重试') && text.includes('第 3 次') && text.includes('45 秒后'))).toBe(true)
    expect(progress.some(text => text.includes('已停止本次执行，不再自动重试'))).toBe(true)
    expect(h.processKill).toHaveBeenCalledWith(-24680, 'SIGTERM')
    expect(h.events.find(e => e.type === 'error')?.data.message).toContain('429 RESOURCE_EXHAUSTED')
  })

  it('announces an automatically recovered execution attempt', async () => {
    const h = executionHarness('qwen-retry')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'qwen', attempt: 3, prompt: 'p', model: 'qwen/gemini-3.5-flash', exec_mode: 'full', images: [] })
    expect(h.events.some(e => e.type === 'reasoning_delta' && e.data.text.includes('第 3 次执行（自动恢复）'))).toBe(true)
  })
})

describe('DeepSeek Harness runtime', () => {
  // A fake dsh installation per version: the adapter reads <entry>/../../package.json to decide
  // whether this dsh can resume (0.1.6+: --json, --session-id, task on stdin).
  let fakeDshRoot = ''
  beforeAll(() => { fakeDshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-fake-dsh-')) })
  afterAll(() => { fs.rmSync(fakeDshRoot, { recursive: true, force: true }) })
  const useDsh = (h: ReturnType<typeof executionHarness>, version: string) => {
    const dir = path.join(fakeDshRoot, version)
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    h.context.ADAPTERS.dsh = stubAdapters({
      config: (key: string) => key === 'DSH_BIN' ? path.join(dir, 'lib', 'bin.js') : undefined,
      runtimeInstructions: (run: unknown) => h.context.runtimeInstructions(run),
      toolServerSpec: (run: unknown) => h.context.scheduleMcpServerSpec(run),
      persistOverlay: async () => {},
    }).dsh
    return fs.realpathSync(path.join(dir, 'lib', 'bin.js'))
  }

  it('sets only the permission mode and leaves credentials to dsh\'s own configuration', () => {
    const env: Record<string, string> = {}
    stubAdapters().dsh.processEnv(env, { run: { exec_mode: 'readonly', workdir: '/project' }, setup: null })
    expect(env).toEqual({ DSH_PERMISSION_MODE: 'read-only' })
  })

  it('runs an older dsh one-shot with plain text, passes the user\'s own environment through, and never reports a resumable session', async () => {
    const h = executionHarness('dsh-success')
    const entry = useDsh(h, '0.1.5-rc.1')
    // A dsh without --session-id never offers a resumable session, so the Runner always rebuilds context.
    expect(h.context.ADAPTERS.dsh.filesState()).toEqual({ resume: false })
    expect(h.context.ADAPTERS.dsh.session.exists('session-any', '/tmp')).toBe(false)
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', prompt: '完整上下文', exec_mode: 'full', workdir: '/tmp', images: [] })
    // The adapter runs the Harness entry with the Runner's own Node.
    expect(h.bin).toBe(process.execPath)
    expect(h.argv).toEqual([entry, '--profile', 'headless', '完整上下文'])
    expect(h.instruction).toBe('')
    // A key the user exported for dsh reaches it unchanged; the Runner adds no credential of its own.
    expect(h.spawnEnv.DSH_PROVIDER_KEY).toBe('glm-secret')
    expect(h.spawnEnv.DSH_PERMISSION_MODE).toBe('danger-full-access')
    expect(h.events.some(e => e.type === 'thread_started')).toBe(false)
    const done = h.events.find(e => e.type === 'message_complete')?.data
    expect(done?.full_text).toBe('DSH_OK')
    expect(done?.thread_id).toBeUndefined()
  })

  it('runs dsh 0.1.6+ with --json, sends the task on stdin and parses NDJSON into answer, tools, usage and session', async () => {
    const h = executionHarness('controlled')
    const entry = useDsh(h, '0.2.1-rc.2')
    const done = h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', prompt: '-- full context', exec_mode: 'full', workdir: '/tmp', images: [] })
    await h.ready
    expect(h.bin).toBe(process.execPath)
    expect(h.argv).toEqual([entry, '--profile', 'headless', '--json'])
    // Chunks split mid-line on purpose: dsh output reaches the adapter as raw stdout.
    const ndjson = [
      { type: 'session', sessionId: 'session-new', cwd: '/tmp' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'thinking', text: 'look first' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_call', callId: 'call-1', tool: 'read', input: { path: '/tmp/secret.txt' } },
      { type: 'tool_result', callId: 'call-1', status: 'completed', result: 'TOKEN=1' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 5000, cacheWriteTokens: 20 } },
      { type: 'text', text: 'DSH_JSON_OK' },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 40, outputTokens: 3, cacheReadTokens: 5100 } },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: 'DSH_JSON_OK' },
    ].map(line => JSON.stringify(line) + '\n').join('')
    for (let i = 0; i < ndjson.length; i += 23) h.child.stdout.emit('data', Buffer.from(ndjson.slice(i, i + 23)))
    h.child.emit('close', 0)
    await done
    expect(h.instruction).toBe('-- full context')
    expect(h.events.find(e => e.type === 'thread_started')?.data.thread_id).toBe('session-new')
    const tools = h.events.filter(e => e.type === 'tool_event').map(e => [e.data.id, e.data.status, e.data.label])
    expect(tools).toEqual([['call-1', 'running', 'read(/tmp/secret.txt)'], ['call-1', 'done', 'read(/tmp/secret.txt)']])
    expect(h.events.filter(e => e.type === 'reasoning_delta').map(e => e.data.text)).toEqual(expect.arrayContaining(['look first', 'Reading the file.']))
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete?.full_text).toBe('DSH_JSON_OK')
    expect(complete?.thread_id).toBe('session-new')
    // Input counts uncached + cache read + cache write over every step; context is the last step's prompt.
    expect(complete?.token_usage).toEqual({ input: 100 + 5000 + 20 + 40 + 5100, output: 10 })
    expect(complete?.context?.tokens).toBe(40 + 5100)
  })

  it('resumes the native session with --session-id and sends only this turn\'s instruction', async () => {
    const h = executionHarness('controlled')
    const entry = useDsh(h, '0.2.1-rc.2')
    const done = h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', resume_thread_id: 'session-abc', instruction: 'next message', prompt: 'full history', exec_mode: 'readonly', workdir: '/tmp', images: [] })
    await h.ready
    expect(h.argv).toEqual([entry, '--profile', 'headless', '--json', '--session-id', 'session-abc'])
    expect(h.spawnEnv.DSH_PERMISSION_MODE).toBe('read-only')
    h.line({ type: 'session', sessionId: 'session-abc', cwd: '/tmp' })
    h.line({ type: 'final', text: 'RESUMED' })
    h.child.emit('close', 0)
    await done
    expect(h.instruction).toBe('next message')
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete?.full_text).toBe('RESUMED')
    expect(complete?.thread_id).toBe('session-abc')
  })

  it('reports a dsh turn error from the JSON stream', async () => {
    const h = executionHarness('controlled')
    useDsh(h, '0.2.1-rc.2')
    const done = h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', prompt: 'p', exec_mode: 'full', workdir: '/tmp', images: [] })
    await h.ready
    h.line({ type: 'session', sessionId: 'session-err', cwd: '/tmp' })
    h.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'provider_error', message: 'quota exhausted' } } })
    h.line({ type: 'final', text: '' })
    h.child.emit('close', 1)
    await done
    expect(h.events.find(e => e.type === 'error')?.data.message).toContain('provider_error: quota exhausted')
    expect(h.events.some(e => e.type === 'message_complete')).toBe(false)
  })

  it('maps readonly to the Harness read-only permission preset', async () => {
    const h = executionHarness('dsh-success')
    useDsh(h, '0.1.5-rc.1')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', prompt: 'p', exec_mode: 'readonly', images: [] })
    expect(h.spawnEnv.DSH_PERMISSION_MODE).toBe('read-only')
  })

  it('reports the exact empty-output condition when dsh exits 0', async () => {
    const h = executionHarness('dsh-empty')
    useDsh(h, '0.1.5-rc.1')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'dsh', prompt: 'p', exec_mode: 'full', images: [] })
    expect(h.events.find(e => e.type === 'error')?.data.message)
      .toContain('未输出最终答案（stdout/stderr 均为空）')
  })
})

describe('Copilot, Kiro and CodeBuddy runtimes', () => {
  it('maps Copilot plan mode and parses its final answer, tool event and session', async () => {
    const h = executionHarness('copilot')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'copilot', prompt: 'p', exec_mode: 'readonly', images: [] })
    expect(h.bin).toBe('copilot')
    expect(h.argv).toContain('--plan')
    expect(h.argv).toContain('--allow-all-tools')
    expect(h.instruction).toBe('p')
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete.full_text).toBe('COPILOT_OK')
    expect(complete.thread_id).toBe('copilot-session')
    // Since 0.68.0 the terminal event carries only a summary; commands and output are no longer reported
    expect(complete.tool_events).toBeUndefined()
    expect(complete.tool_summary).toEqual({ v: 1, total: 1, tools: [['bash', 1]] })
  })

  it('maps Kiro full access and parses ACP stream events', async () => {
    const h = executionHarness('kiro')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'kiro', prompt: 'p', exec_mode: 'full', images: [] })
    expect(h.bin).toBe('kiro-cli')
    expect(h.argv).toContain('--trust-all-tools')
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete.full_text).toBe('KIRO_OK')
    expect(complete.thread_id).toBe('kiro-session')
    expect(complete.tool_events).toBeUndefined()
    expect(complete.tool_summary).toEqual({ v: 1, total: 1, tools: [['Running', 1]] })
  })

  it('maps CodeBuddy readonly to plan with read-only tools', async () => {
    const h = executionHarness('claude')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'codebuddy', prompt: 'p', exec_mode: 'readonly', images: [] })
    expect(h.bin).toBe('codebuddy')
    expect(h.argv.slice(h.argv.indexOf('--permission-mode'), h.argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'plan'])
    expect(h.argv.slice(h.argv.indexOf('--tools'), h.argv.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Glob,Grep'])
    expect(h.events.find(e => e.type === 'message_complete')?.data.full_text).toBe('目录里有两个文件')
  })
})

describe('Trae Agent, CodeFuse and Cline runtimes', () => {
  it('reads Trae final text and tool results from the trajectory file', async () => {
    const h = executionHarness('trae')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'trae_agent', prompt: 'p', exec_mode: 'full', workdir: '/tmp', images: [] })
    expect(h.bin).toBe('trae-cli')
    expect(h.argv).toContain('--trajectory-file')
    expect(h.spawnEnv.OPENAI_API_KEY).toBe('kimi-secret')
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete.full_text).toBe('TRAE_OK')
    expect(complete.token_usage).toEqual({ input: 21, output: 5 })
    expect(complete.tool_events).toBeUndefined()
    expect(complete.tool_summary).toEqual({ v: 1, total: 1, tools: [['bash', 1]] })
  })

  it('runs CodeFuse unattended and treats plain stdout as the final answer', async () => {
    const h = executionHarness('codefuse')
    await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'codefuse', prompt: 'p', model: 'codefuse/kimi-for-coding', exec_mode: 'full', workdir: '/tmp', images: [] })
    expect(h.bin).toBe('cfuse')
    expect(h.argv).toContain('--yolo')
    expect(h.argv[h.argv.indexOf('--model') + 1]).toBe('kimi-for-coding')
    expect(h.spawnEnv.OPENAI_API_KEY).toBe('kimi-secret')
    expect(h.events.find(e => e.type === 'message_complete')?.data.full_text).toBe('CODEFUSE_OK')
  })

  it('drives Cline over ACP: plan mode, refused edits, native session id and usage from the manifest', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-cline-home-'))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const h = executionHarness('cline')
      // The adapter stops the child after the prompt answer; the fake process then closes.
      let closed = false
      h.context.killProcessTree = () => { if (!closed) { closed = true; queueMicrotask(() => h.child.emit('close', null, 'SIGTERM')) } }
      await h.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'cline', prompt: 'p', model: 'cline/glm-5-turbo', exec_mode: 'readonly', workdir: '/tmp', images: [] })
      expect(h.bin).toBe('cline')
      expect(h.argv[0]).toBe('--acp')
      expect(h.argv[h.argv.indexOf('--auto-approve') + 1]).toBe('false')
      expect(h.spawnEnv.CLINE_SESSION_BACKEND_MODE).toBe('local')
      const sent = (method: string) => h.rpcWrites.find(f => f.method === method)
      expect(sent('session/new').params).toMatchObject({ cwd: '/tmp' })
      expect(sent('session/set_config_option').params).toMatchObject({ sessionId: 'cline-session', configId: 'model', value: 'glm-5-turbo' })
      expect(sent('session/set_mode').params).toEqual({ sessionId: 'cline-session', modeId: 'plan' })
      expect(sent('session/prompt').params).toEqual({ sessionId: 'cline-session', prompt: [{ type: 'text', text: 'p' }] })
      // A read-only run refuses an edit permission request.
      expect(h.rpcWrites.find(f => f.id === 'perm-1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
      expect(h.events.find(e => e.type === 'thread_started')?.data.thread_id).toBe('cline-session')
      const complete = h.events.find(e => e.type === 'message_complete')?.data
      expect(complete.full_text).toBe('CLINE_OK')
      expect(complete.thread_id).toBe('cline-session')
      // inputTokens already includes cache reads and writes.
      expect(complete.token_usage).toEqual({ input: 15, output: 2 })
      expect(complete.tool_events).toBeUndefined()
      expect(complete.tool_summary).toEqual({ v: 1, total: 1, tools: [['run_commands', 1]], notes: [{ after: 0, text: '正在处理。' }] })
      expect(h.events.filter(e => e.type === 'content_delta').map(e => e.data.text)).toEqual(['CLINE_OK'])
    } finally {
      process.env.HOME = previousHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('Cursor Agent CLI runtime', () => {
  it('maps permissions, resumes natively and de-duplicates stream-json final text', async () => {
    const h = executionHarness('cursor')
    await h.context.executeRun({
      run_id: 'r', task_id: 't', runtime: 'cursor_agent', resume_kind: 'followup',
      resume_thread_id: 'old-cursor-session', prompt: '完整历史', instruction: '只有这一句',
      model: 'auto', exec_mode: 'readonly', workdir: '/tmp', images: [],
    })
    expect(h.bin).toBe('agent')
    expect(h.argv).toContain('--trust')
    expect(h.argv.slice(h.argv.indexOf('--mode'), h.argv.indexOf('--mode') + 2)).toEqual(['--mode', 'plan'])
    expect(h.argv.slice(h.argv.indexOf('--resume'), h.argv.indexOf('--resume') + 2)).toEqual(['--resume', 'old-cursor-session'])
    expect(h.instruction).toBe('只有这一句')
    expect(h.spawnEnv.PATH).toBe('/Users/test/.sophon/bin:')
    const complete = h.events.find(e => e.type === 'message_complete')?.data
    expect(complete.full_text).toBe('CURSOR_OK')
    expect(complete.thread_id).toBe('old-cursor-session')
    expect(complete.token_usage).toEqual({ input: 12, output: 3 })
    // thinking text does not go into the summary; only commands are counted
    expect(complete.tool_events).toBeUndefined()
    // Since 0214e93689 the summary includes what the model said before tools (notes)
    expect(complete.tool_summary).toEqual({ v: 1, total: 1, tools: [['edit', 1]], notes: [{ after: 0, text: '正在处理。' }] })
    expect(h.events.filter(e => e.type === 'content_delta').map(e => e.data.text)).toEqual(['CURSOR_OK'])

    const full = executionHarness('cursor')
    await full.context.executeRun({ run_id: 'r2', task_id: 't', runtime: 'cursor_agent', prompt: 'p', model: 'auto', exec_mode: 'full', images: [] })
    expect(full.argv).toContain('--force')
    expect(full.argv).not.toContain('--mode')
  })
})

describe('daemon attachment delivery', () => {
  it.each([null, undefined, ''])('downloads images without workdir %s and passes real local files to Claude stdin', async (workdir) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-attachment-'))
    try {
      const h = executionHarness('claude')
      h.context.os.homedir = () => temp
      // Exercise the real downloader against an in-memory response; only files touch disk.
      const bytes = Buffer.from('attachment bytes')
      const downloader = vm.createContext({ fs, path, Buffer, AbortSignal, fetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes })) })
      vm.runInContext(section('async function downloadImage(', '/** Batched event pump:') + '\nglobalThis.downloadImage = downloadImage', downloader)
      h.context.downloadImage = downloader.downloadImage
      await h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'claude', prompt: 'read image', exec_mode: 'full', workdir,
        images: [{ name: 'photo.png', url: 'https://attachments.invalid/photo.png?token=private' }] })
      const dest = path.join(temp, '.sophon', 'uploads', 'runner-scope', 'task', 'photo.png')
      expect(h.instruction).toContain(dest)
      expect(fs.readFileSync(dest)).toEqual(bytes)
      expect(h.events.some(e => e.type === 'error')).toBe(false)
      expect(h.events.some(e => e.type === 'message_complete')).toBe(true)
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  })

  it('downloads into the per-task attachment directory when workdir is supplied', async () => {
    const h = executionHarness('claude')
    const download = vi.fn(async (_url, dir, name) => path.join(dir, name))
    h.context.downloadImage = download
    await h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'claude', prompt: 'read image', exec_mode: 'full', workdir: '/tmp/project',
      images: [{ name: 'photo.png', url: 'https://attachments.invalid/photo.png' }] })
    expect(download).toHaveBeenCalledWith('https://attachments.invalid/photo.png', '/tmp/project/.sophon/uploads/task', 'photo.png')
    expect(h.instruction).toContain('/tmp/project/.sophon/uploads/task/photo.png')
  })

  it('runs normally without workdir or attachments', async () => {
    const h = executionHarness('claude')
    h.context.downloadImage = vi.fn()
    await h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'claude', prompt: 'plain text', exec_mode: 'full', workdir: null, images: [] })
    expect(h.context.downloadImage).not.toHaveBeenCalled()
    expect(h.bin).toBe('claude')
    expect(h.instruction).toBe('plain text')
    expect(h.events.some(e => e.type === 'message_complete')).toBe(true)
  })

  it.each([0, 1])('stops before spawn if attachment %i fails and releases the run without leaking signed URLs', async (failedIndex) => {
    const h = executionHarness('claude')
    let index = 0
    h.context.downloadImage = vi.fn(async (_url, dir, name) => {
      if (index++ === failedIndex) throw new Error('download failed https://attachments.invalid/photo.png?token=private')
      return path.join(dir, name)
    })
    await h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'claude', prompt: 'read both', exec_mode: 'full', workdir: '/tmp/project',
      images: [{ name: 'first.png', url: 'https://attachments.invalid/first.png' }, { name: 'second.pdf', url: 'https://attachments.invalid/second.pdf' }] })
    expect(h.bin).toBe('')
    expect(h.instruction).toBe('')
    const errors = h.events.filter(e => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].data.message).toContain(failedIndex ? 'second.pdf' : 'first.png')
    expect(errors[0].data.message).toContain('附件下载失败')
    expect(JSON.stringify(h.events)).not.toContain('token=private')
    expect(JSON.stringify(h.events)).not.toContain('https://attachments.invalid')
    expect(h.events.some(e => e.type === 'message_complete')).toBe(false)
    expect(h.context.executingRunIds.has('run')).toBe(false)
    expect(h.context.activeRunIds.has('run')).toBe(false)
  })
})

describe('Claude Code runtime', () => {
  it('starts the process with claude\'s arguments and translates stream-json into the same set of events', async () => {
    const h = executionHarness('claude')
    await h.context.executeRun({
      run_id: 'run', task_id: 'task', runtime: 'claude', prompt: '完整历史 + 本次指令',
      model: 'claude-sonnet-5', reasoning_effort: 'low', exec_mode: 'full', workdir: '/tmp', images: [],
    })
    expect(h.bin).toBe('claude')
    expect(h.argv).toContain('-p')
    expect(h.argv.slice(h.argv.indexOf('--output-format'), h.argv.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json'])
    expect(h.argv.slice(h.argv.indexOf('--model'), h.argv.indexOf('--model') + 2)).toEqual(['--model', 'claude-sonnet-5'])
    expect(h.argv.slice(h.argv.indexOf('--effort'), h.argv.indexOf('--effort') + 2)).toEqual(['--effort', 'low'])
    // none of codex's -s/-C may appear; the working directory is passed via cwd
    expect(h.argv).not.toContain('-s')
    expect(h.argv).not.toContain('-C')
    // no resume_thread_id => new session, and the instruction is a whole prompt with the full history
    expect(h.argv).not.toContain('--resume')
    expect(h.instruction).toBe('完整历史 + 本次指令')

    const complete = h.events.find(e => e.type === 'message_complete')
    expect(h.events.find(e => e.type === 'thread_started')?.data.thread_id).toBe('claude-session')
    expect(complete?.data.full_text).toBe('目录里有两个文件')
    expect(complete?.data.thread_id).toBe('claude-session')
    // cache-hit input must be counted in the total, otherwise Claude's runs would look like they almost never consume input
    expect(complete?.data.token_usage).toEqual({ input: 51_002, output: 17 })
    // the full command text and output appear only in live events during the run; the terminal state reports only a summary
    expect(complete?.data.tool_events).toBeUndefined()
    expect(complete?.data.tool_summary).toEqual({ v: 1, total: 1, tools: [['Bash', 1]] })
    expect(JSON.stringify(complete?.data)).not.toContain('ls -la')
  })

  it('read-only level uses plan; the other levels use bypassPermissions', async () => {
    const ro = executionHarness('claude')
    await ro.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'claude', prompt: 'p', exec_mode: 'readonly', images: [] })
    expect(ro.argv.slice(ro.argv.indexOf('--permission-mode'), ro.argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'plan'])

    const full = executionHarness('claude')
    await full.context.executeRun({ run_id: 'r', task_id: 't', runtime: 'claude', prompt: 'p', exec_mode: 'full', images: [] })
    expect(full.argv.slice(full.argv.indexOf('--permission-mode'), full.argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions'])
  })

  it('continuing in the same runtime sends only the current instruction and --resume to the original session', async () => {
    const h = executionHarness('claude')
    await h.context.executeRun({
      run_id: 'run', task_id: 'task', runtime: 'claude', resume_kind: 'followup',
      resume_thread_id: 'old-claude-session', prompt: '完整历史', instruction: '只有这一句',
      exec_mode: 'full', images: [],
    })
    expect(h.argv.slice(h.argv.indexOf('--resume'), h.argv.indexOf('--resume') + 2)).toEqual(['--resume', 'old-claude-session'])
    expect(h.instruction).toBe('只有这一句')
  })
})

describe('daemon recovery execution', () => {
  it.each([
    ['original-thread', undefined], [undefined, undefined],
    ['original-thread', 'Current runtime rules'], [undefined, 'Current runtime rules'],
  ])('Codex %s reports its session before completion with rules %s', async (resumeId, instructions) => {
    const h = executionHarness('controlled')
    const done = h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'codex',
      resume_thread_id: resumeId, runtime_instructions: instructions, prompt: 'original instruction', exec_mode: 'readonly', workdir: '/tmp', images: [] })
    await h.ready
    expect(h.argv[0]).toBe('app-server')
    expect(h.rpcWrites[0].method).toBe('initialize')
    h.line({ id: h.rpcWrites[0].id, result: {} })
    const request = h.rpcWrites.find(m => m.method === (resumeId ? 'thread/resume' : 'thread/start'))
    expect(request).toBeDefined()
    // The sandbox is passed explicitly with every start/resume: settings remembered by the thread itself must not override this turn's execution mode
    // Product help rules from main remain present; the optional override is prepended.
    const policy = { sandbox: 'read-only', approvalPolicy: 'never', cwd: '/tmp', developerInstructions: [instructions, 'Use the OpenTandem help tool for product questions.'].filter(Boolean).join('\n') }
    expect(request.params).toEqual(resumeId ? { threadId: resumeId, excludeTurns: true, ...policy } : policy)
    const sessionId = resumeId || 'fresh-thread'
    expect(h.journalWrites.map(r => r.thread_id)).toEqual([resumeId || ''])
    const before = h.timeline.length
    h.line({ id: request.id, result: { thread: { id: sessionId } } })
    // The fake child has not exited and has given no answer, so this cannot pass by relying on the final finish. Since 0.87.0 the
    // session file is looked up in the scan thread, so thread_started is emitted one event-loop tick later, but still before the answer.
    await vi.waitFor(() => expect(h.timeline.slice(before).map(entry => entry.kind)).toEqual(['journal', 'event', 'finish']))
    expect(h.journalWrites.map(r => r.thread_id)).toEqual([resumeId || '', sessionId])
    expect(h.events).toEqual([{ type: 'thread_started', data: { thread_id: sessionId, session_file: undefined } }])
    expect(h.finish).toHaveBeenCalledTimes(1)
    expect(h.timeline.at(-1).events).toEqual(h.events)
    if (resumeId) {
      // Since 399bec4024 a resumed Codex session injects this turn's run rules into the developer channel before the turn starts
      const inject = h.rpcWrites.find(m => m.method === 'thread/inject_items')
      expect(inject.params.threadId).toBe(sessionId)
      expect(inject.params.items[0].content[0].text).toContain('Use the OpenTandem help tool for product questions.')
      expect(h.rpcWrites.some(m => m.method === 'turn/start')).toBe(false)
      h.line({ id: inject.id, result: {} })
    }
    const turn = h.rpcWrites.find(m => m.method === 'turn/start')
    expect(turn.params.threadId).toBe(sessionId)
    // Since 6ac1161599 recovery uses the same behavior as a manual retry: the original instruction is resent as is,
    // and a fixed Chinese interruption notice is no longer sent
    expect(turn.params.input[0].text).toContain('original instruction')
    h.line({ method: 'item/completed', params: { threadId: sessionId, item: { type: 'agentMessage', phase: 'final_answer', text: 'DONE' } } })
    h.line({ method: 'turn/completed', params: { threadId: sessionId, turn: { status: 'completed' } } })
    h.child.emit('close', null, 'SIGTERM')
    await done
    expect(h.events.filter(e => e.type === 'error')).toEqual([])
    expect(h.events.find(e => e.type === 'message_complete')?.data).toMatchObject({ thread_id: sessionId, full_text: 'DONE' })
    expect(h.events.filter(e => e.type === 'thread_started')).toHaveLength(1)
  })

  it('settles fourteen Codex runs on one live child without accumulating stdin listeners', async () => {
    const h = executionHarness('controlled')
    const complete = (turnId: string, answer: string) => {
      h.line({ method: 'item/completed', params: { threadId: 'thread', turnId, item: { type: 'agentMessage', phase: 'final_answer', text: answer } } })
      h.line({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } })
      const cleanup = h.rpcWrites.filter(m => m.method === 'thread/backgroundTerminals/list').at(-1)
      h.line({ id: cleanup.id, result: { data: [] } })
    }
    // Since 399bec4024 a reused Codex session injects this turn's run rules before every turn, and only sends turn/start after the injection is acknowledged
    const answerInject = async (count: number) => {
      await vi.waitFor(() => expect(h.rpcWrites.filter(m => m.method === 'thread/inject_items')).toHaveLength(count))
      h.line({ id: h.rpcWrites.filter(m => m.method === 'thread/inject_items').at(-1).id, result: {} })
    }
    const first = h.context.executeRun({ run_id: 'first', task_id: 'task', runtime: 'codex', prompt: 'first' })
    await h.ready
    h.line({ id: h.rpcWrites[0].id, result: {} })
    h.line({ id: h.rpcWrites.find(m => m.method === 'thread/start').id, result: { thread: { id: 'thread' } } })
    complete('turn-first', 'FIRST')
    await first
    expect(h.events.filter(e => e.type === 'message_complete')).toHaveLength(1)
    expect(h.journalWrites.at(-1)).toMatchObject({ run_id: 'first', thread_id: 'thread', pid: null, identity: null })
    expect(h.context.activeRunIds.size).toBe(0)
    expect(h.context.executingRunIds.size).toBe(0)
    expect(h.context.runtimeStops().size).toBe(1)
    expect(h.processKill).not.toHaveBeenCalled()
    const second = h.context.executeRun({ run_id: 'second', task_id: 'task', runtime: 'codex', resume_kind: 'followup', resume_thread_id: 'thread', instruction: 'second' })
    await answerInject(1)
    await vi.waitFor(() => expect(h.rpcWrites.filter(m => m.method === 'turn/start')).toHaveLength(2))
    expect(h.rpcWrites.filter(m => m.method === 'initialize')).toHaveLength(1)
    expect(h.rpcWrites.at(-1).params.input[0].text).toBe('second')
    complete('turn-second', 'SECOND')
    await second
    expect(h.events.filter(e => e.type === 'message_complete').map(e => e.data.full_text)).toEqual(['FIRST', 'SECOND'])
    expect(h.journalWrites.at(-1)).toMatchObject({ run_id: 'second', thread_id: 'thread', pid: null, identity: null })
    expect(h.context.activeRunIds.size).toBe(0)
    expect(h.child.stdin.listenerCount('error')).toBe(1)
    for (let round = 3; round <= 14; round++) {
      const next = h.context.executeRun({ run_id: `run-${round}`, task_id: 'task', runtime: 'codex', resume_kind: 'followup', resume_thread_id: 'thread', instruction: `round ${round}` })
      await answerInject(round - 1)
      await vi.waitFor(() => expect(h.rpcWrites.filter(m => m.method === 'turn/start')).toHaveLength(round))
      expect(h.child.stdin.listenerCount('error')).toBe(1)
      complete(`turn-${round}`, `ANSWER ${round}`)
      await next
      expect(h.events.filter(e => e.type === 'message_complete')).toHaveLength(round)
      expect(h.child.stdin.listenerCount('error')).toBe(1)
    }
    expect(h.rpcWrites.filter(m => m.method === 'initialize')).toHaveLength(1)
    expect(h.processKill).not.toHaveBeenCalled()
    h.child.emit('close', 0)
    expect(h.context.runtimeStops().size).toBe(0)
  })

  it('retires a completed Codex process while terminal delivery remains in the outbox', async () => {
    const h = executionHarness('controlled')
    h.context.outboxPath = () => '/pending-outbox'
    h.context.fs.existsSync = (file: string) => file === '/pending-outbox'
    const done = h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'codex', prompt: 'work' })
    await h.ready
    h.line({ id: h.rpcWrites[0].id, result: {} })
    h.line({ id: h.rpcWrites.find(m => m.method === 'thread/start').id, result: { thread: { id: 'thread' } } })
    h.line({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: 'done' } } })
    h.line({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } })
    h.line({ id: h.rpcWrites.find(m => m.method === 'thread/backgroundTerminals/list').id, result: { data: [] } })
    await done
    expect(h.processKill).toHaveBeenCalledWith(-24680, 'SIGTERM')
    expect(h.context.activeRunIds.has('run')).toBe(true)
    expect(h.context.executingRunIds.size).toBe(0)
    h.child.emit('close', 0)
  })

  it.each([0, 1])('does not silently recover or report success when Codex exits %i before turn completion', async code => {
    const h = executionHarness('controlled')
    const done = h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'codex', prompt: 'work' })
    await h.ready
    h.line({ id: h.rpcWrites[0].id, result: {} })
    h.line({ id: h.rpcWrites.find(m => m.method === 'thread/start').id, result: { thread: { id: 'thread' } } })
    h.line({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: 'partial' } } })
    h.child.emit('close', code)
    await done
    expect(h.events.filter(e => e.type === 'message_complete')).toEqual([])
    expect(h.events.find(e => e.type === 'error').data.retryable).toBe(false)
    expect(h.rpcWrites.filter(m => m.method === 'turn/start')).toHaveLength(1)
  })

  it('deduplicates session confirmations and refuses replacement session events', async () => {
    // Claude init/result both really call executeRun's setSession; do not call it directly or copy it.
    const h = executionHarness('controlled')
    const done = h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'claude',
      resume_thread_id: 'original-thread', prompt: 'p', images: [] })
    await h.ready
    const confirm = (id: string) => h.line({ type: 'system', subtype: 'init', session_id: id })
    confirm('original-thread')
    await vi.waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1))
    const beforeDuplicate = h.timeline.length
    confirm('original-thread')
    expect(h.timeline).toHaveLength(beforeDuplicate)
    confirm('replacement-thread')
    confirm('replacement-thread')
    expect(h.timeline).toHaveLength(beforeDuplicate)
    expect(h.events.map(e => e.data.thread_id)).toEqual(['original-thread'])
    expect(h.journalWrites.map(r => r.thread_id)).toEqual(['original-thread', 'original-thread'])
    expect(h.finish).toHaveBeenCalledTimes(1)
    h.line({ type: 'result', subtype: 'success', result: 'FOREIGN', session_id: 'replacement-thread' })
    expect(h.timeline).toHaveLength(beforeDuplicate)
    h.line({ type: 'result', subtype: 'success', result: 'DONE', session_id: 'original-thread' })
    h.child.emit('close', 0)
    await done
    expect(h.events.filter(e => e.type === 'thread_started')).toHaveLength(1)
    expect(h.events.find(e => e.type === 'message_complete')?.data).toMatchObject({ thread_id: 'original-thread', full_text: 'DONE' })
    expect(h.journalWrites).toHaveLength(2)
  })

  it.each([false, true])('keeps the recovery session when Codex fails (confirmed=%s)', async confirmed => {
    const h = executionHarness('controlled')
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-recovery-session-'))
    onTestFinished(() => fs.rmSync(temp, { recursive: true, force: true }))
    const journal = vm.createContext({ fs, path, os: { homedir: () => temp }, RUNNER_SCOPE: 'test-scope',
      systemExec: async () => ({ error: null, stdout: 'different process identity' }), process: { platform: 'darwin', kill: vi.fn() }, setTimeout })
    vm.runInContext(section('const EXECUTION_DIR =', '// Import existing local conversations') +
      '\nglobalThis.saveExecution=saveExecution; globalThis.prepareRecovery=prepareRecovery; globalThis.executionPath=executionPath', journal)
    const recordWrite = h.context.saveExecution
    h.context.saveExecution = (record: any) => { journal.saveExecution(record); recordWrite(record) }
    // Since 0.87.0 the process identity is obtained asynchronously from the system process lane and written back into the run record afterwards;
    // the write-back only targets the record that is still there
    h.context.executionPath = journal.executionPath
    const harnessExists = h.context.fs.existsSync
    h.context.fs.existsSync = (file: string) => file === journal.executionPath('run') ? fs.existsSync(file) : harnessExists(file)
    const done = h.context.executeRun({ run_id: 'run', task_id: 'task', runtime: 'codex',
      resume_thread_id: 'original-thread', prompt: 'p', images: [] })
    await h.ready
    if (confirmed) {
      h.line({ id: h.rpcWrites[0].id, result: {} })
      const request = h.rpcWrites.find(m => m.method === 'thread/resume')
      h.line({ id: request.id, result: { thread: { id: 'original-thread' } } })
      await vi.waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1))
      expect(h.events.map(e => e.type)).toEqual(['thread_started'])
      // Since 399bec4024 resuming injects run rules first; turn/start is sent only after the acknowledgement,
      // and failures after that are "already submitted, not automatically retryable"
      h.line({ id: h.rpcWrites.find(m => m.method === 'thread/inject_items').id, result: {} })
      expect(h.rpcWrites.some(m => m.method === 'turn/start')).toBe(true)
    }
    expect(h.journalWrites.at(-1).thread_id).toBe('original-thread')
    h.child.stderr.emit('data', Buffer.from('connection interrupted\n'))
    h.child.emit('close', 1)
    await done
    expect(h.events.some(e => e.type === 'error')).toBe(true)
    expect(h.events.find(e => e.type === 'error').data.retryable).toBe(confirmed ? false : undefined)
    expect(h.events.some(e => e.type === 'message_complete')).toBe(false)
    expect(h.events.filter(e => e.type === 'thread_started')).toHaveLength(confirmed ? 1 : 0)
    expect(h.journalWrites.at(-1)).toMatchObject({ run_id: 'run', thread_id: 'original-thread', runtime: 'codex' })
    expect(JSON.parse(fs.readFileSync(journal.executionPath('run'), 'utf8')).thread_id).toBe('original-thread')
    const recovered = { run_id: 'run', resume_thread_id: '', resume_kind: '' }
    await journal.prepareRecovery(recovered)
    expect(recovered).toMatchObject({ resume_thread_id: 'original-thread', resume_kind: 'recovery' })
    expect(journal.process.kill).not.toHaveBeenCalled()
  })
  it.each(['partial-error', 'spawn-error'] as const)('%s never reports message_complete', async outcome => {
    const h = executionHarness(outcome)
    await h.context.executeRun({ run_id: 'run', task_id: 'task', prompt: 'instruction' })
    expect(h.events.some(e => e.type === 'error')).toBe(true)
    expect(h.events.some(e => e.type === 'message_complete')).toBe(false)
  })
  it('refuses recovery when the previous process is alive but its identity was not saved', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-journal-'))
    const kill = vi.fn()
    try {
      const context = vm.createContext({ t: createAdapterTranslator(), fs, path, crypto, os: { homedir: () => temp }, SERVER: 'local', ID: 'machine', RUNNER_SCOPE: 'test-scope',
        systemExec: async () => ({ error: null, stdout: 'live process' }), process: { kill, platform: 'darwin' }, setTimeout,
      })
      vm.runInContext(section('const EXECUTION_DIR =', 'async function restoreSessions()') + '\nglobalThis.saveExecution=saveExecution; globalThis.prepareRecovery=prepareRecovery', context)
      context.saveExecution({ run_id: 'run', pid: 24680, identity: null, thread_id: 'original-thread' })
      await expect(context.prepareRecovery({ run_id: 'run' })).rejects.toThrow('无法确认旧进程身份')
      expect(kill).not.toHaveBeenCalled()
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  })
  it('does not signal a reused process id and recovers the locally saved thread', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-journal-'))
    const kill = vi.fn()
    try {
      const context = vm.createContext({ t: createAdapterTranslator(), fs, path, crypto, os: { homedir: () => temp }, SERVER: 'local', ID: 'machine', RUNNER_SCOPE: 'test-scope',
        systemExec: async () => ({ error: null, stdout: 'different process identity' }), process: { kill, platform: 'darwin' }, setTimeout,
      })
      vm.runInContext(section('const EXECUTION_DIR =', 'async function restoreSessions()') + '\nglobalThis.saveExecution=saveExecution; globalThis.prepareRecovery=prepareRecovery', context)
      context.saveExecution({ run_id: 'run', pid: 24680, identity: 'old process identity', thread_id: 'original-thread' })
      const run = { run_id: 'run', resume_thread_id: '' }
      await context.prepareRecovery(run)
      expect(kill).not.toHaveBeenCalled()
      expect(run.resume_thread_id).toBe('original-thread')
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  })
})

describe('daemon event delivery', () => {
  it('finish waits for an earlier in-flight batch and keeps its original attempt', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const bodies: any[] = []
    const context = vm.createContext({ console: quiet, SERVER: 'local', ID: 'machine', authHeaders: {}, clearCompletedExecution: vi.fn(),
      fetch: async (_url: string, opts: any) => { bodies.push(JSON.parse(opts.body)); await waiting; return { ok: true } },
      AbortSignal, setTimeout, clearTimeout, fs: { existsSync: () => false }, outboxPath: () => '',
      TERMINAL_EVENT_TYPES: new Set(['error', 'message_complete']), outboxPersist() {},
    })
    vm.runInContext(section('function makeEventPump(', '// Durable execution journal') + '\nglobalThis.makeEventPump=makeEventPump', context)
    const pump = context.makeEventPump('run', 2)
    pump.push({ type: 'thread_started', data: { thread_id: 'thread' } })
    const first = pump.finish()
    let finished = false
    const last = pump.finish().then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    const finishedTooSoon = finished
    release()
    await Promise.all([first, last])
    expect(finishedTooSoon).toBe(false)
    expect(bodies[0].attempt).toBe(2)
    expect(bodies[0].events[0].data.attempt).toBe(2)
  })
})

describe('daemon durable event outbox', () => {
  it('delivers more than 200 events across attempts without dropping or mixing them', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-outbox-'))
    const sent: any[][] = []
    const clearCompletedExecution = vi.fn()
    const context = vm.createContext({ fs, path, os: { homedir: () => temp }, console: quiet,
      SERVER: 'local', ID: 'machine', RUNNER_SCOPE: 'test-scope', authHeaders: {}, AbortSignal, withDeadline: (promise: any) => promise, clearCompletedExecution,
      fetch: async (_url: string, opts: any) => { sent.push(JSON.parse(opts.body).events); return { ok: true } },
    })
    vm.runInContext(section('const OUTBOX_DIR =', '// ---------------------------------------------------------------------------\n// Run execution (P2)') + '\nglobalThis.outboxPersist=outboxPersist; globalThis.flushOutbox=flushOutbox; globalThis.outboxPath=outboxPath; globalThis.activeRunIds=activeRunIds', context)
    const events = [
      ...Array.from({ length: 205 }, (_, i) => ({ type: 'tool_event', data: { attempt: 1, seq: i } })),
      { type: 'message_complete', data: { attempt: 2, seq: 205 } },
    ]
    try {
      context.activeRunIds.add('run')
      context.outboxPersist('run', events)
      await context.flushOutbox()
      expect(sent.map(batch => batch.length)).toEqual([200])
      expect(context.activeRunIds.has('run')).toBe(true)
      await context.flushOutbox()
      expect(sent.map(batch => batch.length)).toEqual([200, 5])
      await context.flushOutbox()
      expect(sent.map(batch => batch.length)).toEqual([200, 5, 1])
      expect(sent.flat()).toEqual(events)
      expect(sent.every(batch => new Set(batch.map(event => event.data.attempt)).size === 1)).toBe(true)
      expect(fs.existsSync(context.outboxPath('run'))).toBe(false)
      expect(context.activeRunIds.has('run')).toBe(false)
      expect(clearCompletedExecution).toHaveBeenCalledTimes(3)
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  })
  it('keeps events appended while a checkpoint batch is in flight', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sophon-outbox-'))
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const fetched = new Promise<void>(resolve => { started = resolve })
    const context = vm.createContext({ fs, path, os: { homedir: () => temp }, console: quiet,
      SERVER: 'local', ID: 'machine', RUNNER_SCOPE: 'test-scope', authHeaders: {}, clearCompletedExecution: vi.fn(), AbortSignal, withDeadline: (promise: any) => promise,
      fetch: async () => { started(); await waiting; return { ok: true } },
    })
    vm.runInContext(section('const OUTBOX_DIR =', '// ---------------------------------------------------------------------------\n// Run execution (P2)') + '\nglobalThis.outboxPersist=outboxPersist; globalThis.flushOutbox=flushOutbox; globalThis.outboxPath=outboxPath; globalThis.activeRunIds=activeRunIds; globalThis.executingRunIds=executingRunIds', context)
    try {
      context.activeRunIds.add('run')
      context.executingRunIds.add('run')
      context.outboxPersist('run', [{ type: 'thread_started', data: { attempt: 1, thread_id: 'thread' } }])
      const flushing = context.flushOutbox()
      await fetched
      context.outboxPersist('run', [{ type: 'message_complete', data: { attempt: 1, full_text: 'done' } }])
      release()
      await flushing
      const file = context.outboxPath('run')
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['message_complete'])
      expect(context.activeRunIds.has('run')).toBe(true)
    } finally { release(); fs.rmSync(temp, { recursive: true, force: true }) }
  })
})
