// GitHub Copilot CLI (`copilot`): headless `-p` runs with JSON output; native
// `/compact` for context compaction.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMPACT_TIMEOUT_MS, mainSessionEventGuard, npmInstall, stripAnsi } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createCopilotFiles(io) {
  const { fs, os, path, SqliteDatabaseSync } = io

  function copilotSessionExists(sessionId) {
    return !!copilotSessionPath(sessionId)
  }

  function copilotSessionPath(sessionId) {
    if (!sessionId) return ''
    const root = path.join(os.homedir(), '.copilot', 'session-state', sessionId)
    const events = path.join(root, 'events.jsonl')
    if (fs.existsSync(events)) return events
    return fs.existsSync(root) ? root : ''
  }

  return {
    session: { path: id => copilotSessionPath(id), exists: id => copilotSessionExists(id) },
    purgeSide: ({ home, sid, rm }) => {
        if (!sid) return
        rm(path.join(home, '.copilot', 'session-state', sid))
        // The session list has its own index database: delete only this session's rows
        const dbPath = path.join(home, '.copilot', 'session-store.db')
        if (SqliteDatabaseSync && fs.existsSync(dbPath)) {
          const db = new SqliteDatabaseSync(dbPath)
          try {
            db.exec('PRAGMA busy_timeout = 5000')
            for (const table of ['turns', 'session_files', 'session_refs', 'checkpoints', 'assistant_usage_events', 'forge_trajectory_events', 'search_index']) {
              try { db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sid) } catch { /* table absent in this version */ }
            }
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
          } finally { db.close() }
        }
      },
  }
}

export function createCopilotAdapter(ctx) {
  const { execFile, spawn, SqliteDatabaseSync, VERSION_PROBE_MS, cachedModelProbe, probeTui, killCompactChild, runtimeInstructions, toolServerSpec, t } = ctx
  const files = createCopilotFiles({ fs, os, path, SqliteDatabaseSync })
  const COPILOT_BIN = ctx.config('COPILOT_BIN') || 'copilot'

  function collectCopilot() {
    return new Promise((resolve) => {
      execFile(COPILOT_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => {
        if (err) { resolve({ installed: false, login: false, version: null }); return }
        resolve({ installed: true, login: true, version: String(stdout).trim().split('\n')[0] })
      })
    })
  }

  async function copilotGroup() {
    const status = await collectCopilot().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    // BYOK has exactly one model: COPILOT_MODEL (Copilot sends it as-is to the configured service)
    const byok = process.env.COPILOT_PROVIDER_BASE_URL && process.env.COPILOT_MODEL
    if (byok) return { runtime: 'copilot', models: [{ slug: byok, display_name: byok, description: t('Self-configured model service (COPILOT_PROVIDER_BASE_URL)'), reasoning_levels: [] }], default_model: byok, default_effort: null }
    // The list probed from the TUI /model menu (auto always first); without a cache, auto alone
    const probed = cachedModelProbe('copilot')?.models
    const models = probed?.length ? probed : [{ slug: 'auto', display_name: 'Auto', description: t('Copilot picks a model available to the current account'), reasoning_levels: [] }]
    return { runtime: 'copilot', models, default_model: 'auto', default_effort: null }
  }

  function parseCopilotMenuModels(raw) {
    const out = [{ slug: 'auto', display_name: 'Auto', description: t('Copilot picks a model available to the current account'), reasoning_levels: [] }]
    const seen = new Set(['auto'])
    for (const line of stripAnsi(raw).split('\n')) {
      // The selected row carries a marker such as ❯ or ●; strip it. A description
      // column may follow after two spaces.
      const entry = line.trim().replace(/^[❯●→>•*]+\s*/, '')
      if (!entry || entry.length > 64) continue
      const m = entry.match(/^([a-z][a-z0-9]*(?:-[a-z0-9.]+)+)(?:\s{2,}.*)?$/)
      if (!m || !/\d/.test(m[1]) || seen.has(m[1])) continue
      seen.add(m[1])
      out.push({ slug: m[1], display_name: m[1], description: t('Probed from the local Copilot CLI /model menu'), reasoning_levels: [] })
    }
    return out.length > 1 ? out : []
  }

  function copilotRuntimeSetup(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-copilot-'))
    fs.chmodSync(root, 0o700)
    fs.writeFileSync(path.join(root, 'opentandem.instructions.md'), [
      '---',
      'applyTo: "**"',
      '---',
      '',
      runtimeInstructions(run),
    ].join('\n'), { mode: 0o600 })
    return { instructionsDir: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  function copilotArgs(run, localImages, instruction) {
    const argv = ['--output-format', 'json', '--no-ask-user']
    if (run.exec_mode === 'readonly') argv.push('--plan', '--allow-all-tools')
    else argv.push('--allow-all')
    if (run.model && run.model !== 'auto') argv.push('--model', run.model)
    if (run.reasoning_effort) argv.push('--reasoning-effort', run.reasoning_effort)
    if (run.resume_thread_id) argv.push('-r', run.resume_thread_id)
    for (const image of localImages) argv.push('--attachment', image)
    argv.push('--additional-mcp-config', JSON.stringify({ mcpServers: { opentandem: toolServerSpec(run) } }))
    // Copilot requires an explicit opt-in before MCP initialize.instructions are
    // included in its system prompt.
    argv.push('--allow-all-mcp-server-instructions')
    return { argv, stdinText: instruction, cwd: run.workdir || undefined }
  }

  function copilotHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolById = new Map()
    const labelFor = (name, input) => {
      const arg = input?.command ?? input?.filePath ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    // With BYOK (a self-configured model service) messages carry no phase; the
    // last assistant message without tool calls is the answer
    let answered = false
    let lastPlain = ''
    return {
      line(event) {
        if (!isMainSession(event.sessionId)) return
        if (event.type === 'assistant.message' && event.data?.phase === 'final_answer' && typeof event.data.content === 'string') {
          answered = true
          ctx.setFullText(event.data.content)
          ctx.pump.push({ type: 'content_delta', data: { text: event.data.content } })
          return
        }
        if (event.type === 'assistant.message' && !event.data?.phase && typeof event.data?.content === 'string'
          && event.data.content && !(event.data.toolRequests || []).length) {
          lastPlain = event.data.content
          return
        }
        if (event.type === 'tool.execution_start') {
          const data = event.data || {}
          const label = labelFor(data.toolName || 'tool', data.arguments || {})
          const rec = { kind: 'command', label, status: 'running', output: '' }
          ctx.reasoningParts.push(rec)
          if (data.toolCallId) toolById.set(data.toolCallId, rec)
          ctx.pump.push({ type: 'tool_event', data: { id: data.toolCallId, kind: 'command', label, status: 'running' } })
          return
        }
        if (event.type === 'tool.execution_complete') {
          const data = event.data || {}
          const rec = data.toolCallId ? toolById.get(data.toolCallId) : undefined
          const raw = data.result?.content ?? data.result?.detailedContent ?? ''
          const output = typeof raw === 'string' ? raw.slice(0, 2000) : ''
          if (rec) { rec.status = 'done'; rec.output = output }
          ctx.pump.push({ type: 'tool_event', data: { id: data.toolCallId, kind: 'command', label: rec?.label || data.toolName || 'tool', status: 'done', output } })
          return
        }
        if (event.type === 'result') {
          if (typeof event.sessionId === 'string') ctx.setSession(event.sessionId)
          if (event.exitCode !== 0) ctx.setErrorText(`Copilot CLI result exitCode ${event.exitCode}`)
          if (!answered && lastPlain) {
            answered = true
            ctx.setFullText(lastPlain)
            ctx.pump.push({ type: 'content_delta', data: { text: lastPlain } })
          }
        }
      },
      flush() {},
    }
  }

  const copilotEventsPath = (sessionId) =>
    path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl')

  async function compactCopilot(sessionId, workdir) {
    const events = copilotEventsPath(sessionId)
    // Read only what THIS call appends: the whole events.jsonl may hold an older
    // compaction_complete from an automatic compaction, which would report an
    // old event as this result.
    let offset = 0
    try { offset = (await fs.promises.stat(events)).size } catch { return { error: t('Copilot session {sessionId} has no events file', { sessionId }) } }
    const argv = ['-p', '/compact', '--resume', sessionId, '--allow-all-tools', '--output-format', 'json', '--log-level', 'none']
    if (workdir) argv.push('-C', workdir)
    const exit = await new Promise(resolve => {
      const child = spawn(COPILOT_BIN, argv, {
        stdio: ['ignore', 'pipe', 'pipe'], cwd: workdir || undefined, env: process.env,
        detached: process.platform !== 'win32',
      })
      const timer = setTimeout(() => { killCompactChild(child); resolve('timeout') }, COMPACT_TIMEOUT_MS)
      child.stdout.resume(); child.stderr.resume()
      child.on('error', e => { clearTimeout(timer); resolve(`spawn:${e.message}`) })
      child.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    let done = null
    try {
      const handle = await fs.promises.open(events, 'r')
      let buf
      try {
        const size = (await handle.stat()).size
        buf = Buffer.alloc(Math.max(0, size - offset))
        if (buf.length) await handle.read(buf, 0, buf.length, offset)
      } finally { await handle.close().catch(() => {}) }
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('session.compaction_complete')) continue
        try { done = JSON.parse(line) } catch { /* partial line */ }
      }
    } catch (e) {
      return { error: t('Copilot events file unreadable after compaction: {detail}', { detail: e.message }) }
    }
    // Exit code 0 is NOT evidence of success here: asking the model /compact as
    // a plain question also exits 0. Only session.compaction_complete counts.
    if (!done) return { error: t('Copilot sent no compaction-complete event (process result: {exit})', { exit }) }
    const d = done.data || {}
    if (d.success === false) return { error: t('Copilot compaction failed: {detail}', { detail: d.error || t('no reason given') }) }
    return {
      ok: true,
      detail: t('Copilot finished native compaction and removed {count} history messages', { count: d.messagesRemoved ?? t('several') }),
      tokens_before: Number.isFinite(d.preCompactionTokens) ? d.preCompactionTokens : undefined,
      tokens_after: Number.isFinite(d.postCompactionTokens) ? d.postCompactionTokens : undefined,
    }
  }

  return {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    executes: true,
    bin: () => COPILOT_BIN,
    detect: collectCopilot,
    models: () => copilotGroup(),
    probe: {
      key: 'copilot',
      label: t('Copilot CLI TUI /model menu'),
      run: async () => {
        // copilot takes ~18 s to start (the first start shows a "trust this
        // folder" prompt; Enter accepts the default), then /model + Enter opens
        // the menu and Esc closes it. Loose prompt/menu markers; a timeout is the fallback.
        const res = await probeTui(COPILOT_BIN, [], [
          { waitMs: 18_000, write: '\r' },
          { waitFor: '❯|>|/', timeoutMs: 8_000, write: '/model' },
          { waitMs: 1_500, write: '\r' },
          { waitFor: 'gpt-|claude-|gemini-|Select|model', timeoutMs: 15_000, write: '\x1b' },
        ], 60_000)
        if (!res.ok) return res
        const models = parseCopilotMenuModels(res.raw)
        return models.length ? { ok: true, models } : { ok: false, error: t('No models could be parsed from the /model menu (the CLI may not be ready or its interface changed)') }
      },
    },
    install: {
      oneClick: npmInstall('copilot', '@github/copilot'),
      npmPackage: () => '@github/copilot',
    },
    nativeInstructions: true,
    session: files.session,
    ownFiles: createCopilotFiles,
    toolSetup: copilotRuntimeSetup,
    command: copilotArgs,
    processEnv: (env, { setup }) => {
      if (setup) {
        env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = [
          process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS,
          setup.instructionsDir,
        ].filter(Boolean).join(',')
      }
    },
    handler: copilotHandler,
    compact: (id, workdir) => compactCopilot(id, workdir),
    purgeSide: files.purgeSide,
  }
}
