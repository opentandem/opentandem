// Claude Code (`claude`): headless stream-json runs with stdin kept open for control frames.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMPACT_TIMEOUT_MS, npmInstall, quotaFailure, stripAnsi, usageJson } from '../../core/agent-kit/kit.mjs'
import { CLAUDE_NATIVE_SCHEDULER_TOOLS, createClaudeStreamHandler } from '../../core/agent-kit/claude-stream.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createClaudeFiles(io) {
  const { fs, os, path, t, cleanTitle, sessionImport } = io
  const { recentFiles, sameWorkdir, jsonlRows, jsonlPrefixRows, importText, importTime, importTitle, cleanImportedUserText } = sessionImport

  /** Claude Code transcripts: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl,
   *  where the slug is the absolute workdir with every non-alphanumeric character turned into '-'
   *  (Claude Code's own rule: `_`, spaces, `\`, `:` and non-ASCII too). Over 200 characters it
   *  also appends a hash, which this does not reproduce.
   *  The slug is derived from the cwd the session ran in, so a task whose workdir
   *  moved would miss on the direct hit — fall back to a one-level scan rather
   *  than wrongly declaring the session gone and rebuilding the whole context. */
  /** The usage total of the last main-thread (not sub-agent) reply in the transcript = current context size. Reads only the file tail. */
  function claudeTranscriptContextTokens(file) {
    if (!file) return 0
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const len = Math.min(size, 4 * 1024 * 1024)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        const lines = buf.toString('utf8').split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"type":"assistant"')) continue
          let entry
          try { entry = JSON.parse(lines[i]) } catch { continue }
          if (entry.type !== 'assistant' || entry.isSidechain) continue
          const u = entry.message?.usage || {}
          const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0)
          if (total > 0) return total
        }
      } finally { fs.closeSync(fd) }
    } catch { /* unreadable: no context size */ }
    return 0
  }

  function claudeSessionPath(sessionId, workdir) {
    if (!sessionId) return ''
    const root = path.join(os.homedir(), '.claude', 'projects')
    const direct = workdir ? path.join(root, workdir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`) : ''
    if (direct && fs.existsSync(direct)) return direct
    let entries
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return '' }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = path.join(root, entry.name, `${sessionId}.jsonl`)
      if (fs.existsSync(file)) return file
    }
    return ''
  }

  function claudeSessionExists(sessionId, workdir) {
    return !!claudeSessionPath(sessionId, workdir)
  }

  function claudeImportSession(file, mtime, withMessages = false) {
    const rows = jsonlRows(file)
    const first = rows.find(row => row.sessionId && row.cwd)
    const sessionId = String(first?.sessionId || '')
    if (!sessionId || !first?.cwd) return null
    const messages = []
    for (const row of rows) {
      if (!['user', 'assistant'].includes(row.type)) continue
      const role = row.type
      const content = importText(row.message?.content, ['text'])
      if (!content) continue
      messages.push({ role, content: role === 'user' ? cleanImportedUserText(content) : content, created_at: importTime(row.timestamp, mtime) })
    }
    return {
      runtime: 'claude', session_id: sessionId, workdir: first.cwd,
      title: importTitle('', messages), updated_at: importTime(rows.at(-1)?.timestamp, mtime),
      message_count: messages.length, ...(withMessages ? { messages: messages.slice(-sessionImport.messageLimit) } : {}),
    }
  }

  function claudeImportSummary(file, mtime) {
    const rows = jsonlPrefixRows(file)
    const first = rows.find(row => row.sessionId && row.cwd)
    const sessionId = String(first?.sessionId || '')
    if (!sessionId || !first?.cwd) return null
    const messages = []
    for (const row of rows) {
      if (row.type !== 'user') continue
      const content = importText(row.message?.content, ['text'])
      if (content) messages.push({ role: 'user', content: cleanImportedUserText(content) })
    }
    return {
      runtime: 'claude', session_id: sessionId, workdir: first.cwd,
      title: importTitle('', messages), updated_at: importTime(mtime), message_count: 0,
    }
  }

  function claudeImportMeta(file, mtime) {
    const rows = jsonlPrefixRows(file, 64 * 1024)
    const first = rows.find(row => row.sessionId && row.cwd)
    const sessionId = String(first?.sessionId || '')
    if (!sessionId || !first?.cwd) return null
    return {
      runtime: 'claude', session_id: sessionId, workdir: first.cwd,
      title: t('Untitled task'), updated_at: importTime(mtime), message_count: 0,
    }
  }

  function claudeAiTitle(sessionFile) {
    if (!sessionFile) return ''
    let text = ''
    try { text = fs.readFileSync(sessionFile, 'utf8') } catch { return '' }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) continue
      try {
        const e = JSON.parse(lines[i])
        if (e.type === 'ai-title' && e.aiTitle) return cleanTitle(e.aiTitle)
      } catch { /* partial line */ }
    }
    return ''
  }

  return {
    session: { path: (id, workdir) => claudeSessionPath(id, workdir), exists: (id, workdir) => claudeSessionExists(id, workdir) },
    import: {
      // Claude already partitions transcripts by the exact cwd slug. Do not walk
      // any other project directory or nested subagent transcripts, and still verify cwd.
      list: (wanted, withMessages) => {
        const claudeProjectRoot = path.join(os.homedir(), '.claude', 'projects', wanted.replace(/[^a-zA-Z0-9]/g, '-'))
        return recentFiles(claudeProjectRoot, name => name.endsWith('.jsonl'), false).flatMap(item => {
          const session = withMessages ? claudeImportSession(item.file, item.mtime, true) : claudeImportMeta(item.file, item.mtime)
          return session && sameWorkdir(session.workdir, wanted) ? [{ ...session, source_file: item.file, source_mtime: item.mtime }] : []
        })
      },
      read: source => (source.file ? claudeImportSession(source.file, source.mtime, true) : null),
      summary: source => claudeImportSummary(source.file, source.mtime),
    },
    contextTokens: (id, cwd) => claudeTranscriptContextTokens(claudeSessionPath(id, cwd)),
    nativeTitle: (id, cwd) => claudeAiTitle(claudeSessionPath(id, cwd)),
  }
}

export function createClaudeAdapter(ctx) {
  const { execFile, spawn, VERSION_PROBE_MS, cachedModelProbe, maybeProbeModels, probeTui, killCompactChild, runtimeInstructions, toolServerSpec, cleanTitle, sessionImport, t } = ctx
  const files = createClaudeFiles({ fs, os, path, t, cleanTitle, sessionImport })
  const claudeHandler = createClaudeStreamHandler(ctx)
  const CLAUDE_BIN = ctx.config('CLAUDE_BIN') || 'claude'

  // A long-lived Claude Code OAuth token configured by hand (made by `claude setup-token` and
  // saved to this file by the user). Every claude child inherits process.env, so exporting it once
  // here keeps headless tasks away from the keychain session credential, whose refresh token
  // rotates on every use: concurrent refreshes from several processes knock each other out, which
  // is why a whole machine used to lose its login every few days. An explicit env var (e.g. set in
  // the plist) always wins; no file = normal keychain login, skipped silently.
  const CLAUDE_TOKEN_FILE = path.join(os.homedir(), '.claude-runner-token')

  function ensureClaudeTokenEnv() {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return
    try {
      const token = fs.readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim()
      if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token
    } catch { /* no file = keychain login, nothing to do */ }
  }

  // On macOS Claude Code does not write .credentials.json (the Linux path); the credential is in
  // the login keychain under "Claude Code-credentials" with the same JSON as its password.
  // `security` reads it without an authorization prompt (the ACL allows it); the 5s timeout keeps a
  // locked keychain from stalling the heartbeat.
  function readClaudeKeychain() {
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(null)
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000 }, (err, stdout) => {
          if (err) return resolve(null)
          try { resolve(JSON.parse(stdout)?.claudeAiOauth ?? null) } catch { resolve(null) }
        })
    })
  }

  async function readClaudeCred() {
    let cred
    try {
      cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth
    } catch { /* no file → try the keychain */ }
    if (!cred?.accessToken) cred = await readClaudeKeychain()
    return cred
  }

  // Two ways to read the quota; whichever succeeds wins (since 0.67.0):
  //  1. The login credential (keychain), if not expired → /api/oauth/usage, with the plan name.
  //     Read-only and **never refreshed**: refreshing used to run `claude -p /cost`, which makes the
  //     CLI refresh the keychain login; the refresh token rotates on every use and knocked out the
  //     session open in a terminal, which is why users had to log in again every day.
  //  2. The long-lived token (~/.claude-runner-token / CLAUDE_CODE_OAUTH_TOKEN) → send a 1-token
  //     haiku message and read the anthropic-ratelimit-unified-5h/7d-utilization and -reset response
  //     headers (HTTP 200 on 2026-10-10, same figures as the usage endpoint). It never touches the
  //     keychain or refreshes a token, but has no plan name. The long-lived token gets 429 from
  //     /api/oauth/usage, so that endpoint is not used with it.
  // An expired login credential goes straight to 2 without refreshing; the CLI refreshes it the
  // next time claude is used in a terminal.
  let claudeProbeAt = 0
  let claudeProbeResult = null

  async function claudeQuotaViaToken() {
    if (claudeProbeResult && Date.now() - claudeProbeAt < 5 * 60_000) return claudeProbeResult
    let token = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!token) { try { token = fs.readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim() } catch { /* no file */ } }
    if (!token) return null
    claudeProbeAt = Date.now()
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) { claudeProbeResult = null; return null }
      const windows = []
      for (const [label, short, key] of [[t('5 hours'), '5h', '5h'], [t('7 days'), '7d', '7d']]) {
        const util = Number(res.headers.get(`anthropic-ratelimit-unified-${key}-utilization`))
        const reset = Number(res.headers.get(`anthropic-ratelimit-unified-${key}-reset`))
        if (!res.headers.get(`anthropic-ratelimit-unified-${key}-utilization`)) continue
        windows.push({
          label, short, percent: Math.round(util * 100),
          resets_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
        })
      }
      claudeProbeResult = windows.length ? { runtime: 'claude', ok: true, windows, fetched_at: new Date().toISOString() } : null
    } catch { claudeProbeResult = null }
    return claudeProbeResult
  }

  async function collectClaudeQuota() {
    const cred = await readClaudeCred()
    if (cred?.accessToken && (!cred.expiresAt || cred.expiresAt > Date.now() + 60_000)) {
      try {
        const data = await usageJson('https://api.anthropic.com/api/oauth/usage', {
          Authorization: `Bearer ${cred.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        })
        const windows = []
        if (data.five_hour) windows.push({ label: t('5 hours'), short: '5h', percent: Math.round(data.five_hour.utilization || 0), resets_at: data.five_hour.resets_at || null })
        if (data.seven_day) windows.push({ label: t('7 days'), short: '7d', percent: Math.round(data.seven_day.utilization || 0), resets_at: data.seven_day.resets_at || null })
        return { runtime: 'claude', ok: true, plan: cred.subscriptionType, windows, fetched_at: new Date().toISOString() }
      } catch { /* the login credential failed; fall back to the long-lived token */ }
    }
    const viaToken = await claudeQuotaViaToken()
    if (viaToken) return viaToken
    return quotaFailure('claude', cred?.accessToken
      ? t('The login credential has expired and there is no usable long-lived token (~/.claude-runner-token)')
      : t('Not logged in to Claude Code and no long-lived token (~/.claude-runner-token)'))
  }

  function collectClaude() {
    const run = (args, timeout) => new Promise((resolve) => {
      // CLAUDECODE=1 is present when this daemon itself was launched from a
      // Claude Code session; the nested CLI refuses to start with it set.
      execFile(CLAUDE_BIN, args, { timeout, env: { ...process.env, CLAUDECODE: '' } },
        (err, stdout) => resolve(err ? null : String(stdout)))
    })
    return (async () => {
      const version = await run(['--version'], VERSION_PROBE_MS)
      if (version === null) return { installed: false, login: false, version: null }
      return { installed: true, login: true, version: version.trim().split('\n')[0] }
    })()
  }

  /**
   * Claude Code has no `debug models` equivalent — `claude models` is not a
   * subcommand, it runs as a prompt. So the group's list is static and ships with
   * the daemon; adding a model means bumping this file. The effort levels are the
   * CLI's own `--effort` choices.
   */
  const CLAUDE_EFFORTS = [
    { effort: 'low', description: t('Fastest; for mechanical changes') },
    { effort: 'medium', description: t('Balanced default') },
    { effort: 'high', description: t('Deeper reasoning') },
    { effort: 'xhigh', description: t('Complex debugging or design') },
    { effort: 'max', description: t('Largest thinking budget') },
  ]

  const CLAUDE_MODELS = [
    { slug: 'claude-fable-5', display_name: 'Fable 5', description: t('Strongest, but priced far above Opus; pick when needed'), default_reasoning_level: 'high', reasoning_levels: CLAUDE_EFFORTS },
    { slug: 'claude-opus-5', display_name: 'Opus 5', description: t("Claude Code's default high-capability model"), default_reasoning_level: 'high', reasoning_levels: CLAUDE_EFFORTS },
    { slug: 'claude-sonnet-5', display_name: 'Sonnet 5', description: t('Faster and cheaper; enough for everyday changes'), default_reasoning_level: 'high', reasoning_levels: CLAUDE_EFFORTS },
    { slug: 'claude-haiku-4-5', display_name: 'Haiku 4.5', description: t('Fastest; suited to simple batch tasks'), default_reasoning_level: 'medium', reasoning_levels: CLAUDE_EFFORTS },
  ]

  /** TUI redraws leave several frames of the menu in raw; dedupe by slug (the last frame matches
   *  the first). Matching is not anchored to line start/end: the menu is drawn inside a border
   *  (│…│), so lines start and end with box characters. Names must carry a version
   *  (Fable 5 / Opus 5.5), so a bare name in a description line does not match. */
  function parseClaudeMenuModels(raw) {
    const out = []
    const seen = new Set()
    for (const line of stripAnsi(raw).split('\n')) {
      const m = line.match(/\b((?:Fable|Opus|Sonnet|Haiku)\s+[0-9][0-9A-Za-z.]*)/i)
      if (!m) continue
      const name = m[1].replace(/\s+/g, ' ').trim()
      const slug = 'claude-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      if (!slug || slug === 'claude-' || seen.has(slug)) continue
      seen.add(slug)
      const rest = line.slice(Math.max(0, line.toLowerCase().indexOf(name.toLowerCase())))
      const disabled = /\(disabled\)/i.test(rest) || /update to \d/i.test(rest)
      const reason = rest.match(/(Update to [^)│|]+)/i)?.[1]?.trim()
        || rest.match(/—\s*([^│|\n]{1,60})/)?.[1]?.trim()
      out.push({
        slug,
        display_name: name,
        description: t('Probed from the local Claude Code /model menu'),
        default_reasoning_level: 'high',
        reasoning_levels: CLAUDE_EFFORTS,
        ...(disabled ? { disabled: true, disabled_reason: (reason || t('Not available in the current CLI version')).slice(0, 80) } : {}),
      })
    }
    return out
  }

  /** In a folder it has not confirmed, Claude Code first shows "trust this folder", which swallows
   *  every key the probe sends (verified on 2.1.309: neither Enter nor digits respond), so the probe
   *  never reaches the /model menu and the cache stays on an old version. Before probing, mark the
   *  Runner's own empty probe-cwd as trusted: only this one entry is added, an existing one is left
   *  alone, read-modify-atomic-replace. The file follows CLAUDE_CONFIG_DIR; a read or write failure
   *  never blocks the probe (it probes anyway and reports the probe error). A Claude session
   *  writing the same file at that moment may overwrite it once; accepted. */
  function ensureClaudeProbeTrusted() {
    try {
      const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')
      let cfg = {}
      if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (cfg?.projects?.[ctx.modelProbeCwd]?.hasTrustDialogAccepted === true) return
      cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}
      cfg.projects[ctx.modelProbeCwd] = { ...(cfg.projects[ctx.modelProbeCwd] || {}), hasTrustDialogAccepted: true }
      const tmp = `${file}.ot-${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch { /* never block the probe */ }
  }

  /** Grouped catalog: one group per runtime this machine can actually spawn. A
   *  group is omitted entirely when its CLI is missing — an absent option beats
   *  one that fails on send. The login signal never takes part (extended to every runtime in
   *  0.52.0): `auth status` misreports "not logged in" when the keychain is locked (it locks once
   *  the user walks away from the Mac) or the quota is rate-limited, and dropping the group then
   *  would make it vanish without explanation. Installed means the group stays; a failed run shows
   *  the real reason in its full error (0.28.0+), and the panel's "not logged in" mark still comes
   *  from runtimes[]. */
  async function claudeGroup() {
    const claude = await collectClaude().catch(() => ({ installed: false, login: false }))
    if (!claude.installed) return null
    if (claude.version) maybeProbeModels('claude', claude.version)
    // The probe cache first (the real /model menu, disabled entries included), else the built-in table
    const probed = cachedModelProbe('claude')?.models
    const models = probed?.length ? probed : CLAUDE_MODELS
    // The default stays "Opus > Sonnet > first available": the probed list starts with Fable (the
    // most expensive), the same trap as the static table.
    const fallback = models.find(m => m.slug.includes('opus') && !m.disabled)
      || models.find(m => m.slug.includes('sonnet') && !m.disabled)
      || models.find(m => !m.disabled)
      || models[0]
    return {
      runtime: 'claude',
      models,
      default_model: fallback.slug,
      default_effort: fallback.default_reasoning_level || 'high',
    }
  }

  /** Claude Code has no OS sandbox: headless `-p` only works in a mode that never
   *  asks. `plan` reads and plans but writes nothing; `bypassPermissions` has no
   *  limits. Anything in between ends the turn with a question nobody can answer,
   *  so standard/yolo are folded into bypassPermissions (see lib/runtimes.ts —
   *  the picker only offers the two that are real). */
  function claudeArgs(run, localImages, instruction) {
    const argv = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
      '--permission-mode', run.exec_mode === 'readonly' ? 'plan' : 'bypassPermissions',
    ]
    if (run.model) argv.push('--model', run.model)
    if (run.reasoning_effort) argv.push('--effort', run.reasoning_effort)
    if (runtimeInstructions(run)) argv.push('--append-system-prompt', runtimeInstructions(run))
    if (run.resume_thread_id) argv.push('--resume', run.resume_thread_id)
    // See CLAUDE_NATIVE_SCHEDULER_TOOLS: drop the built-in schedulers so scheduling has a single
    // way out, mcp__opentandem__schedule_create. The value is one comma-joined string: this flag is
    // also a greedy variadic and must be followed by a flag starting with - (--mcp-config below is).
    argv.push('--disallowedTools', CLAUDE_NATIVE_SCHEDULER_TOOLS)
    // The Runner's PostToolUse hook for Bash (see its claude-hook subcommand).
    argv.push('--settings', JSON.stringify({ hooks: { PostToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: ctx.runnerCommand('claude-hook') }],
    }] } }))
    // No --strict-mcp-config: it would switch off every MCP server the user configured.
    // **Must stay last in argv**: claude's --mcp-config is a greedy variadic (it takes several
    // config files) and swallows any following word not starting with - as another config path;
    // `claude --mcp-config '<json>' mcp list` reports "MCP config file not found: /tmp/mcp".
    argv.push('--mcp-config', JSON.stringify({ mcpServers: { opentandem: toolServerSpec(run) } }))
    // claudeHandler writes the user frame and answers on the same open stdin.
    return { argv, stdinText: '', cwd: run.workdir || undefined, keepStdinOpen: true }
  }

  // Claude Code headless compaction: `-p --resume <id> "/compact"`. This does **not** send /compact
  // to the model as a question: the CLI enters its own compaction subsystem and emits structured status:
  //   {"type":"system","subtype":"status","status":"compacting"}
  //   {"type":"system","subtype":"status","status":null,"compact_result":"success"|"failed","compact_error":...}
  // Only the compact_result field decides (the enum in the 2.1.220 binary is success/failed), never
  // the exit code or the result.result text: a failed compaction still has is_error false.
  async function compactClaude(sessionId, workdir) {
    const argv = ['-p', '/compact', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    return await new Promise(resolve => {
      const child = spawn(CLAUDE_BIN, argv, {
        stdio: ['ignore', 'pipe', 'pipe'], cwd: workdir || undefined, env: process.env,
        detached: process.platform !== 'win32',
      })
      let settled = false
      let stderrTail = ''
      let started = false
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killCompactChild(child)
        resolve(payload)
      }
      const timer = setTimeout(() => finish({ error: t('Claude Code did not finish compaction within {seconds}s', { seconds: COMPACT_TIMEOUT_MS / 1000 }) }), COMPACT_TIMEOUT_MS)
      child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-500) })
      let buf = ''
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          let m; try { m = JSON.parse(line) } catch { continue }
          if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') { started = true; continue }
          if (m.type === 'system' && m.subtype === 'status' && 'compact_result' in m) {
            if (m.compact_result === 'success') finish({ ok: true, detail: t('Claude Code finished one native context compaction') })
            else finish({ error: t('Claude Code compaction failed: {detail}', { detail: m.compact_error || t('no reason given') }) })
            return
          }
        }
      })
      child.on('error', e => finish({ error: t('Could not start claude: {detail}', { detail: e.message }) }))
      child.on('exit', code => { const tail = stderrTail ? t(': {detail}', { detail: stderrTail.trim().slice(-200) }) : ''; finish({
        error: started
          ? t('Claude Code exited during compaction (code={code}){tail}', { code, tail })
          : t('Claude Code never started compacting (code={code}){tail}', { code, tail }),
      }) })
    })
  }

  async function probeModels() {
    ensureClaudeProbeTrusted()
    // Adaptive sequence (verified on 2.1.220, 2026-09-23): a fixed timeline is too brittle, since
    // after an update claude may open a "What's new" panel that swallows keys, and startup time
    // varies. So it advances on screen markers: 1. the welcome panel appears → Enter closes it;
    // 2. the prompt is ready → type /model; 3. the slash list renders → Enter opens the model
    // menu; 4. the menu appears → ESC cancels. Never press Enter inside the menu (that sets the
    // default and writes the config).
    const res = await probeTui(CLAUDE_BIN, [], [
      // Wait for startup to finish: input sent before ~17s is swallowed (the slash list never
      // appears), from 17s on it is stable. That is the fixed cost of this path; a refresh is a
      // manual action, so it is acceptable.
      { waitMs: 17_000 },
      // Close the "What's new" panel (Enter = empty submit, harmless)
      { waitFor: 'Try "|❯|for shortcuts', timeoutMs: 15_000, write: '\r' },
      { waitMs: 1_500, write: '/model' },
      // Enter only once the slash list has rendered: this Enter runs /model and opens the menu
      { waitFor: 'Set the AI model|/model\\s', timeoutMs: 10_000, write: '\r' },
      // Once the menu appears wait 1.2s for the whole screen to render (that frame is parsed),
      // then ESC; never Enter inside the menu (it sets the default and writes the config).
      { waitFor: 'Select model|\\(disabled\\)', timeoutMs: 15_000, waitMs: 1_200 },
      { write: '\x1b' },
    ], 60_000)
    if (!res.ok) return res
    const models = parseClaudeMenuModels(res.raw)
    return models.length ? { ok: true, models } : { ok: false, error: t('No models could be parsed from the /model menu (the CLI may not be ready or its interface changed)') }
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    executes: true,
    bin: () => CLAUDE_BIN,
    detect: collectClaude,
    models: () => claudeGroup(),
    quota: () => collectClaudeQuota(),
    probe: { key: 'claude', label: t('Claude Code TUI /model menu'), run: probeModels },
    nativeInstructions: true,
    install: {
      oneClick: npmInstall('claude', '@anthropic-ai/claude-code'),
      native: (real, home) => real.startsWith(`${home}/.local/share/claude/versions/`) || real === `${home}/.local/bin/claude.exe`,
      releaseChannel: (real, method) => {
        if (method === 'homebrew') return real.includes('claude-code@latest') ? 'latest' : 'stable'
        let release_channel = 'unknown'
        try {
          const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
          const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))
          if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            const channel = settings.autoUpdatesChannel
            if (channel === undefined) release_channel = 'latest'
            else if (channel === 'stable' || channel === 'latest') release_channel = channel
          }
        } catch { /* An unreadable channel must not silently become latest. */ }
        return release_channel
      },
      npmPackage: () => '@anthropic-ai/claude-code',
      nativeUpdate: ({ executable }) => ({ kind: 'command', file: executable, args: ['update'] }),
      brewUpdate: ({ input, brewFile }) => ({ kind: 'brew', file: brewFile, formula: input?.release_channel === 'latest' ? 'claude-code@latest' : 'claude-code', cask: true }),
      versionEnv: { CLAUDECODE: '' },
    },
    // Called at startup and before each claim, so a token file created later is picked up without a restart.
    refreshEnv: ensureClaudeTokenEnv,
    session: files.session,
    ownFiles: createClaudeFiles,
    command: claudeArgs,
    handler: claudeHandler,
    closeInputOnEnd: true,
    import: files.import,
    processEnv: (env, { run }) => {
      // A daemon launched from inside a Claude Code session inherits CLAUDECODE=1,
      // and the nested CLI refuses to start with it set.
      env.CLAUDECODE = ''
      // claude -p does not title sessions (disabled for entrypoint=sdk-cli); with this variable it
      // writes an ai-title as in interactive mode. The value goes into the User-Agent
      // (agent-sdk/<value>), so it carries only a version.
      if (run.want_title) env.CLAUDE_AGENT_SDK_VERSION = ctx.runnerVersion
    },
    contextTokens: files.contextTokens,
    nativeTitle: files.nativeTitle,
    compact: (id, workdir) => compactClaude(id, workdir),
    userChoices: { tool: 'AskUserQuestion', fields: 'label, description and preview', preview: true },
  }
}
