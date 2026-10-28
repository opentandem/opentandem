// Kimi Code (`kimi`): headless stream-json runs with an isolated KIMI_CODE_HOME carrying the tool server config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configOverlay, mainSessionEventGuard, mergedMcpJson, scriptInstall } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createKimiFiles(io) {
  const { fs, os, path } = io

  /** Kimi Code: ~/.kimi-code/session_index.jsonl has one session per line; look up the id directly. */
  function kimiSessionPath(sessionId) {
    if (!sessionId) return ''
    const file = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl')
    try {
      return fs.readFileSync(file, 'utf8').includes(`"sessionId":"${sessionId}"`) ? file : ''
    } catch { return '' }
  }

  function kimiSessionExists(sessionId) {
    return !!kimiSessionPath(sessionId)
  }

  return {
    session: { path: id => kimiSessionPath(id), exists: id => kimiSessionExists(id) },
    purgeSide: ({ rmNamed, dropLines }) => {
        rmNamed('.kimi-code', 'sessions')
        dropLines('.kimi-code', 'session_index.jsonl')
      },
  }
}

export function createKimiAdapter(ctx) {
  const { execFile, VERSION_PROBE_MS, runtimeInstructions, toolServerSpec, t, persistOverlay } = ctx
  const files = createKimiFiles({ fs, os, path })
  const KIMI_BIN = ctx.config('KIMI_BIN') || 'kimi'

  function collectKimi() {
    const run = (args, timeout) => new Promise((resolve) => {
      execFile(KIMI_BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : String(stdout)))
    })
    return (async () => {
      const version = await run(['--version'], VERSION_PROBE_MS)
      if (version === null) return { installed: false, login: false, version: null }
      return { installed: true, login: true, version: version.trim().split('\n')[0] }
    })()
  }

  /** The model catalog comes from the [models."<alias>"] sections of ~/.kimi-code/config.toml
   *  (kimi has no models subcommand and `provider list` gives a count, not names). Splitting
   *  on a leading `[` is enough, no TOML parser. Thinking models have support_efforts, but the
   *  CLI has no per-call level flag, so reasoning_levels is not reported (the UI hides the picker). */
  async function kimiGroup() {
    const k = await collectKimi().catch(() => ({ installed: false, login: false }))
    if (!k.installed) return null
    const models = []
    let defaultModel = null
    try {
      const toml = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'config.toml'), 'utf8')
      defaultModel = toml.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] || null
      const heads = [...toml.matchAll(/^\[models\."([^"]+)"\]/gm)]
      for (let i = 0; i < heads.length; i++) {
        const start = heads[i].index + heads[i][0].length
        const relEnd = toml.slice(start).search(/^\[/m)
        const body = relEnd === -1 ? toml.slice(start) : toml.slice(start, start + relEnd)
        const display = body.match(/^display_name\s*=\s*"([^"]+)"/m)?.[1]
        models.push({ slug: heads[i][1], display_name: display || heads[i][1], reasoning_levels: [] })
      }
    } catch { /* config unreadable — fall through to the shipped default */ }
    if (!models.length) models.push({ slug: 'kimi-code/k3', display_name: 'K3', reasoning_levels: [] })
    return {
      runtime: 'kimi',
      models,
      default_model: models.some(m => m.slug === defaultModel) ? defaultModel : models[0].slug,
      default_effort: null,
    }
  }

  function kimiScheduleMcpHome(run) {
    const realDir = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
    let existingSystem = ''
    try { existingSystem = fs.readFileSync(path.join(realDir, 'SYSTEM.md'), 'utf8').trimEnd() } catch {}
    const systemPrompt = existingSystem || '${base_prompt}'
    return configOverlay(realDir, 'opentandem-kimi-home-', {
      'mcp.json': mergedMcpJson(path.join(realDir, 'mcp.json'), toolServerSpec(run)),
      'SYSTEM.md': `${systemPrompt}\n\n${runtimeInstructions(run)}\n`,
    }, persistOverlay)
  }

  /** Kimi Code headless: --plan/--yolo/--auto all conflict with -p (0.29.2 reports "Cannot
   *  combine") and prompt mode approves tools automatically, so there is only full access and
   *  exec_mode has nothing to map to (the server already folds it to full). The prompt goes in
   *  -p, not stdin (kimi does not read piped input); resuming uses -r (exactly what resume_hint
   *  suggests). There is no reasoning-level flag, so reasoning_effort is ignored. */
  function kimiArgs(run, localImages, instruction) {
    const argv = ['--output-format', 'stream-json']
    if (run.model) argv.push('-m', run.model)
    if (run.resume_thread_id) argv.push('-r', run.resume_thread_id)
    const prompt = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with your file-reading tool)]\n${localImages.join('\n')}`
      : instruction
    argv.push('-p', prompt)
    return { argv, stdinText: '', cwd: run.workdir || undefined }
  }

  /**
   * kimi `--output-format stream-json` → the same StreamEvents. Lines are flat OpenAI-style
   * messages (verified on 0.29.2); a tool's raw stdout is mixed into standard output, but
   * executeRun's per-line try/parse drops non-JSON lines, so only valid lines arrive here:
   *   {role:'assistant', content:'…'}                              a whole message, not chunked
   *   {role:'assistant', tool_calls:[{id, function:{name, arguments}}]}
   *   {role:'tool', tool_call_id, content}
   *   {role:'meta', type:'session.resume_hint', session_id}
   * There is no usage event, so tokens stay 0 (quota is visible on the Kimi subscription side).
   * The last assistant content is the answer; earlier ones become narration (as with codex).
   */
  function kimiHandler(ctx) {
    const toolById = new Map()
    let lastMessage = ''
    const labelFor = (name, rawArgs) => {
      let input = {}
      try { input = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {}) } catch { /* keep {} */ }
      const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    return {
      line(event) {
        if (event.role === 'meta') {
          if (event.type === 'session.resume_hint' && typeof event.session_id === 'string') ctx.setSession(event.session_id)
          return
        }
        if (event.role === 'assistant') {
          if (Array.isArray(event.tool_calls)) {
            for (const call of event.tool_calls) {
              const label = labelFor(call?.function?.name || 'tool', call?.function?.arguments)
              const rec = { kind: 'command', label, status: 'running', output: '' }
              ctx.reasoningParts.push(rec)
              if (call?.id) toolById.set(call.id, rec)
              ctx.pump.push({ type: 'tool_event', data: { id: call?.id, kind: 'command', label, status: 'running' } })
            }
          }
          if (typeof event.content === 'string' && event.content) {
            if (lastMessage) {
              ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: lastMessage })
              ctx.pump.push({ type: 'reasoning_delta', data: { text: lastMessage } })
            }
            lastMessage = event.content
          }
          return
        }
        if (event.role === 'tool') {
          const rec = event.tool_call_id ? toolById.get(event.tool_call_id) : undefined
          const output = typeof event.content === 'string' ? event.content.slice(0, 2000) : ''
          if (rec) { rec.status = 'done'; rec.output = output }
          ctx.pump.push({ type: 'tool_event', data: { id: event.tool_call_id, kind: 'command', label: rec?.label || 'tool', status: 'done', output } })
        }
      },
      flush() {
        if (!lastMessage) return
        ctx.setFullText(lastMessage)
        ctx.pump.push({ type: 'content_delta', data: { text: lastMessage } })
        lastMessage = ''
      },
    }
  }

  return {
    id: 'kimi',
    label: 'Kimi Code',
    executes: true,
    bin: () => KIMI_BIN,
    detect: collectKimi,
    models: () => kimiGroup(),
    nativeInstructions: true,
    install: {
      oneClick: scriptInstall('https://code.kimi.com/kimi-code/install.sh', [path.join(os.homedir(), '.kimi-code', 'bin')]),
      native: (real, home) => real.startsWith(`${home}/.kimi-code/bin/`),
      pip: (real) => /\/(?:uv\/tools|pipx\/venvs)\/kimi-cli\//.test(real),
    },
    session: files.session,
    ownFiles: createKimiFiles,
    toolSetup: kimiScheduleMcpHome,
    command: kimiArgs,
    handler: kimiHandler,
    processEnv: (env, { setup }) => {
      if (setup) env.KIMI_CODE_HOME = setup.home
      env.KIMI_DISABLE_CRON = '1'
    },
    purgeSide: files.purgeSide,
  }
}
