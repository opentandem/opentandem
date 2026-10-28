// OpenClaw (`openclaw agent --local`): embedded runs with native session
// resume, using the model from the user's own OpenClaw configuration.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// What reads this agent's own session store. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createOpenclawFiles(io) {
  const { fs, os, path, SqliteDatabaseSync } = io
  const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // Same root as the adapter's openclawSessionsRoot(): one directory per session id.
  const sessionsRoot = () => process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenTandem', 'openclaw-sessions')
    : path.join(os.homedir(), '.local', 'share', 'opentandem', 'openclaw-sessions')

  /** OpenClaw's own "workspace has content" test (skip-bootstrap workspaces):
   *  everything except these names counts. */
  function workdirHasContent(dir) {
    try {
      return fs.readdirSync(dir).some(name => name !== '.DS_Store' && name !== '.openclaw' && name !== 'openclaw-workspace-state.json')
    } catch { return false }
  }

  /** Sessions live in SQLite, one database per agent:
   *  <session dir>/state/agents/<agentId>/agent/openclaw-agent.sqlite. An
   *  unknown --session-id silently starts an empty session, so only a session
   *  that has a window row there counts. Anything unreadable means "missing":
   *  the turn then rebuilds full context in a new session. */
  function openclawSessionPath(sessionId) {
    if (!sessionId || !SESSION_ID_RE.test(String(sessionId)) || !SqliteDatabaseSync) return ''
    const agentsDir = path.join(sessionsRoot(), String(sessionId).toLowerCase(), 'state', 'agents')
    let agents = []
    try { agents = fs.readdirSync(agentsDir) } catch { return '' }
    for (const agent of agents) {
      const dbPath = path.join(agentsDir, agent, 'agent', 'openclaw-agent.sqlite')
      if (!fs.existsSync(dbPath)) continue
      let db
      try {
        db = new SqliteDatabaseSync(dbPath, { readOnly: true })
        if (db.prepare('SELECT 1 AS hit FROM session_windows WHERE session_id = ? LIMIT 1').get(String(sessionId).toLowerCase())) return dbPath
      } catch { /* locked, older or newer schema: treat as missing */ } finally {
        try { db?.close() } catch { /* already closed */ }
      }
    }
    return ''
  }

  /** OpenClaw refuses to run in a workspace that had content at an earlier
   *  turn (within a day) but is empty now ("workspace appears to have
   *  disappeared"). The adapter marks a session once its folder had content; if
   *  that folder is empty now the session counts as missing, so the turn
   *  rebuilds full context in a new session instead of failing. */
  function openclawSessionExists(sessionId, workdir) {
    const dbPath = openclawSessionPath(sessionId)
    if (!dbPath) return false
    if (workdir && !workdirHasContent(workdir)) {
      return !fs.existsSync(path.join(sessionsRoot(), String(sessionId).toLowerCase(), 'workdir-had-content'))
    }
    return true
  }

  return {
    session: { path: id => openclawSessionPath(id), exists: (id, workdir) => openclawSessionExists(id, workdir) },
  }
}

export function createOpenclawAdapter(ctx) {
  const { cliProbe, SqliteDatabaseSync, t } = ctx
  const files = createOpenclawFiles({ fs, os, path, SqliteDatabaseSync })
  const IS_WIN = process.platform === 'win32'
  // OpenClaw is a global npm package starting with `#!/usr/bin/env node`, so it
  // runs on the node from the login-shell PATH (recent releases need Node 24+),
  // not on the Runner's own Node. When that openclaw or Node is too old, a
  // managed copy can live in ~/.local/share/opentandem/runtimes/openclaw: its
  // own Node 24, openclaw.json and state directory, with bin/openclaw as a
  // launcher that sets those variables, leaving the PATH openclaw, its gateway
  // and ~/.openclaw untouched. That directory wins when present (the same idea
  // as Hermes in ~/.local/bin); there is no one-click install for it yet.
  const OPENCLAW_MANAGED_DIR = path.join(os.homedir(), '.local', 'share', 'opentandem', 'runtimes', 'openclaw')
  const OPENCLAW_MANAGED_BIN = path.join(OPENCLAW_MANAGED_DIR, 'bin', 'openclaw')
  const OPENCLAW_BIN = ctx.config('OPENCLAW_BIN') || (!IS_WIN && fs.existsSync(OPENCLAW_MANAGED_BIN) ? OPENCLAW_MANAGED_BIN : 'openclaw')
  const USES_MANAGED = OPENCLAW_BIN === OPENCLAW_MANAGED_BIN
  // The launcher hard-codes the state and config variables, so runs call its
  // Node and entry script directly and set those variables per run. Probes keep
  // using the launcher.
  const MANAGED_NODE = path.join(OPENCLAW_MANAGED_DIR, 'node', 'bin', 'node')
  const MANAGED_ENTRY = path.join(OPENCLAW_MANAGED_DIR, 'node_modules', 'openclaw', 'openclaw.mjs')
  const RUN_DIRECT = USES_MANAGED && fs.existsSync(MANAGED_NODE) && fs.existsSync(MANAGED_ENTRY)
  const RUN_BIN = RUN_DIRECT ? MANAGED_NODE : OPENCLAW_BIN
  const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  /** Configuration file: the managed copy uses the openclaw.json in its own
   *  directory (as its launcher does); otherwise OPENCLAW_CONFIG_PATH, then
   *  OPENCLAW_STATE_DIR/openclaw.json, then ~/.openclaw/openclaw.json. */
  function openclawConfigPath() {
    if (USES_MANAGED) return path.join(OPENCLAW_MANAGED_DIR, 'openclaw.json')
    return process.env.OPENCLAW_CONFIG_PATH
      || path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw'), 'openclaw.json')
  }

  /** Runner-owned home of the per-session OpenClaw state, outside any task
   *  folder and outside the user's ~/.openclaw (same root as createOpenclawFiles). */
  function openclawSessionsRoot() {
    return IS_WIN
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenTandem', 'openclaw-sessions')
      : path.join(os.homedir(), '.local', 'share', 'opentandem', 'openclaw-sessions')
  }

  /** `agents.defaults.model.primary` (provider/model) is the model runs use
   *  without --model. The file is JSON5 (comments, trailing commas), so a
   *  failed parse falls back to matching the field by name; values pulled in by
   *  `$include` are out of reach and count as "not configured". */
  function openclawConfiguredModel() {
    let text = ''
    try { text = fs.readFileSync(openclawConfigPath(), 'utf8') } catch { return { model: '', provider: '' } }
    let ref = ''
    try {
      const model = JSON.parse(text)?.agents?.defaults?.model
      ref = typeof model === 'string' ? model : String(model?.primary || '')
    } catch {
      ref = text.match(/\bprimary["']?\s*:\s*["']([^"'\n]+)["']/)?.[1] || ''
    }
    ref = ref.trim()
    const slash = ref.indexOf('/')
    return { model: ref, provider: slash > 0 ? ref.slice(0, slash) : '' }
  }

  /** The headless `openclaw agent exec` entry appeared in late 2026 (2026.3.2
   *  lacks it and `agent exec --help` falls back to the plain agent help). It
   *  stays the version gate: title side calls still use it, and every release
   *  that has it also has `agent --local --session-id --json`. The
   *  subcommand's Usage line in the help output decides; each version is probed
   *  once, and a timed-out probe is not cached so the next one retries. */
  const openclawExecSupport = new Map()
  async function openclawSupportsExec(version) {
    if (openclawExecSupport.has(version)) return openclawExecSupport.get(version)
    const help = await cliProbe(OPENCLAW_BIN, ['agent', 'exec', '--help'], 30_000)
    if (!help.ok) return false
    const supported = /Usage:\s+openclaw agent exec\b/i.test(help.stdout)
    openclawExecSupport.set(version, supported)
    return supported
  }

  // The status panel asks every 5 minutes and the model catalog every minute;
  // starting Node each time is heavy, so both share one 5-minute result.
  let openclawStatusCache = null
  async function collectOpenclaw() {
    if (openclawStatusCache && Date.now() - openclawStatusCache.at < 5 * 60_000) return openclawStatusCache.value
    // A cold Node 24 start loads config and plugins while a dozen probes run at
    // Runner start; the default 8 s budget is too thin and a timeout reads as
    // "not installed".
    const version = await cliProbe(OPENCLAW_BIN, ['--version'], 30_000)
    if (!version.ok) return { installed: false, login: false, version: null, exec: false }
    const ver = `${version.stdout}\n${version.stderr}`.match(/\b(\d{4}\.\d+\.\d+(?:-[\w.]+)?)\b/)?.[1] || null
    const exec = ver ? await openclawSupportsExec(ver) : false
    const value = { installed: true, login: true, version: ver, exec }
    openclawStatusCache = { at: Date.now(), value }
    return value
  }

  /** The OpenClaw model is the single `agents.defaults.model.primary` from
   *  openclaw.json, so the catalog follows that file (users switch models with
   *  `openclaw configure`). Runs pass no --model; the slug only tells menu
   *  entries apart. Versions without `agent exec` get no group and cannot be
   *  selected. */
  async function openclawGroup() {
    const status = await collectOpenclaw().catch(() => ({ installed: false, exec: false }))
    if (!status.installed || !status.exec) return null
    const { model, provider } = openclawConfiguredModel()
    const name = model || 'default'
    return {
      runtime: 'openclaw',
      models: [{
        slug: `openclaw/${name}`,
        display_name: name,
        description: provider
          ? t('Default model configured in OpenClaw openclaw.json ({provider})', { provider })
          : t('Default model configured in OpenClaw openclaw.json'),
        reasoning_levels: [],
      }],
      default_model: `openclaw/${name}`,
      default_effort: null,
    }
  }

  /** Title side calls (the core runs them with run ids `title-<run id>` in a
   *  temporary folder) stay on the stateless `agent exec`: nothing to resume
   *  and nothing left behind. */
  const isSideCall = (run) => String(run?.run_id || '').startsWith('title-')

  /** The per-session config: the user's own openclaw.json pulled in whole with
   *  a root `$include` (so its keys, nested includes and `${VAR}` references
   *  resolve as usual and no credential is copied), then the defaults
   *  `agent exec` applies for headless coding runs. As in `agent exec`, tool,
   *  sandbox and shell settings the user configured win; the workspace, the
   *  skipped bootstrap and the session store are always pinned to this run. */
  function openclawRunConfig({ userConfigPath, userConfig, workspace, stateDir }) {
    const has = (...keys) => {
      let node = userConfig
      for (const key of keys) {
        if (!node || typeof node !== 'object' || !(key in node)) return false
        node = node[key]
      }
      return true
    }
    const known = !!userConfig
    const defaults = { workspace, cwd: workspace, skipBootstrap: true }
    if (known && !has('agents', 'defaults', 'sandbox', 'mode')) defaults.sandbox = { mode: 'off' }
    const config = { agents: { defaults } }
    if (userConfigPath) config.$include = userConfigPath
    const entries = userConfig?.agents?.entries
    if (entries && typeof entries === 'object') {
      config.agents.entries = {}
      for (const id of Object.keys(entries)) {
        const entry = { workspace }
        if (entries[id] && typeof entries[id] === 'object' && 'agentDir' in entries[id]) entry.agentDir = path.join(stateDir, 'agents', id, 'agent')
        config.agents.entries[id] = entry
      }
    }
    if (known) {
      const tools = {}
      if (!has('tools', 'profile')) tools.profile = 'coding'
      if (!has('tools', 'fs', 'workspaceOnly')) tools.fs = { workspaceOnly: true }
      if (!has('tools', 'exec', 'mode')) tools.exec = { mode: 'full' }
      if (Object.keys(tools).length) config.tools = tools
      if (!has('env', 'shellEnv', 'enabled')) config.env = { shellEnv: { enabled: false } }
    }
    // Sessions must stay in this run's state and never roll over on a timer.
    const session = { reset: { mode: 'none' } }
    for (const group of ['resetByType', 'resetByChannel']) {
      const value = userConfig?.session?.[group]
      if (value && typeof value === 'object') session[group] = Object.fromEntries(Object.keys(value).map(key => [key, { mode: 'none' }]))
    }
    if (has('session', 'store')) session.store = path.join(stateDir, 'agents', '{agentId}', 'agent', 'sessions.json')
    config.session = session
    config.skills = { load: { watch: false } }
    return config
  }

  /** Task turns: one directory per OpenClaw session under the Runner-owned
   *  root (<root>/<session id>/ with state/, openclaw.json and the prompt
   *  file), so the session id alone finds it again. A new session gets a fresh
   *  UUID; a resumed one reuses run.resume_thread_id (already checked by the
   *  core through session.exists). Async: no main-thread blocking. */
  async function openclawSetup(run) {
    if (isSideCall(run)) return null
    const resumeId = String(run.resume_thread_id || '').toLowerCase()
    const sessionId = SESSION_ID_RE.test(resumeId) ? resumeId : crypto.randomUUID()
    const dir = path.join(openclawSessionsRoot(), sessionId)
    const stateDir = path.join(dir, 'state')
    await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 })
    let workspace = run.workdir || ''
    if (!workspace) {
      workspace = path.join(dir, 'workspace')
      await fs.promises.mkdir(workspace, { recursive: true })
    }
    // OpenClaw only includes regular files reached without symlinks, so a
    // symlinked config (dotfile managers) is included by its real path.
    let userConfigPath = path.resolve(openclawConfigPath())
    let userText = null
    try {
      userConfigPath = await fs.promises.realpath(userConfigPath)
      userText = await fs.promises.readFile(userConfigPath, 'utf8')
    } catch { /* no user config: OpenClaw defaults */ }
    let userConfig = null
    if (userText != null) { try { userConfig = JSON.parse(userText) } catch { /* JSON5: keep the user's settings as they are */ } }
    const config = openclawRunConfig({ userConfigPath: userText != null ? userConfigPath : '', userConfig, workspace, stateDir })
    const configPath = path.join(dir, 'openclaw.json')
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    // Remember that this session's folder had content (see session.exists).
    if (run.workdir) {
      const entries = await fs.promises.readdir(run.workdir).catch(() => [])
      if (entries.some(name => name !== '.DS_Store' && name !== '.openclaw' && name !== 'openclaw-workspace-state.json')) {
        await fs.promises.writeFile(path.join(dir, 'workdir-had-content'), '', { mode: 0o600 }).catch(() => {})
      }
    }
    const messageFile = path.join(dir, `prompt-${process.pid}-${Date.now()}.txt`)
    return {
      sessionId,
      dir,
      stateDir,
      configPath,
      userConfigDir: userText != null ? path.dirname(userConfigPath) : '',
      messageFile,
      message: '',
      cleanup() { fs.promises.rm(messageFile, { force: true }).catch(() => {}) },
    }
  }

  /** Images have no channel of their own, so their paths go into the prompt
   *  for the file tools (they are inside the task directory).
   *  Task turns: `agent --local --session-id <id> --json`, the embedded agent
   *  without a gateway; the prompt file is written in processEnv (async).
   *  Side calls: `agent exec`, the prompt on stdin (--message-file -).
   *  `--timeout 0` lifts the built-in 600 s limit (no other agent has one
   *  either; users stop runs by cancelling). */
  function openclawArgs(run, localImages, instruction, setup) {
    const prompt = localImages.length
      ? `${instruction}\n\n[Image files attached to this message]\n${localImages.join('\n')}`
      : instruction
    const lead = RUN_DIRECT ? [MANAGED_ENTRY] : []
    if (setup?.sessionId) {
      setup.message = prompt
      const argv = [...lead, 'agent', '--local', '--session-id', setup.sessionId, '--message-file', setup.messageFile, '--json', '--timeout', '0']
      return { argv, stdinText: '', cwd: run.workdir || undefined }
    }
    const argv = [...lead, 'agent', 'exec', '--message-file', '-', '--json', '--timeout', '0']
    if (run.workdir) argv.push('--cwd', run.workdir)
    return { argv, stdinText: prompt, cwd: run.workdir || undefined }
  }

  /** Environment: the managed copy gets what its launcher would set. Task turns
   *  point OpenClaw at their own state directory and config, mark the config
   *  read-only, allow the root `$include` of the user's config folder, and aim
   *  any gateway lookup at a closed port so the user's resident gateway is
   *  never contacted. The session id goes to the handler. */
  async function openclawEnv(env, { setup }) {
    if (RUN_DIRECT) {
      env.PATH = `${path.dirname(MANAGED_NODE)}${path.delimiter}${env.PATH || ''}`
      env.OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_MANAGED_DIR, 'openclaw.json')
      env.OPENCLAW_STATE_DIR = path.join(OPENCLAW_MANAGED_DIR, 'state')
    }
    if (!setup?.sessionId) return null
    await fs.promises.writeFile(setup.messageFile, setup.message, { mode: 0o600 })
    env.OPENCLAW_STATE_DIR = setup.stateDir
    env.OPENCLAW_CONFIG_PATH = setup.configPath
    env.OPENCLAW_CONFIG_READONLY = '1'
    if (setup.userConfigDir) {
      env.OPENCLAW_INCLUDE_ROOTS = [setup.userConfigDir, env.OPENCLAW_INCLUDE_ROOTS].filter(Boolean).join(path.delimiter)
    }
    env.OPENCLAW_GATEWAY_PORT = '1'
    delete env.OPENCLAW_GATEWAY_URL
    delete env.OPENCLAW_GATEWAY_TOKEN
    delete env.OPENCLAW_GATEWAY_PASSWORD
    const sessionId = setup.sessionId
    return () => ({ openclawSessionId: sessionId })
  }

  // Error texts OpenClaw prints for the two states a resumed session can hit.
  const busyText = (detail) => t('OpenClaw could not start because another run is still using this conversation. Try again when it finishes. ({detail})', { detail })
  const abortedText = () => t('The OpenClaw run was aborted')
  const vanishedText = (detail) => t('OpenClaw refused to continue because the task folder is now empty. Add a file to the folder or send the message again to start a new session. ({detail})', { detail })

  /** stdout holds only one final JSON document, with no progress events.
   *  `agent exec` (side calls): { ok, status, final, usage, sessionId, error }.
   *  `agent --local`: { payloads, meta: { agentMeta: { sessionId, usage,
   *  lastCallUsage, contextTokens } } } or { ok: false, error }. Usage counts
   *  cached input too (input + cacheRead + cacheWrite). */
  function openclawHandler(ctx) {
    let out = ''
    const sessionId = ctx.openclawSessionId || ''
    // Report the session at once: a Runner that dies mid-turn can still resume it.
    if (sessionId) ctx.setSession(sessionId)
    const addUsage = (usage) => {
      if (!usage || typeof usage !== 'object') return
      const input = ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (Number.isFinite(usage[key]) ? usage[key] : 0), 0)
      ctx.tokens.input += input
      if (Number.isFinite(usage.output)) ctx.tokens.output += usage.output
    }
    return {
      raw(text) { out = (out + text).slice(-4 * 1024 * 1024) },
      line() { /* stdout is one JSON document, not JSONL */ },
      flush() {
        const body = out.trim()
        let doc = null
        try { doc = JSON.parse(body) } catch {
          // Plugins sometimes log around the document: retry from the first { to the last }
          const a = body.indexOf('{')
          const b = body.lastIndexOf('}')
          if (a >= 0 && b > a) { try { doc = JSON.parse(body.slice(a, b + 1)) } catch { /* fall through */ } }
        }
        // No document (killed or crashed): the generic failure path reports it with stderr
        if (!doc || typeof doc !== 'object') return
        if (doc.meta && typeof doc.meta === 'object') {
          const agentMeta = doc.meta.agentMeta || {}
          addUsage(agentMeta.usage)
          const promptTokens = Number(agentMeta.lastCallUsage?.contextUsage?.promptTokens ?? agentMeta.promptTokens)
          if (Number.isFinite(promptTokens) && promptTokens > 0) ctx.contextUsage.tokens = promptTokens
          if (Number.isFinite(Number(agentMeta.contextTokens)) && Number(agentMeta.contextTokens) > 0) ctx.contextUsage.window = Number(agentMeta.contextTokens)
          if (agentMeta.sessionId && agentMeta.sessionId !== sessionId) ctx.setSession(String(agentMeta.sessionId))
          const metaError = doc.meta.error?.message || (typeof doc.meta.error === 'string' ? doc.meta.error : '')
          if (metaError || doc.meta.aborted === true) {
            ctx.setErrorText(metaError ? String(metaError) : abortedText())
            return
          }
          const answer = (Array.isArray(doc.payloads) ? doc.payloads : [])
            .filter(p => p && !p.isError && typeof p.text === 'string')
            .map(p => p.text).join('\n\n').trim()
          if (answer) {
            ctx.setFullText(answer)
            ctx.pump.push({ type: 'content_delta', data: { text: answer } })
          }
          return
        }
        addUsage(doc.usage)
        if (doc.ok === false || doc.status === 'error' || doc.status === 'timeout') {
          // Config validation failures list the exact problems separately.
          const issues = Array.isArray(doc.issues) ? doc.issues.map(i => [i?.path, i?.message].filter(Boolean).join(': ')).filter(Boolean) : []
          const message = [String(doc.error?.message || `OpenClaw status ${doc.status || 'error'}`), ...issues].join('\n')
          if (/undergoing offline maintenance|owns? (?:that|this) (?:state )?director|state lock/i.test(message)) ctx.setErrorText(busyText(message))
          else if (/workspace appears to have disappeared/i.test(message)) ctx.setErrorText(vanishedText(message))
          else ctx.setErrorText(message)
          return
        }
        const answer = String(doc.final || '').trim()
        if (answer) {
          ctx.setFullText(answer)
          ctx.pump.push({ type: 'content_delta', data: { text: answer } })
        }
      },
    }
  }

  return {
    id: 'openclaw',
    label: 'OpenClaw',
    executes: true,
    bin: () => RUN_BIN,
    detect: collectOpenclaw,
    models: () => openclawGroup(),
    session: files.session,
    ownFiles: createOpenclawFiles,
    toolSetup: openclawSetup,
    command: openclawArgs,
    processEnv: openclawEnv,
    handler: openclawHandler,
    stream: { raw: true },
  }
}
