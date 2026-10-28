// Cline CLI (`cline`): driven over the Agent Client Protocol (`cline --acp`,
// JSON-RPC on stdin/stdout) so later turns resume the native session with only
// the new message. A temporary config directory adds the OpenTandem MCP server
// and the runtime rules; sessions stay in the real data directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configOverlay } from '../../core/agent-kit/kit.mjs'
import { kimiBackedGroup } from '../../core/agent-kit/kimi-coding.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createClineFiles(io) {
  const { fs, os, path, SqliteDatabaseSync } = io
  // Runs point CLINE_DATA_DIR here, so every session (including ACP ones) is recorded with real paths.
  const dataDir = () => path.join(os.homedir(), '.cline', 'data')
  const withDb = (file, readOnly, fn) => {
    const dbPath = path.join(dataDir(), 'db', file)
    if (!SqliteDatabaseSync || !fs.existsSync(dbPath)) return undefined
    const db = new SqliteDatabaseSync(dbPath, { readOnly })
    try { db.exec('PRAGMA busy_timeout = 5000'); return fn(db) } finally { db.close() }
  }
  /** sessions.db row -> messages file; resumable only when that file still exists. */
  function messagesPath(sessionId) {
    if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return ''
    try {
      const row = withDb('sessions.db', true, db => db.prepare('SELECT messages_path FROM sessions WHERE session_id = ?').get(sessionId))
      const fallback = path.join(dataDir(), 'sessions', sessionId, `${sessionId}.messages.json`)
      const file = row && typeof row.messages_path === 'string' && row.messages_path ? row.messages_path : (row ? fallback : '')
      return file && fs.existsSync(file) ? file : ''
    } catch {
      return ''
    }
  }
  /** Context size after the turn: the last model request's input (cache included) plus its output. */
  function contextTokens(sessionId) {
    const file = messagesPath(sessionId)
    if (!file) return 0
    try {
      const messages = JSON.parse(fs.readFileSync(file, 'utf8'))?.messages
      if (!Array.isArray(messages)) return 0
      for (let i = messages.length - 1; i >= 0; i--) {
        const metrics = messages[i]?.role === 'assistant' ? messages[i].metrics : null
        if (metrics && Number.isFinite(metrics.inputTokens)) return metrics.inputTokens + (Number(metrics.outputTokens) || 0)
      }
    } catch { /* unreadable transcript */ }
    return 0
  }
  return {
    session: { path: id => messagesPath(id), exists: id => !!messagesPath(id) },
    contextTokens: id => contextTokens(id),
    purgeSide: ({ base, sid, rm }) => {
      let ids = []
      withDb('sessions.db', false, db => {
        ids = db.prepare('SELECT session_id FROM sessions WHERE cwd LIKE ? OR session_id = ?').all(`%${base}%`, sid || '').map(r => String(r.session_id))
        for (const id of ids) db.prepare('DELETE FROM sessions WHERE session_id = ?').run(id)
      })
      withDb('session-search.db', false, db => {
        for (const id of ids) {
          for (const table of ['indexed_sessions', 'session_search']) {
            try { db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id) } catch { /* table absent in this version */ }
          }
        }
      })
      for (const id of ids) if (/^[\w.-]+$/.test(id)) rm(path.join(dataDir(), 'sessions', id))
    },
  }
}

export function createClineAdapter(ctx) {
  const { execFile, SqliteDatabaseSync, VERSION_PROBE_MS, runtimeInstructions, toolServerSpec, persistOverlay, t } = ctx
  const files = createClineFiles({ fs, os, path, SqliteDatabaseSync })
  const CLINE_BIN = ctx.config('CLINE_BIN') || 'cline'
  const realDir = () => path.join(os.homedir(), '.cline')
  const MCP_RELATIVE = path.join('data', 'settings', 'cline_mcp_settings.json')

  function collectCline() {
    return new Promise((resolve) => {
      execFile(CLINE_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => {
        if (err) { resolve({ installed: false, login: false, version: null }); return }
        resolve({ installed: true, login: true, version: String(stdout).trim().split('\n')[0] })
      })
    })
  }

  async function clineGroup() {
    const status = await collectCline().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    // The model follows Cline's own openai-compatible settings; without one it is Kimi for Coding
    let own = ''
    try {
      const providers = JSON.parse(fs.readFileSync(path.join(realDir(), 'data', 'settings', 'providers.json'), 'utf8'))
      const model = providers?.providers?.['openai-compatible']?.settings?.model
      if (typeof model === 'string' && /^[\w.:/-]{1,100}$/.test(model)) own = model
    } catch { /* no settings */ }
    if (!own || own === 'kimi-for-coding') return kimiBackedGroup('cline', 'cline')
    return { runtime: 'cline', models: [{ slug: `cline/${own}`, display_name: own, reasoning_levels: [] }], default_model: `cline/${own}`, default_effort: null }
  }

  function clineScheduleMcpConfig(run) {
    const original = path.join(realDir(), MCP_RELATIVE)
    let current = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(original, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
    } catch {}
    const spec = toolServerSpec(run)
    return configOverlay(realDir(), 'opentandem-cline-config-', {
      [MCP_RELATIVE]: JSON.stringify({
        ...current,
        mcpServers: {
          ...(current.mcpServers || {}),
          opentandem: { transport: { type: 'stdio', ...spec } },
        },
      }),
      [path.join('rules', 'opentandem-runtime.md')]: `${runtimeInstructions(run)}\n`,
    }, persistOverlay)
  }

  /** `cline --acp` speaks JSON-RPC on stdin/stdout. `--config` points at the
   * temporary overlay (rules); ACP ignores `--data-dir`, so the data directory,
   * the MCP settings file and the credentials come through processEnv. */
  function clineArgs(run, setup) {
    const argv = ['--acp', '--auto-approve', run.exec_mode === 'readonly' ? 'false' : 'true']
    if (setup?.home) argv.push('--config', setup.home)
    return { argv, stdinText: '', cwd: run.workdir || undefined, keepStdinOpen: true }
  }

  /** ACP accepts an API key only from CLINE_API_KEY (its own sign-in covers
   * Cline accounts only); the base URL still comes from providers.json. The key
   * is read from this machine's Cline settings and goes into the child
   * environment only, never into argv or logs. */
  async function clineEnv(env, { setup }) {
    // A local backend: otherwise ACP starts a detached background hub that outlives the run.
    env.CLINE_SESSION_BACKEND_MODE = 'local'
    env.CLINE_PROVIDER = 'openai-compatible'
    env.CLINE_DATA_DIR = path.join(realDir(), 'data')
    if (setup?.home) env.CLINE_MCP_SETTINGS_PATH = path.join(setup.home, MCP_RELATIVE)
    delete env.CLINE_MODEL
    try {
      const providers = JSON.parse(await fs.promises.readFile(path.join(realDir(), 'data', 'settings', 'providers.json'), 'utf8'))
      const key = providers?.providers?.['openai-compatible']?.settings?.apiKey
      if (typeof key === 'string' && key.trim()) env.CLINE_API_KEY = key.trim()
    } catch { /* no settings: ACP reports that authentication is required */ }
    const manifestDir = path.join(realDir(), 'data', 'sessions')
    return () => ({ clineSessionsDir: manifestDir })
  }

  // Usage over ACP is not streamed; the session manifest keeps cumulative totals. Small file, read asynchronously.
  async function sessionUsage(sessionsDir, sessionId) {
    if (!sessionsDir || !/^[\w.-]+$/.test(sessionId || '')) return null
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(sessionsDir, sessionId, `${sessionId}.json`), 'utf8'))
      const usage = manifest?.metadata?.aggregateUsage || manifest?.metadata?.usage
      return usage && typeof usage === 'object' ? usage : null
    } catch {
      return null
    }
  }

  const textOf = (value) => {
    if (value == null) return ''
    if (typeof value === 'string') return value
    // MCP results: { content: [{ type: 'text', text }] }
    if (Array.isArray(value?.content) && value.content.every(part => typeof part?.text === 'string')) return value.content.map(part => part.text).join('\n')
    if (Array.isArray(value)) return value.map(row => (row && typeof row === 'object') ? (row.result ?? row.error ?? row.text ?? JSON.stringify(row)) : String(row)).filter(Boolean).join('\n')
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  // Tool kinds that only look at things; the rest are refused in read-only runs.
  const READ_KINDS = new Set(['read', 'search', 'think', 'fetch'])

  function clineHandler(ctx) {
    let nextId = 1
    let finished = false
    let prompted = false
    let sessionId = ''
    let segment = ''
    let thought = ''
    let usageBefore = null
    const pending = new Map()
    const timers = new Map()
    const toolById = new Map()
    const model = String(ctx.model || 'cline/kimi-for-coding').replace(/^cline\//, '')
    const readonly = ctx.execMode === 'readonly'

    const stop = (discard = false) => {
      if (finished) return
      finished = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      ctx.stop(discard)
    }
    const fail = (text) => {
      if (finished) return
      ctx.setErrorText(text)
      stop(true)
    }
    const rpc = (method, params, done) => {
      const id = nextId++
      pending.set(id, { method, done })
      // Bound protocol steps, never the model turn itself.
      if (method !== 'session/prompt') {
        const timer = setTimeout(() => {
          if (!finished && pending.has(id)) fail(t('Cline did not answer {method} within 60 seconds', { method }))
        }, 60_000)
        timer.unref?.()
        timers.set(id, timer)
      }
      ctx.send({ jsonrpc: '2.0', id, method, params })
    }
    const flushThought = () => {
      if (!thought.trim()) { thought = ''; return }
      ctx.reasoningParts.push({ kind: 'reasoning', label: thought })
      ctx.pump.push({ type: 'reasoning_delta', data: { text: thought } })
      thought = ''
    }
    // Text written before a tool call is narration; only the text after the last tool call is the answer.
    const flushNarration = () => {
      const text = segment.trim()
      segment = ''
      if (!text) return
      ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: text })
      ctx.pump.push({ type: 'reasoning_delta', data: { text } })
    }

    const prompt = () => {
      const text = ctx.localImages.length
        ? `${ctx.instruction}\n\n[Image files attached to this message]\n${ctx.localImages.join('\n')}`
        : ctx.instruction
      prompted = true
      rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, async (result) => {
        flushThought()
        const answer = segment.trim()
        segment = ''
        const usageAfter = await sessionUsage(ctx.clineSessionsDir, sessionId)
        if (usageAfter) {
          // inputTokens already includes cache reads and writes.
          ctx.tokens.input += Math.max(0, (Number(usageAfter.inputTokens) || 0) - (Number(usageBefore?.inputTokens) || 0))
          ctx.tokens.output += Math.max(0, (Number(usageAfter.outputTokens) || 0) - (Number(usageBefore?.outputTokens) || 0))
        }
        if (answer) {
          ctx.setFullText(answer)
          ctx.pump.push({ type: 'content_delta', data: { text: answer } })
        }
        if (result?.stopReason === 'cancelled') ctx.setErrorText(t('Cline cancelled the turn'))
        else ctx.markDone()
        stop()
      })
    }
    const configure = () => {
      rpc('session/set_config_option', { sessionId, configId: 'model', value: model }, () => {
        if (readonly) rpc('session/set_mode', { sessionId, modeId: 'plan' }, prompt)
        else prompt()
      })
    }
    const opened = async (id) => {
      sessionId = id
      ctx.setSession(id)
      usageBefore = await sessionUsage(ctx.clineSessionsDir, id)
      configure()
    }

    const answerPermission = (message) => {
      const kind = message.params?.toolCall?.kind
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const allow = !readonly || READ_KINDS.has(kind)
      const option = options.find(o => allow ? /^allow/.test(o?.kind || '') : /^reject/.test(o?.kind || ''))
      ctx.send({ jsonrpc: '2.0', id: message.id, result: option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } } })
    }
    const onUpdate = (update) => {
      // session/load replays the stored history first; only this turn counts.
      if (!prompted || !update) return
      switch (update.sessionUpdate) {
        case 'agent_thought_chunk':
          thought += update.content?.text || ''
          return
        case 'agent_message_chunk':
          flushThought()
          if (update.content?.type === 'text') segment += update.content.text || ''
          return
        case 'tool_call': {
          flushThought()
          flushNarration()
          const label = String(update.title || 'tool').slice(0, 300)
          const rec = { kind: 'command', label, status: 'running', output: '' }
          ctx.reasoningParts.push(rec)
          if (update.toolCallId) toolById.set(update.toolCallId, rec)
          ctx.pump.push({ type: 'tool_event', data: { id: update.toolCallId, kind: 'command', label, status: 'running' } })
          return
        }
        case 'tool_call_update': {
          if (update.status !== 'completed' && update.status !== 'failed') return
          // Only calls announced during this turn (a load can finish an older one).
          const rec = update.toolCallId ? toolById.get(update.toolCallId) : undefined
          if (!rec || rec.status === 'done') return
          const output = textOf(update.rawOutput).slice(0, 2000)
          rec.status = 'done'
          rec.output = output
          ctx.pump.push({ type: 'tool_event', data: { id: update.toolCallId, kind: 'command', label: rec.label, status: 'done', output } })
          return
        }
        default:
      }
    }

    rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, () => {
      const params = { cwd: ctx.cwd, mcpServers: [] }
      if (ctx.resumeThreadId) {
        rpc('session/load', { ...params, sessionId: ctx.resumeThreadId }, () => opened(ctx.resumeThreadId))
      } else {
        rpc('session/new', params, (result) => {
          if (typeof result?.sessionId !== 'string' || !result.sessionId) fail(t('Cline did not return a session id'))
          else void opened(result.sessionId)
        })
      }
    })

    return {
      line(message) {
        if (finished || !message || typeof message !== 'object') return
        if (message.id !== undefined && message.method === undefined) {
          const call = pending.get(message.id)
          if (!call) return
          pending.delete(message.id)
          clearTimeout(timers.get(message.id))
          timers.delete(message.id)
          if (message.error) {
            const detail = message.error.data?.message || message.error.message || 'unknown error'
            fail(message.error.code === -32002
              ? t('Cline session {sessionId} no longer exists on this machine', { sessionId: ctx.resumeThreadId || sessionId })
              : t('Cline {method} failed: {detail}', { method: call.method, detail }))
            return
          }
          Promise.resolve(call.done?.(message.result)).catch(e => fail(String(e?.message || e)))
          return
        }
        if (message.method === 'session/request_permission' && message.id !== undefined) { answerPermission(message); return }
        if (message.method && message.id !== undefined) {
          ctx.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } })
          return
        }
        if (message.method === 'session/update') onUpdate(message.params?.update)
      },
      flush() {
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        finished = true
      },
    }
  }

  return {
    id: 'cline',
    label: 'Cline CLI',
    executes: true,
    bin: () => CLINE_BIN,
    detect: collectCline,
    models: () => clineGroup(),
    nativeInstructions: true,
    toolSetup: clineScheduleMcpConfig,
    command: (run, images, instruction, setup) => clineArgs(run, setup),
    processEnv: clineEnv,
    handler: clineHandler,
    completion: 'handler',
    submitMethod: 'session/prompt',
    session: files.session,
    contextTokens: files.contextTokens,
    // Side title calls run in a temporary directory: delete the sessions recorded there.
    purgeSide: files.purgeSide,
    ownFiles: createClineFiles,
  }
}
