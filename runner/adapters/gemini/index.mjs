// Gemini CLI (`gemini`): headless stream-json runs with an isolated GEMINI_CLI_HOME carrying the tool server config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mainSessionEventGuard, npmInstall } from '../../core/agent-kit/kit.mjs'
import { createGeminiApi } from '../../core/agent-kit/gemini-api.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createGeminiFiles(io) {
  const { fs, os, path } = io

  /** Gemini CLI chats: ~/.gemini/tmp/<project>/chats/session-<ts>-<first 8 chars of sid>.jsonl.
   *  The file name carries only the first 8 characters of the session id and project dir names
   *  mix old and new formats (hash / basename), so every project dir is scanned. A half-made
   *  session with only user records is rejected by Gemini --resume; it needs at least one
   *  resumable Gemini output, otherwise the session is rebuilt from the full context. */
  function geminiSessionPath(sessionId) {
    if (!sessionId) return ''
    const root = path.join(os.homedir(), '.gemini', 'tmp')
    const tag = `-${String(sessionId).slice(0, 8)}.jsonl`
    const hasGeminiOutput = (message) => {
      if (!message || message.type !== 'gemini') return false
      const content = typeof message.content === 'string'
        ? message.content.trim()
        : Array.isArray(message.content)
          ? message.content.some(part => typeof part?.text === 'string' && part.text.trim())
          : false
      return !!content || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
        || (Array.isArray(message.thoughts) && message.thoughts.length > 0)
    }
    try {
      for (const dir of fs.readdirSync(root)) {
        try {
          const chats = path.join(root, dir, 'chats')
          for (const file of fs.readdirSync(chats)) {
            if (!file.startsWith('session-') || !file.endsWith(tag)) continue
            const lines = fs.readFileSync(path.join(chats, file), 'utf8').split('\n')
            for (const line of lines) {
              if (!line.trim()) continue
              const record = JSON.parse(line)
              if (hasGeminiOutput(record)) return path.join(chats, file)
              if (Array.isArray(record?.$set?.messages) && record.$set.messages.some(hasGeminiOutput)) return path.join(chats, file)
            }
          }
        } catch { /* no chats dir here */ }
      }
    } catch { /* no ~/.gemini/tmp at all */ }
    return ''
  }

  function geminiSessionExists(sessionId) {
    return !!geminiSessionPath(sessionId)
  }

  return {
    session: { path: id => geminiSessionPath(id), exists: id => geminiSessionExists(id) },
    purgeSide: ({ home, base, rmNamed }) => {
        rmNamed('.gemini', 'tmp')
        rmNamed('.gemini', 'history')
        // Project registry {projects: {<dir>: <short name>}}: drop this temp dir's entry
        const reg = path.join(home, '.gemini', 'projects.json')
        try {
          const data = JSON.parse(fs.readFileSync(reg, 'utf8'))
          const keys = Object.keys(data?.projects || {}).filter(k => k.includes(base))
          if (keys.length) {
            for (const k of keys) delete data.projects[k]
            fs.writeFileSync(reg + '.ot-tmp', JSON.stringify(data, null, 2))
            fs.renameSync(reg + '.ot-tmp', reg)
          }
        } catch { /* no registry */ }
      },
  }
}

export function createGeminiAdapter(ctx) {
  const { execFile, VERSION_PROBE_MS, cachedModelProbe, runtimeInstructions, toolServerSpec, t } = ctx
  const files = createGeminiFiles({ fs, os, path })
  const geminiApi = createGeminiApi(ctx)
  const GEMINI_BIN = ctx.config('GEMINI_BIN') || 'gemini'

  function collectGemini() {
    const run = (args, timeout) => new Promise((resolve) => {
      execFile(GEMINI_BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : String(stdout)))
    })
    return (async () => {
      const version = await run(['--version'], VERSION_PROBE_MS)
      if (version === null) return { installed: false, login: false, version: null }
      return { installed: true, login: true, version: version.trim().split('\n')[0] }
    })()
  }

  /** Static catalog (gemini has no models subcommand). Which models work depends on this
   *  machine's paid tier (a free API key only gets the flash family + auto); picking an
   *  unavailable model fails with the API's own message, so tiers are not probed here. There
   *  is no reasoning-level flag, so reasoning_levels is always empty. */
  const GEMINI_MODELS = [
    { slug: 'auto', display_name: 'Auto', description: t('Gemini CLI routes automatically, picking a model by task difficulty'), reasoning_levels: [] },
    { slug: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', description: t('Fast; works with a free API key'), reasoning_levels: [] },
    { slug: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', description: t('Fastest; suited to simple batch tasks'), reasoning_levels: [] },
    { slug: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview', description: t('Strongest reasoning; a free API key without enough quota gets 429'), reasoning_levels: [] },
  ]

  async function geminiGroup() {
    const g = await collectGemini().catch(() => ({ installed: false, login: false }))
    if (!g.installed) return null
    // The upstream v1beta/models probe (the tiers the local key really has); auto is the CLI's
    // own routing, absent upstream, so it always comes first. Without a cached probe fall back
    // to the built-in table.
    const upstream = cachedModelProbe('gemini_upstream')?.models
    const models = upstream?.length
      ? [{ slug: 'auto', display_name: 'Auto', description: t('Gemini CLI routes automatically, picking a model by task difficulty'), reasoning_levels: [] }, ...upstream]
      : GEMINI_MODELS
    return { runtime: 'gemini', models, default_model: 'auto', default_effort: null }
  }

  /** Gemini has no one-shot --mcp-config flag. Give just this process a temporary
   *  user-home view: settings are merged, while credentials, extensions and the
   *  session store remain symlinked to the real ~/.gemini. */
  function geminiScheduleMcpHome(run) {
    let settings = {}
    const realDir = path.join(os.homedir(), '.gemini')
    const original = path.join(realDir, 'settings.json')
    try {
      if (fs.existsSync(original)) {
        const parsed = JSON.parse(fs.readFileSync(original, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed
      }
    } catch (e) {
      console.warn(`[daemon] could not merge Gemini system settings: ${e.message}`)
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-gemini-home-'))
    fs.chmodSync(home, 0o700)
    const dir = path.join(home, '.gemini')
    fs.mkdirSync(dir, { mode: 0o700 })
    try {
      for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
        if (entry.name === 'settings.json' || entry.name === 'GEMINI.md') continue
        fs.symlinkSync(path.join(realDir, entry.name), path.join(dir, entry.name), entry.isDirectory() ? 'dir' : 'file')
      }
    } catch (e) {
      console.warn(`[daemon] could not mirror all Gemini user files: ${e.message}`)
    }
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({
      ...settings,
      mcpServers: {
        ...(settings.mcpServers || {}),
        opentandem: {
          ...toolServerSpec(run),
          trust: true,
          description: t('OpenTandem scheduled task tools'),
        },
      },
    }), { mode: 0o600 })
    let existingInstructions = ''
    try { existingInstructions = fs.readFileSync(path.join(realDir, 'GEMINI.md'), 'utf8').trimEnd() } catch {}
    fs.writeFileSync(path.join(dir, 'GEMINI.md'),
      `${existingInstructions}${existingInstructions ? '\n\n' : ''}${runtimeInstructions(run)}\n`, { mode: 0o600 })
    return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
  }

  /** Gemini CLI headless: `-p ''` means "headless, body on stdin" (verified on 0.60.0; help text
   *  "Appended to input on stdin"), so a large prompt stays out of argv. Read-only =
   *  --approval-mode plan, otherwise yolo. Model auto is its own default routing, so no -m.
   *  Workspace trust is granted with the GEMINI_CLI_TRUST_WORKSPACE=true env var (see
   *  processEnv): with --skip-trust the approval mode silently drops back to default, every
   *  tool then waits for manual approval in headless mode, and with nobody there it hangs.
   *  Images have no dedicated flag; their paths go into the prompt and read_file opens them. */
  function geminiArgs(run, localImages, instruction) {
    const argv = ['-o', 'stream-json', '--approval-mode', run.exec_mode === 'readonly' ? 'plan' : 'yolo', '-p', '']
    if (run.model && run.model !== 'auto') argv.push('-m', run.model)
    if (run.resume_thread_id) argv.push('-r', run.resume_thread_id)
    const stdinText = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with the read_file tool)]\n${localImages.join('\n')}`
      : instruction
    return { argv, stdinText, cwd: run.workdir || undefined }
  }

  /**
   * gemini `-o stream-json` → the same StreamEvents. Line shapes (verified on 0.60.0):
   *   {type:'init', session_id, model}
   *   {type:'message', role:'user'|'assistant', content, delta:true}   assistant chunks streamed
   *   {type:'tool_use', tool_name, tool_id, parameters:{…}}
   *   {type:'tool_result', tool_id, status:'success'|'error', output}
   *   {type:'result', status, error?:{message}, stats:{input_tokens, output_tokens, …}}
   *
   * Assistant chunks carry no message boundary: chunks accumulate in a buffer, a tool_use
   * flushes the buffer as narration (reasoning), and whatever remains when the process ends is
   * the final answer (flush promotes it to content). input_tokens already includes cache hits.
   */
  function geminiHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolById = new Map()
    let buf = ''
    const labelFor = (name, params) => {
      const arg = params?.command ?? params?.file_path ?? params?.absolute_path ?? params?.path ?? params?.pattern ?? params?.url ?? params?.prompt
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    const flushNarration = () => {
      if (!buf) return
      ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: buf })
      ctx.pump.push({ type: 'reasoning_delta', data: { text: buf } })
      buf = ''
    }
    return {
      line(event) {
        if (!isMainSession(event.session_id)) return
        switch (event.type) {
          case 'init': {
            if (typeof event.session_id === 'string' && event.session_id) ctx.setSession(event.session_id)
            break
          }
          case 'message': {
            if (event.role === 'assistant' && typeof event.content === 'string') buf += event.content
            break
          }
          case 'tool_use': {
            flushNarration()
            const label = labelFor(event.tool_name || 'tool', event.parameters || {})
            const rec = { kind: 'command', label, status: 'running', output: '' }
            ctx.reasoningParts.push(rec)
            if (event.tool_id) toolById.set(event.tool_id, rec)
            ctx.pump.push({ type: 'tool_event', data: { id: event.tool_id, kind: 'command', label, status: 'running' } })
            break
          }
          case 'tool_result': {
            const rec = event.tool_id ? toolById.get(event.tool_id) : undefined
            const output = typeof event.output === 'string' ? event.output.slice(0, 2000) : ''
            if (rec) { rec.status = 'done'; rec.output = output }
            ctx.pump.push({ type: 'tool_event', data: { id: event.tool_id, kind: 'command', label: rec?.label || 'tool', status: 'done', output } })
            break
          }
          case 'result': {
            if (event.stats) {
              ctx.tokens.input += event.stats.input_tokens || 0
              ctx.tokens.output += event.stats.output_tokens || 0
            }
            if (event.status === 'error') ctx.setErrorText(String(event.error?.message || 'Gemini CLI error'))
            break
          }
        }
      },
      flush() {
        if (!buf) return
        ctx.setFullText(buf)
        ctx.pump.push({ type: 'content_delta', data: { text: buf } })
        buf = ''
      },
    }
  }

  return {
    id: 'gemini',
    label: 'Gemini CLI',
    executes: true,
    bin: () => GEMINI_BIN,
    detect: collectGemini,
    models: () => geminiGroup(),
    probe: geminiApi.upstreamProbe,
    nativeInstructions: true,
    install: { oneClick: npmInstall('gemini', '@google/gemini-cli'), npmPackage: () => '@google/gemini-cli' },
    session: files.session,
    ownFiles: createGeminiFiles,
    toolSetup: geminiScheduleMcpHome,
    command: geminiArgs,
    handler: geminiHandler,
    systemProxy: true,
    processEnv: (env, { setup }) => {
      if (setup) env.GEMINI_CLI_HOME = setup.home
      geminiApi.keyEnv(env)
      // See geminiArgs: trust is granted through the env var, not --skip-trust
      env.GEMINI_CLI_TRUST_WORKSPACE = 'true'
    },
    purgeSide: files.purgeSide,
  }
}
