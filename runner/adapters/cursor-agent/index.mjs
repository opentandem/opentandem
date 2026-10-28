// Cursor Agent CLI (`cursor-agent`, earlier preview builds `agent`):
// headless `-p --output-format stream-json` runs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mainSessionEventGuard, scriptInstall } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createCursorAgentFiles(io) {
  const { fs, os, path } = io

  /** Cursor stores one transcript under each project slug. A task may move to a
   * different workdir between turns, so search the machine-local project roots
   * by session id instead of reconstructing one slug from the current cwd. */
  function cursorAgentSessionExists(sessionId) {
    return !!cursorAgentSessionPath(sessionId)
  }

  function cursorAgentSessionPath(sessionId) {
    if (!sessionId) return false
    const root = path.join(os.homedir(), '.cursor', 'projects')
    try {
      for (const project of fs.readdirSync(root)) {
        const file = path.join(root, project, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
        if (fs.existsSync(file)) return file
      }
    } catch { /* no ~/.cursor/projects */ }
    return ''
  }

  return {
    session: { path: id => cursorAgentSessionPath(id), exists: id => cursorAgentSessionExists(id) },
    purgeSide: ({ home, sid, rm, rmNamed }) => {
        rmNamed('.cursor', 'projects')
        if (sid) {
          // chats/<working-directory hash>/<session id>/
          let hashes = []
          try { hashes = fs.readdirSync(path.join(home, '.cursor', 'chats')) } catch { /* none */ }
          for (const h of hashes) rm(path.join(home, '.cursor', 'chats', h, sid))
        }
      },
  }
}

export function createCursorAgentAdapter(ctx) {
  const { cliProbe, commandExists, cachedModelProbe, probeCliOutput, runtimeInstructions, t } = ctx
  const files = createCursorAgentFiles({ fs, os, path })
  // Status-only CLIs: shown in the machine panel even before they have a task
  // execution adapter. Detection must never make them selectable as runtimes.
  // Cursor's current official CLI command is `cursor-agent`.  Keep `agent` as a
  // fallback for machines that installed the earlier preview CLI, but never let
  // that legacy name hide a current installation.
  // Cursor's current official CLI command is `cursor-agent`. Keep `agent` as a
  // fallback for machines that installed the earlier preview CLI, but never let
  // that legacy name hide a current installation.
  const CURSOR_AGENT_BIN = ctx.config('CURSOR_AGENT_BIN') || (commandExists('cursor-agent') ? 'cursor-agent' : 'agent')

  async function collectCursorAgent() {
    const version = await cliProbe(CURSOR_AGENT_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  /** `agent --list-models` also lists models the current plan cannot use (a
   *  free account picking composer-2.5 gets "Free plans can only use Auto"). The
   *  catalog cannot express entitlement: auto is always the default (every
   *  signed-in account can use it, verified on a real machine), the probed
   *  entries are listed as they are, and a failing pick surfaces the real error. */
  async function cursorAgentGroup() {
    const status = await collectCursorAgent().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    const probed = cachedModelProbe('cursor_agent')?.models
    const models = probed?.length ? probed : [{ slug: 'auto', display_name: 'Auto', description: t('Cursor picks the model for the current account and task'), reasoning_levels: [] }]
    return { runtime: 'cursor_agent', models, default_model: 'auto', default_effort: null }
  }

  function parseCursorModelsText(stdout) {
    const out = []
    const seen = new Set()
    for (const line of String(stdout).split('\n')) {
      const m = line.trim().match(/^(auto|[a-z][a-z0-9]*(?:-[a-z0-9.]+)+)\s+-\s+(.+)$/)
      if (!m || seen.has(m[1])) continue
      seen.add(m[1])
      out.push({ slug: m[1], display_name: m[2].replace(/\s*\((?:current|default)[^)]*\)/gi, '').trim() || m[1], description: t('Probed from the local agent --list-models'), reasoning_levels: [] })
    }
    // auto always comes first: it is the default (free or unlicensed accounts can only run auto)
    out.sort((a, b) => (a.slug === 'auto' ? -1 : b.slug === 'auto' ? 1 : 0))
    return out
  }

  function cursorHelpSetup(run) {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-cursor-help-'))
    fs.mkdirSync(path.join(pluginDir, '.cursor-plugin'))
    fs.mkdirSync(path.join(pluginDir, 'rules'))
    fs.writeFileSync(path.join(pluginDir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'opentandem-help', version: '1.0.0', rules: './rules/' }), { mode: 0o600 })
    fs.writeFileSync(path.join(pluginDir, 'rules', 'help.mdc'), `---\nalwaysApply: true\n---\n${runtimeInstructions(run)}\n`, { mode: 0o600 })
    return { pluginDir, cleanup: () => fs.rmSync(pluginDir, { recursive: true, force: true }) }
  }

  /** Cursor Agent CLI headless mode, verified on a real machine with 2026.09.10:
   *  - unattended runs need --trust even in plan mode, or they exit at the
   *    Workspace Trust prompt;
   *  - plan is a verifiable read-only boundary; writing modes need --force;
   *  - stdin carries the full prompt, keeping long history out of argv;
   *  - --stream-partial-output sends both text chunks and the complete message,
   *    and the handler removes the duplicate;
   *  - the catalog does not express plan entitlement, so Auto is the default. */
  function cursorAgentArgs(run, localImages, instruction, pluginDir) {
    const argv = ['-p', '--trust', '--output-format', 'stream-json', '--stream-partial-output']
    if (pluginDir) argv.push('--plugin-dir', pluginDir)
    if (run.exec_mode === 'readonly') argv.push('--mode', 'plan')
    else argv.push('--force')
    argv.push('--model', run.model || 'auto')
    if (run.resume_thread_id) argv.push('--resume', run.resume_thread_id)
    const stdinText = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with the Read tool)]\n${localImages.join('\n')}`
      : instruction
    return { argv, stdinText, cwd: run.workdir || undefined }
  }

  /** Cursor Agent CLI `--output-format stream-json --stream-partial-output`
   * first sends timestamp_ms text chunks and then one complete assistant message
   * without a timestamp; appending both would show the final answer twice. The
   * chunks are held back: a tool call turns them into progress notes, and only
   * the complete message or result is emitted as the final answer, once. */
  function cursorAgentHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolById = new Map()
    let pendingAssistant = ''
    let finalText = ''

    const messageText = (event) => {
      const content = event?.message?.content
      return Array.isArray(content)
        ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
        : ''
    }
    const toolData = (event) => {
      const call = event?.tool_call || {}
      const pair = Object.entries(call).find(([key, value]) => key.endsWith('ToolCall') && value && typeof value === 'object')
      if (!pair) return { name: 'tool', args: {}, result: null }
      return { name: pair[0].replace(/ToolCall$/, ''), args: pair[1].args || {}, result: pair[1].result || null }
    }
    const labelFor = (name, args) => {
      const value = args.command ?? args.path ?? args.targetDirectory ?? args.pattern ?? args.url
      const detail = typeof value === 'string' ? value : ''
      return detail ? `${name}(${detail.length > 300 ? detail.slice(0, 300) + '…' : detail})` : name
    }
    const narratePending = () => {
      if (!pendingAssistant) return
      ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: pendingAssistant })
      ctx.pump.push({ type: 'reasoning_delta', data: { text: pendingAssistant } })
      pendingAssistant = ''
    }
    const emitFinal = (text) => {
      if (!text || text === finalText) { pendingAssistant = ''; return }
      pendingAssistant = ''
      finalText = text
      ctx.setFullText(text)
      ctx.pump.push({ type: 'content_delta', data: { text } })
    }

    return {
      line(event) {
        if (!isMainSession(event.session_id)) return
        if (event.type === 'system' && event.subtype === 'init') {
          if (typeof event.session_id === 'string') ctx.setSession(event.session_id)
          return
        }
        if (event.type === 'thinking' && event.subtype === 'delta' && typeof event.text === 'string') {
          ctx.reasoningParts.push({ kind: 'reasoning', label: event.text })
          ctx.pump.push({ type: 'reasoning_delta', data: { text: event.text } })
          return
        }
        if (event.type === 'assistant') {
          const text = messageText(event)
          if (!text) return
          if (typeof event.timestamp_ms === 'number') pendingAssistant += text
          else emitFinal(text)
          return
        }
        if (event.type === 'tool_call') {
          const { name, args, result } = toolData(event)
          const label = labelFor(name, args)
          if (event.subtype === 'started') {
            narratePending()
            const rec = { kind: 'command', label, status: 'running', output: '' }
            ctx.reasoningParts.push(rec)
            if (event.call_id) toolById.set(event.call_id, rec)
            ctx.pump.push({ type: 'tool_event', data: { id: event.call_id, kind: 'command', label, status: 'running' } })
          } else if (event.subtype === 'completed') {
            const rec = event.call_id ? toolById.get(event.call_id) : undefined
            const output = result ? JSON.stringify(result).slice(0, 2000) : ''
            if (rec) { rec.status = 'done'; rec.output = output }
            ctx.pump.push({ type: 'tool_event', data: { id: event.call_id, kind: 'command', label: rec?.label || label, status: 'done', output } })
          }
          return
        }
        if (event.type === 'result') {
          if (event.usage) {
            ctx.tokens.input = event.usage.inputTokens ?? ctx.tokens.input
            ctx.tokens.output = event.usage.outputTokens ?? ctx.tokens.output
          }
          if (event.is_error || event.subtype === 'error') {
            ctx.setErrorText(String(event.result || event.error || 'Cursor Agent CLI error'))
            return
          }
          if (!finalText) emitFinal(pendingAssistant || (typeof event.result === 'string' ? event.result : ''))
        }
      },
      flush() {
        if (!finalText && pendingAssistant) emitFinal(pendingAssistant)
      },
    }
  }

  return {
    id: 'cursor_agent',
    label: 'Cursor Agent CLI',
    executes: true,
    bin: () => CURSOR_AGENT_BIN,
    detect: collectCursorAgent,
    models: () => cursorAgentGroup(),
    probe: {
      key: 'cursor_agent',
      label: 'agent --list-models',
      run: async () => {
        const res = await probeCliOutput(CURSOR_AGENT_BIN, ['--list-models'], 15_000, { NO_OPEN_BROWSER: '1' })
        if (!res.ok) return res
        const models = parseCursorModelsText(`${res.stdout}\n${res.stderr}`)
        return models.length ? { ok: true, models } : { ok: false, error: t('--list-models output could not be parsed: {output}', { output: res.stdout.slice(0, 120) || res.stderr || t('(empty)') }) }
      },
    },
    install: {
      oneClick: scriptInstall('https://cursor.com/install', [path.join(os.homedir(), '.local', 'bin')]),
      native: (real, home) => real.startsWith(`${home}/.local/share/cursor-agent/versions/`),
    },
    nativeInstructions: true,
    // Cursor Agent cannot read the inline help rule; it gets the help file path instead.
    helpFile: true,
    session: files.session,
    ownFiles: createCursorAgentFiles,
    toolSetup: cursorHelpSetup,
    command: (run, images, instruction, setup) => cursorAgentArgs(run, images, instruction, setup?.pluginDir),
    processEnv: (env) => {
      // Cursor Agent CLI 2026.09 can only read MCP servers from the user's
      // persistent .cursor/mcp.json. Do not mutate that file for one run;
      // expose the per-process OpenTandem fallback command instead.
      env.PATH = `${ctx.toolCommandDir()}${path.delimiter}${env.PATH || ''}`
    },
    handler: cursorAgentHandler,
    purgeSide: files.purgeSide,
  }
}
