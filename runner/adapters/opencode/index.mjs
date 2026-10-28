// OpenCode (`opencode`): `opencode serve` driven over its HTTP API (V1 and V2), with the tool server in OPENCODE_CONFIG_CONTENT.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_RUNTIMES_DIR, compactDeadline, mainSessionEventGuard, npmInstall, quotaFailure, usageJson, withDeadline } from '../../core/agent-kit/kit.mjs'
import { createOpenCodeNativeRun } from './native-run.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createOpencodeFiles(io) {
  const { fs, os, path, SqliteDatabaseSync, cleanTitle, sessionImport } = io
  const { sameWorkdir, importText, importTime, importTitle, cleanImportedUserText } = sessionImport
  // The storage layout differs by OpenCode major version; the adapter reports the installed one.
  const major = () => io.state?.()?.major || 1

  /** OpenCode keeps sessions in a sqlite db, not files. `opencode run -s <gone>`
   *  is a silent no-op (exit 0, zero output) — exactly the failure mode this
   *  check exists to prevent — so an unreadable db must answer "missing", which
   *  makes the run rebuild its context prompt instead of resuming into nothing. */
  function opencodeSessionExists(sessionId) {
    if (!sessionId || !SqliteDatabaseSync) return false
    const dbPath = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')
    if (!fs.existsSync(dbPath)) return false
    let db
    try {
      db = new SqliteDatabaseSync(dbPath, { readOnly: true })
      return !!db.prepare(`SELECT id FROM ${major() >= 2 ? 'session_v2' : 'session'} WHERE id = ?`).get(sessionId)
    } catch {
      return false
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
  }

  function opencodeSessionPath(sessionId) {
    return opencodeSessionExists(sessionId)
      ? path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')
      : ''
  }

  function openCodeMessages(db, sessionId) {
    const messages = []
    let rows = []
    try { rows = db.prepare('SELECT id,time_created,data FROM message WHERE session_id=? ORDER BY time_created,id').all(sessionId) } catch { return messages }
    const parts = db.prepare('SELECT data FROM part WHERE message_id=? ORDER BY time_created,id')
    for (const row of rows) {
      let data
      try { data = JSON.parse(row.data) } catch { continue }
      const role = data?.role
      if (!['user', 'assistant'].includes(role)) continue
      let content = ''
      try {
        content = parts.all(row.id).map(part => {
          try {
            const value = JSON.parse(part.data)
            return value?.type === 'text' ? String(value.text || '') : ''
          } catch { return '' }
        }).filter(Boolean).join('\n').trim()
      } catch { /* old OpenCode schema: fall back to message data below */ }
      if (!content) content = importText(data.content, ['text'])
      if (!content) continue
      messages.push({ role, content: role === 'user' ? cleanImportedUserText(content) : content, created_at: importTime(row.time_created) })
    }
    return messages
  }

  function openCodeImportSessions(workdir, withMessages = false) {
    if (!SqliteDatabaseSync) return []
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
    if (!fs.existsSync(dbPath)) return []
    let db
    try {
      db = new SqliteDatabaseSync(dbPath, { readOnly: true })
      // Compared in JS, not in SQL: OpenCode on Windows stores `C:/Users/...` while the workdir is `C:\Users\...`.
      const rows = db.prepare('SELECT id,directory,title,time_created,time_updated FROM session ORDER BY time_updated DESC')
        .all().filter(row => sameWorkdir(row.directory, workdir)).slice(0, sessionImport.fileLimit)
      return rows.map(row => {
        const messages = withMessages ? openCodeMessages(db, row.id) : []
        return {
          runtime: 'opencode', session_id: String(row.id), workdir: row.directory,
          title: importTitle(row.title, messages), updated_at: importTime(row.time_updated),
          message_count: messages.length,
          ...(withMessages ? { messages: messages.slice(-sessionImport.messageLimit) } : {}),
        }
      })
    } catch { return [] } finally { try { db?.close() } catch {} }
  }

  function opencodeTitle(sessionId) {
    if (!sessionId || !SqliteDatabaseSync) return ''
    const dbPath = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')
    if (!fs.existsSync(dbPath)) return ''
    let db
    try {
      db = new SqliteDatabaseSync(dbPath, { readOnly: true })
      const title = String(db.prepare(`SELECT title FROM ${major() >= 2 ? 'session_v2' : 'session'} WHERE id = ?`).get(sessionId)?.title || '')
      // When the title call fails it stays at the default "New session - <ISO time>", which is not a title
      return /^New session - /.test(title) ? '' : cleanTitle(title)
    } catch {
      return ''
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
  }

  return {
    session: { path: id => opencodeSessionPath(id), exists: id => opencodeSessionExists(id) },
    import: {
      list: (wanted, withMessages) => openCodeImportSessions(wanted, withMessages),
      read: (source, wanted) => openCodeImportSessions(wanted, true).find(item => item.session_id === source.session_id) || null,
    },
    nativeTitle: id => opencodeTitle(id),
  }
}

export function createOpencodeAdapter(ctx) {
  const { execFile, spawn, SqliteDatabaseSync, killCompactChild, runtimeInstructions, toolServerSpec, cleanTitle, sessionImport, addPathDirs, mimeFor, t } = ctx
  const files = createOpencodeFiles({ fs, os, path, SqliteDatabaseSync, cleanTitle, sessionImport, state: () => ({ major: opencodeMajor }) })
  const IS_WIN = process.platform === 'win32'
  // OpenCode's native binary can take 8–15s just to print --version on a small
  // Linux machine. Keep the general inventory budget tight, but do not classify
  // a healthy OpenCode install as missing merely because it crossed that budget.
  const OPENCODE_VERSION_PROBE_MS = IS_WIN ? 30_000 : 20_000

  const OPENCODE_BIN = ctx.config('OPENCODE_BIN') || 'opencode'

  /**
   * OpenCode Go subscription quota. Only the `opencode-go` key has subscription windows to read;
   * Zen is pay-as-you-go and other providers each do their own thing, with no common quota, so this
   * entry stands for the Go plan only.
   *
   * The endpoint was found by the community and is not documented (GET opencode.ai/zen/go/v1/usage);
   * its shape may change, so every field is parsed defensively: a missing window is skipped, and
   * with all three missing the whole entry fails.
   */
  async function collectOpencodeGoQuota() {
    let key
    try {
      const candidates = [
        path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
        path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
      ]
      let raw = null
      for (const p of candidates) {
        try { raw = fs.readFileSync(p, 'utf8'); break } catch { /* try the next one */ }
      }
      if (raw === null) return quotaFailure('opencode', t('No opencode auth.json on this machine'))
      key = JSON.parse(raw)?.['opencode-go']?.key
      if (!key) return quotaFailure('opencode', t('Not subscribed to OpenCode Go'))
    } catch { return quotaFailure('opencode', t('Could not read opencode auth.json')) }
    try {
      const data = await usageJson('https://opencode.ai/zen/go/v1/usage', {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'opentandem/1.0',
      })
      const u = data?.usage || {}
      const windows = []
      const specs = [['5h', t('5 hours'), u.rolling], ['7d', t('7 days'), u.weekly], ['30d', t('30 days'), u.monthly]]
      for (const [short, label, src] of specs) {
        if (!src || typeof src.percent !== 'number') continue
        windows.push({
          label, short, percent: Math.round(src.percent),
          resets_at: typeof src.resetsAt === 'string' ? src.resetsAt : null,
        })
      }
      if (!windows.length) return quotaFailure('opencode', t('Not subscribed to OpenCode Go, or the endpoint returned something unexpected'))
      return { runtime: 'opencode', ok: true, plan: 'Go', windows, fetched_at: new Date().toISOString() }
    } catch (e) { return quotaFailure('opencode', t('Could not fetch the quota: {detail}', { detail: e.message })) }
  }

  /** A model-catalog failure says nothing about the installed OpenCode version. */
  function mergeOpencodeRuntimeStatus(opencode, previous) {
    if (!opencode?.error) {
      return { runtime: 'opencode', installed: !!opencode?.installed, login: !!opencode?.installed, version: opencode?.version ?? null }
    }
    if (opencode.installed && opencode.version) {
      return { runtime: 'opencode', installed: true, login: true, version: opencode.version }
    }
    return previous || null
  }

  /**
   * OpenCode aggregates many providers behind one CLI. V1 `opencode models` prints
   * one `provider/model` per line, covering exactly the providers configured on
   * THIS machine (auth.json credentials + opencode.json provider entries), so it
   * doubles as the "usable at all" probe: an empty list means nothing to run.
   * There is no unified subscription quota to report. `--verbose` also carries
   * each model's `variants` (provider-defined reasoning effort, e.g. low/high/max
   * — passed at run time as `opencode run --variant <name>`), so we surface them
   * as the model's thinking levels. V2 exposes the same information through its
   * model API and uses provider/model#variant at run time.
   */
  const opencodeContextWindows = new Map()

  let opencodeMajor = 1

  let opencodeCollecting = null

  let opencodeDefaultModel = null

  function opencodeCommand(args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(OPENCODE_BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        // stderr may contain provider credentials/configuration: never forward it to the server.
        if (err) {
          const error = new Error(`OpenCode ${args[0]} failed (${err.killed ? 'timeout' : err.code || 'execution error'})`)
          error.code = err.code
          reject(error)
        }
        else resolve(String(stdout))
      })
    })
  }

  async function opencodeVersion() {
    const version = (await opencodeCommand(['--version'], OPENCODE_VERSION_PROBE_MS)).trim().split('\n')[0]
    const match = version.match(/\b(?:v)?(\d+)\.\d+\.\d+/)
    if (!match) throw new Error('OpenCode returned an unrecognized version')
    const major = Number(match[1])
    if (major !== opencodeMajor) {
      opencodeLastModels = null
      opencodeDefaultModel = null
      opencodeContextWindows.clear()
      opencodeModelVariants.clear()
    }
    opencodeMajor = major
    return version
  }

  // V2's first catalog snapshot can be empty while providers initialize. Keep one
  // private server alive for polling; a fresh `api --standalone` on each retry never
  // gets past that first snapshot. Do not start/restart the user's background service.
  async function withOpencodeServer(workdir, action) {
    const password = crypto.randomBytes(24).toString('hex')
    const child = spawn(OPENCODE_BIN, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: workdir || undefined,
      env: { ...process.env, PWD: workdir || process.cwd(), OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password },
      detached: process.platform !== 'win32',
    })
    try {
      const base = await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('OpenCode server startup timed out')), 30_000)
        const scan = data => {
          output = (output + String(data)).slice(-8192)
          const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/)
          if (match) { clearTimeout(timer); resolve(match[0]) }
        }
        child.stdout.on('data', scan)
        child.stderr.on('data', scan)
        child.on('error', () => { clearTimeout(timer); reject(new Error('OpenCode server could not start')) })
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode server exited (${code})`)) })
      })
      const request = async (route, options = {}) => {
        const response = await fetch(`${base}${route}`, {
          ...options,
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
          signal: options.signal || AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`OpenCode API failed (HTTP ${response.status})`)
        if (response.status === 204) return null
        return response.json()
      }
      return await action(request)
    } finally {
      killCompactChild(child)
    }
  }

  async function opencodeV2Catalog() {
    return withOpencodeServer(undefined, async request => {
      // The API is a live snapshot, including during provider initialization.
      // Require a nonempty catalog stable for two seconds, not merely its first
      // free model. A timeout is unknown rather than evidence of logout.
      const until = Date.now() + 20_000
      let rows, previous = '', stableSince = 0
      while (true) {
        const result = await request('/api/model')
        if (!Array.isArray(result?.data)) throw new Error('OpenCode returned an invalid model catalog')
        rows = result.data
        const fingerprint = JSON.stringify(rows.map(m => [m.providerID, m.id, m.enabled, m.limit, m.variants]))
        if (fingerprint !== previous) { previous = fingerprint; stableSince = Date.now() }
        if (rows.length && Date.now() - stableSince >= 2000) break
        if (Date.now() >= until) throw new Error('OpenCode model catalog is not ready')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const fallback = await request('/api/model/default')
      const model = fallback?.data
      opencodeDefaultModel = model?.providerID && model?.id ? `${model.providerID}/${model.id}` : null
      return rows
    })
  }

  /** Each model's native reasoning-level names; v1 passes --variant, v2 appends #variant to the model name. */
  const opencodeModelVariants = new Map()

  // The last successfully listed models: on Windows `opencode models` takes 10s even when idle and
  // times out with several tasks running. A timeout does not mean logged out, so keep the last result
  // instead of dropping the whole OpenCode group from the model list.
  let opencodeLastModels = null

  // Display order: reasoning effort from low to high, unknown names last.
  const OPENCODE_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'thinking', 'high', 'xhigh', 'max']

  function compareOpencodeEffort(a, b) {
    const rank = (name) => { const i = OPENCODE_EFFORT_ORDER.indexOf(name); return i < 0 ? OPENCODE_EFFORT_ORDER.length : i }
    return rank(a) - rank(b)
  }

  function collectOpencode() {
    if (opencodeCollecting) return opencodeCollecting
    opencodeCollecting = withDeadline((async () => {
      let version
      try { version = await opencodeVersion() }
      catch (error) {
        return { installed: false, login: false, version: null, models: [], ...(error.code === 'ENOENT' ? {} : { error: error.message }) }
      }
      // --verbose prints a JSON block under each model name (limit.context is the window size,
      // variants are the reasoning levels); keep them for context size and level selection
      let listing = '', rows = null
      try {
        if (opencodeMajor >= 2) rows = await opencodeV2Catalog()
        else listing = await opencodeCommand(['models', '--verbose'], IS_WIN ? 60_000 : 20_000)
      } catch (error) {
        return { installed: true, login: true, version, models: opencodeLastModels || [], error: error.message }
      }
      opencodeModelVariants.clear()
      opencodeContextWindows.clear()
      if (rows) {
        listing = rows.filter(m => m?.enabled !== false && m?.providerID && m?.id).map(m =>
          `${m.providerID}/${m.id}\n${JSON.stringify({
          limit: m.limit,
          variants: Object.fromEntries((Array.isArray(m.variants) ? m.variants : []).filter(v => v?.id).map(v => [v.id, v])),
        }, null, 2)}`,
        ).join('\n')
      }
      const models = []
      let slug = '', block = []
      for (const line of (listing || '').split('\n')) {
        if (/^[\w.-]+\/\S+$/.test(line.trim())) { slug = line.trim(); models.push(slug); block = []; continue }
        if (!slug) continue
        block.push(line)
        if (line === '}') {
          try {
            const parsed = JSON.parse(block.join('\n'))
            const context = Number(parsed?.limit?.context)
            if (context > 0) opencodeContextWindows.set(slug, context)
            // The stored reasoning_effort field allows at most 16 characters.
            // __default__ is the UI's "follow the OpenCode config", not an upstream variant.
            const variants = parsed?.variants && typeof parsed.variants === 'object' && !Array.isArray(parsed.variants)
              ? Object.entries(parsed.variants)
                  .filter(([name, settings]) => name && name.length <= 16 && name !== '__default__' && settings && typeof settings === 'object' && !Array.isArray(settings) && !settings.disabled)
                  .map(([name]) => name).sort(compareOpencodeEffort) : []
            if (variants.length) opencodeModelVariants.set(slug, variants)
            else opencodeModelVariants.delete(slug)
          } catch { /* unparseable: no window or levels, still usable */ }
          slug = ''
        }
      }
      opencodeLastModels = models.length ? models : null
      return { installed: true, login: true, version, models }
    })(), 120_000, 'OpenCode inventory', () => ({
      installed: true, login: true, version: null,
      models: opencodeLastModels || [], error: 'OpenCode inventory timed out',
    })).finally(() => { opencodeCollecting = null })
    return opencodeCollecting
  }

  async function opencodeGroup() {
    const oc = await collectOpencode().catch(() => ({ installed: false, login: false, models: [] }))
    if (!oc.installed || !oc.models.length) return null
    // A default model in the user's global OpenCode config wins; otherwise Xiaomi's free model
    // (its name carries a version, so it is matched by pattern), then OpenCode's own default or the first listed.
    let userModel = null
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
      if (typeof cfg.model === 'string') userModel = cfg.model
    } catch { /* no global config */ }
    const freeMimo = oc.models.find(slug => /^opencode\/mimo-[\w.-]*-free$/.test(slug))
    const configured = [userModel, freeMimo, opencodeDefaultModel].find(slug => slug && oc.models.includes(slug)) || null
    return {
      runtime: 'opencode',
      models: oc.models.map((slug) => {
        const levels = opencodeModelVariants.get(slug) || []
        return levels.length
          ? {
              slug, display_name: slug,
              reasoning_levels: [{ effort: '__default__' }, ...levels.map(effort => ({ effort }))],
              default_reasoning_level: '__default__',
            }
          : { slug, display_name: slug, reasoning_levels: [] }
      }),
      default_model: oc.models.includes(configured) ? configured : oc.models[0],
      default_effort: null,
    }
  }

  // The OpenCode bundled with the desktop client (Mac and Windows clients ship a pinned version and
  // pass its path in OPENTANDEM_BUNDLED_OPENCODE). "Install OpenCode" then downloads nothing: it adds
  // that directory to the end of PATH and leaves a flag file in the runtimes directory so it stays
  // enabled across Runner restarts. It lives outside node_modules and Homebrew, so its install method
  // is unknown: the web UI offers no upgrade and the Runner never rewrites the client's files.
  // OpenCode's own auto-update is switched off with OPENCODE_DISABLE_AUTOUPDATE. An OpenCode the user
  // installed comes earlier on PATH and still wins.
  const BUNDLED_OPENCODE = path.isAbsolute(process.env.OPENTANDEM_BUNDLED_OPENCODE || '') ? process.env.OPENTANDEM_BUNDLED_OPENCODE : ''
  const BUNDLED_OPENCODE_FLAG = path.join(AGENT_RUNTIMES_DIR, 'opencode-bundled.enabled')

  function bundledOpenCodeAvailable() {
    try { return !!BUNDLED_OPENCODE && fs.statSync(BUNDLED_OPENCODE).isFile() } catch { return false }
  }

  function useBundledOpenCode() {
    if (!process.env.OPENCODE_DISABLE_AUTOUPDATE) process.env.OPENCODE_DISABLE_AUTOUPDATE = '1'
    addPathDirs([path.dirname(BUNDLED_OPENCODE)])
  }

  /** OpenCode supports per-process inline configuration. Merge our server into
   *  any caller-provided inline config so existing tools and permissions remain. */
  function openCodeScheduleMcpConfig(run, instructionFile = '') {
    let config = {}
    const raw = process.env.OPENCODE_CONFIG_CONTENT || ''
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
      } catch (e) {
        console.warn(`[daemon] ignored invalid OPENCODE_CONFIG_CONTENT: ${e.message}`)
      }
    }
    const spec = toolServerSpec(run)
    return JSON.stringify({
      ...config,
      // Snapshots serve OpenCode's own undo, which OpenTandem does not use; in a large directory such as the home dir each turn's git snapshot never finishes
      snapshot: typeof config.snapshot === 'boolean' ? config.snapshot : false,
      ...(instructionFile ? {
        instructions: [...(Array.isArray(config.instructions) ? config.instructions : []), instructionFile],
      } : {}),
      mcp: {
        ...(config.mcp || {}),
        opentandem: {
          type: 'local',
          command: [spec.command, ...spec.args],
          environment: spec.env,
          enabled: true,
        },
      },
      permission: { ...(config.permission || {}), 'opentandem_*': 'allow' },
    })
  }

  function openCodeRuntimeSetup(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-opencode-'))
    fs.chmodSync(root, 0o700)
    const instructionFile = path.join(root, 'runtime-instructions.md')
    fs.writeFileSync(instructionFile, runtimeInstructions(run), { mode: 0o600 })
    return {
      config: openCodeScheduleMcpConfig(run, instructionFile),
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    }
  }

  /** Run an owned native server: `run` disables questions in V1 and cancels
   * forms in V2. Model, variant and plan mode travel in the native HTTP request. */
  function opencodeArgs(run, localImages, instruction) {
    return { argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'], stdinText: '', cwd: run.workdir || undefined }
  }

  /**
   * opencode `run --format json` → the same StreamEvents. Line shapes (all carry
   * a top-level sessionID and a `part` object):
   *   {type:'reasoning', part:{text}}                        → thinking
   *   {type:'text', part:{text, messageID}}                  → narration / answer
   *   {type:'tool_use', part:{tool, callID, state:{status, input, output, title}}}
   *   {type:'step_finish', part:{tokens:{input, output, reasoning, cache:{read, write}}}}
   *   {type:'error', error:{name, data:{message}}}
   *
   * One run = one step per LLM round-trip, so a tool-using turn produces SEVERAL
   * step_finish events. Each step is its own billed call: tokens must be SUMMED
   * across steps, and each step's input must include cache read/write (a resumed
   * session reports nearly everything as cache.read — counting only `input`
   * would show a 50k-token turn as ~50).
   */
  function opencodeHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolByCall = new Map()
    let answerMsgId = null
    let answerParts = []
    const labelFor = (name, input) => {
      const arg = input?.command ?? input?.filePath ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    return {
      line(event) {
        if (!isMainSession(event.sessionID)) return
        if (typeof event.sessionID === 'string' && event.sessionID) ctx.setSession(event.sessionID)
        const part = event.part || {}
        switch (event.type) {
          case 'reasoning': {
            if (part.text) {
              ctx.reasoningParts.push({ kind: 'reasoning', label: part.text })
              ctx.pump.push({ type: 'reasoning_delta', data: { text: part.text } })
            }
            break
          }
          case 'text': {
            if (!part.text) break
            // Same problem as codex: nothing marks the final answer while
            // streaming. Show each text as narration now; the parts of the LAST
            // message are promoted to the answer when the process ends (flush).
            ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: part.text })
            ctx.pump.push({ type: 'reasoning_delta', data: { text: part.text } })
            if (part.messageID !== answerMsgId) { answerMsgId = part.messageID; answerParts = [] }
            answerParts.push(part.text)
            break
          }
          case 'tool_use': {
            const state = part.state || {}
            const done = state.status === 'completed' || state.status === 'error'
            const id = part.callID || part.id
            let rec = id ? toolByCall.get(id) : undefined
            if (!rec) {
              rec = { kind: 'command', label: labelFor(part.tool || 'tool', state.input), status: 'running', output: '' }
              ctx.reasoningParts.push(rec)
              if (id) toolByCall.set(id, rec)
            }
            rec.label = labelFor(part.tool || 'tool', state.input)
            if (done) {
              rec.status = 'done'
              rec.output = typeof state.output === 'string' ? state.output.slice(0, 2000) : ''
            }
            ctx.pump.push({ type: 'tool_event', data: { id, kind: 'command', label: rec.label, status: done ? 'done' : 'running', ...(done ? { output: rec.output } : {}) } })
            break
          }
          case 'step_finish': {
            const used = part.tokens
            if (used) {
              ctx.tokens.input += (used.input || 0) + (used.cache?.read || 0) + (used.cache?.write || 0)
              ctx.tokens.output += (used.output || 0) + (used.reasoning || 0)
              ctx.contextUsage.tokens = used.total || ((used.input || 0) + (used.output || 0) + (used.reasoning || 0) + (used.cache?.read || 0) + (used.cache?.write || 0))
              ctx.contextUsage.window = opencodeContextWindows.get(ctx.model) || 0
            }
            break
          }
          case 'error': {
            const message = event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode error'
            ctx.setErrorText(String(message))
            break
          }
        }
      },
      flush() {
        if (!answerParts.length) return
        const fullText = answerParts.join('')
        // Retract the answer's parts from the narration timeline (they were shown
        // live) so the final message is not rendered twice.
        for (const text of answerParts) {
          for (let i = ctx.reasoningParts.length - 1; i >= 0; i--) {
            const p = ctx.reasoningParts[i]
            if (p.kind === 'reasoning' && p.label === text) { ctx.reasoningParts.splice(i, 1); break }
          }
        }
        ctx.setFullText(fullText)
        ctx.pump.push({ type: 'content_delta', data: { text: fullText } })
        answerParts = []
      },
    }
  }

  async function compactOpencode(sessionId, workdir, model) {
    await opencodeVersion()
    if (opencodeMajor >= 2) {
      return withOpencodeServer(workdir, async request => {
        const route = `/api/session/${encodeURIComponent(sessionId)}`
        const admitted = await request(`${route}/compact`, { method: 'POST', body: '{}' })
        const id = admitted?.data?.id
        if (!id) throw new Error('OpenCode did not acknowledge the compaction request')
        const remaining = compactDeadline()
        await request(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, {
          method: 'POST', signal: AbortSignal.timeout(Math.max(1000, remaining())),
        })
        // Admission and an idle loop do not prove compaction succeeded. Require
        // the native completed message belonging to this exact request.
        while (remaining() > 0) {
          const messages = await request(`${route}/message?type=compaction&order=desc&limit=20`)
          const result = messages?.data?.find(m => m.id === id && m.type === 'compaction')
          if (result?.status === 'completed') return { ok: true, detail: t('OpenCode wrote a native summary; the next turn starts from it') }
          if (result?.status === 'failed') throw new Error(result.error?.message || 'OpenCode compaction failed')
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        throw new Error('OpenCode compaction completion timed out')
      }).catch(error => ({ error: t('OpenCode compaction failed: {detail}', { detail: error.message }) }))
    }
    const child = spawn(OPENCODE_BIN, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: workdir || undefined, env: process.env,
      detached: process.platform !== 'win32',
    })
    const remaining = compactDeadline()
    try {
      const base = await new Promise((resolve, reject) => {
        let out = ''
        const timer = setTimeout(() => reject(new Error(t('opencode serve did not report a listening address within 30s'))), 30_000)
        const scan = d => {
          out += d
          const hit = out.match(/https?:\/\/127\.0\.0\.1:\d+/)
          if (hit) { clearTimeout(timer); resolve(hit[0]) }
        }
        child.stdout.on('data', scan)
        // The listening address is printed on stderr (stdout carries only the password warning), so scan both.
        child.stderr.on('data', scan)
        child.on('error', e => { clearTimeout(timer); reject(e) })
        child.on('exit', code => { clearTimeout(timer); reject(new Error(t('opencode serve exited (code={code})', { code }))) })
      })
      const dir = workdir ? `?directory=${encodeURIComponent(workdir)}` : ''
      const listUrl = `${base}/session/${encodeURIComponent(sessionId)}/message${dir}`
      const before = await fetch(listUrl, { signal: AbortSignal.timeout(20_000) })
        .then(r => r.ok ? r.json() : null).catch(() => null)
      if (!Array.isArray(before)) return { error: t('OpenCode could not read the messages of session {sessionId}', { sessionId }) }
      const lastAssistant = [...before].reverse().find(m => m?.info?.role === 'assistant')
      // summarize needs an explicit provider + model: use the pair this session **actually ran**,
      // not the task's current model, which may not belong to this session's provider after a switch.
      const fallback = String(model || '')
      const providerID = lastAssistant?.info?.providerID || fallback.split('/')[0]
      const modelID = lastAssistant?.info?.modelID || fallback.split('/').slice(1).join('/')
      if (!providerID || !modelID) return { error: t('The OpenCode session has no usable provider/model, so it cannot be compacted') }
      const tokensBefore = lastAssistant?.info?.tokens?.total
      const res = await fetch(`${base}/session/${encodeURIComponent(sessionId)}/summarize${dir}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerID, modelID }),
        signal: AbortSignal.timeout(Math.max(10_000, remaining())),
      })
      const body = await res.text()
      if (!res.ok) return { error: t('OpenCode compaction failed (HTTP {status}): {detail}', { status: res.status, detail: body.slice(0, 300) }) }
      if (body.trim() !== 'true') return { error: t('OpenCode did not confirm compaction: {detail}', { detail: body.slice(0, 300) }) }
      // Success shows up as a new summary=true assistant message, where the next resume starts. Its
      // token count is the "after" figure, more trustworthy than an estimate.
      const after = await fetch(listUrl, { signal: AbortSignal.timeout(20_000) })
        .then(r => r.ok ? r.json() : null).catch(() => null)
      const summary = Array.isArray(after)
        ? [...after].reverse().find(m => m?.info?.summary === true)
        : null
      return {
        ok: true,
        detail: t('OpenCode wrote a native summary; the next turn starts from it'),
        tokens_before: Number.isFinite(tokensBefore) ? tokensBefore : undefined,
        tokens_after: Number.isFinite(summary?.info?.tokens?.total) ? summary.info.tokens.total : undefined,
      }
    } catch (e) {
      return { error: t('OpenCode compaction failed: {detail}', { detail: e.message }) }
    } finally {
      killCompactChild(child)
    }
  }

  return {
    id: 'opencode',
    label: 'OpenCode',
    executes: true,
    bin: () => OPENCODE_BIN,
    detect: collectOpencode,
    install: {
      oneClick: npmInstall('opencode', 'opencode-ai'),
      native: (real, home) => real.startsWith(`${home}/.opencode/bin/`),
      homebrewFormula: (real) => {
        try {
          const cellar = /^(.*\/Cellar\/(opencode(?:-v2)?)\/[^/]+)(?:\/|$)/.exec(real)
          if (cellar) {
            const tap = JSON.parse(fs.readFileSync(path.join(cellar[1], 'INSTALL_RECEIPT.json'), 'utf8'))?.source?.tap
            const formula = `${tap}/${cellar[2]}`
            if (['homebrew/core/opencode', 'anomalyco/tap/opencode', 'anomalyco/tap/opencode-v2'].includes(formula)) return formula
          }
        } catch { /* No reliable receipt means the formula's source is unknown. */ }
        return undefined
      },
      // V1 and V2 are different packages; never cross a major version in place.
      sameMajor: true,
      npmPackage: (targetMajor) => (targetMajor === 1 ? 'opencode-ai' : targetMajor === 2 ? '@opencode/cli' : ''),
      nativeUpdate: ({ executable, target, currentMajor, targetMajor }) => (currentMajor === targetMajor && (targetMajor === 1 || targetMajor === 2)
        ? { kind: 'command', file: executable, args: ['upgrade', targetMajor === 1 ? `v${target}` : target, '--method', 'curl'] }
        : null),
      brewUpdate: ({ input, brewFile, currentMajor, targetMajor }) => {
        if (currentMajor !== targetMajor) return null
        const raw = String(input?.homebrew_formula || '')
        const formula = raw === 'homebrew/core/opencode' ? 'opencode'
          : ['anomalyco/tap/opencode', 'anomalyco/tap/opencode-v2'].includes(raw) ? raw : ''
        return formula ? { kind: 'brew', file: brewFile, formula, cask: false, expected_major: targetMajor } : null
      },
      bundled: {
        available: () => bundledOpenCodeAvailable(),
        enable: () => useBundledOpenCode(),
        path: () => BUNDLED_OPENCODE,
        flagFile: () => BUNDLED_OPENCODE_FLAG,
      },
    },
    nativeInstructions: true,
    models: () => opencodeGroup(),
    quota: () => collectOpencodeGoQuota(),
    session: files.session,
    ownFiles: createOpencodeFiles,
    // The storage layout the session functions read depends on the installed major version.
    filesState: () => ({ major: opencodeMajor }),
    status: (result, previous) => mergeOpencodeRuntimeStatus(result, previous),
    ready: () => opencodeVersion(),
    prepare: async (run) => { await opencodeVersion(); run.opencode_major = opencodeMajor },
    toolSetup: openCodeRuntimeSetup,
    command: opencodeArgs,
    import: files.import,
    handler: hctx => createOpenCodeNativeRun(hctx, opencodeHandler(hctx)),
    stream: { raw: true, stderr: 'raw' },
    completion: 'handler',
    failOnErrorText: true,
    defaultModel: () => opencodeDefaultModel,
    processEnv: async (env, { run, setup, cwd, images }) => {
      const password = crypto.randomBytes(24).toString('hex')
      env.OPENCODE_SERVER_PASSWORD = password
      env.OPENCODE_PASSWORD = password
      env.OPENCODE_SERVER_USERNAME = 'opencode'
      env.OPENCODE_USERNAME = 'opencode'
      if (setup) {
        env.OPENCODE_CONFIG_CONTENT = setup.config
        // V2 prefers PWD over cwd when locating the project.
        env.PWD = cwd || process.cwd()
      }
      // Images go inline; read them asynchronously before the run starts.
      const opencodeFiles = await Promise.all(images.map(async file => ({ filename: path.basename(file), mime: mimeFor(file), url: `data:${mimeFor(file)};base64,${(await fs.promises.readFile(file)).toString('base64')}` })))
      return () => ({
        opencodeMajor: run.opencode_major,
        opencodeAuthorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        opencodeMessageId: `msg_${crypto.randomBytes(16).toString('hex')}`,
        opencodeFiles,
      })
    },
    nativeTitle: files.nativeTitle,
    compact: (id, workdir, model) => compactOpencode(id, workdir, model),
    userChoices: { tool: 'question', fields: 'label and description' },
  }
}
