// Codex (`codex app-server`): one long-lived app-server per task, driven over JSON-RPC.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { COMPACT_TIMEOUT_MS, npmInstall, quotaFailure, usageJson } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createCodexFiles(io) {
  const { fs, os, path, SqliteDatabaseSync, t, sessionImport } = io
  const { recentFiles, sameWorkdir, jsonlRows, jsonlPrefixRows, importText, importTime, importTitle, cleanImportedUserText, isImportedContextMessage } = sessionImport

  /** Codex rollout files are local execution state. A thread id is not portable
   *  by itself, so a missing file means this run must rebuild from its fallback
   *  prompt and establish a new thread on this same machine. */
  function codexSessionPath(threadId) {
    if (!threadId) return ''
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) return path.join(dir, entry.name)
      }
    }
    return ''
  }

  function codexSessionExists(threadId) {
    return !!codexSessionPath(threadId)
  }

  function firstCodexUserText(file, maxBytes = 4 * 1024 * 1024) {
    let handle
    try {
      handle = fs.openSync(file, 'r')
      const chunk = Buffer.alloc(64 * 1024)
      let pending = ''
      let offset = 0
      while (offset < maxBytes) {
        const bytes = fs.readSync(handle, chunk, 0, Math.min(chunk.length, maxBytes - offset), offset)
        if (!bytes) break
        offset += bytes
        const lines = (pending + chunk.subarray(0, bytes).toString('utf8')).split('\n')
        pending = lines.pop() || ''
        for (const line of lines) {
          let row
          try { row = line ? JSON.parse(line) : null } catch { continue }
          const item = row?.type === 'response_item' ? row.payload : null
          if (item?.type !== 'message' || item.role !== 'user') continue
          const content = importText(item.content, ['input_text', 'text'])
          if (content && !isImportedContextMessage(content)) return cleanImportedUserText(content)
        }
      }
      return ''
    } catch { return '' } finally { try { if (handle !== undefined) fs.closeSync(handle) } catch {} }
  }

  /** Codex stores every project together under ~/.codex/sessions. The cwd lives
   *  in the small session_meta record at the start of each file, so discovery
   *  must inspect that header before it can know which project owns the file.
   *  Read only a bounded prefix here; full transcripts are parsed only after the
   *  cwd exactly matches the project being scanned. */
  function codexImportMeta(file, mtime) {
    try {
      const rows = jsonlPrefixRows(file, 64 * 1024)
      const meta = rows.find(row => row.type === 'session_meta')?.payload
      const sessionId = String(meta?.id || meta?.session_id || '')
      if (!sessionId || !meta?.cwd) return null
      return {
        runtime: 'codex', session_id: sessionId, workdir: meta.cwd,
        title: t('Untitled task'), updated_at: importTime(mtime), message_count: 0,
      }
    } catch { return null }
  }

  function codexImportSummary(file, mtime) {
    try {
      const rows = jsonlPrefixRows(file, 64 * 1024)
      const meta = rows.find(row => row.type === 'session_meta')?.payload
      const sessionId = String(meta?.id || meta?.session_id || '')
      if (!sessionId || !meta?.cwd) return null
      const firstUser = firstCodexUserText(file)
      return {
        runtime: 'codex', session_id: sessionId, workdir: meta.cwd,
        title: importTitle('', firstUser ? [{ role: 'user', content: firstUser }] : []),
        updated_at: importTime(mtime), message_count: 0,
      }
    } catch { return null }
  }

  function codexImportSession(file, mtime, withMessages = false) {
    const rows = jsonlRows(file)
    const meta = rows.find(row => row.type === 'session_meta')?.payload
    const sessionId = String(meta?.id || meta?.session_id || '')
    if (!sessionId || !meta?.cwd) return null
    const messages = []
    for (const row of rows) {
      const item = row.type === 'response_item' ? row.payload : null
      if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue
      const content = importText(item.content, item.role === 'user' ? ['input_text', 'text'] : ['output_text', 'text'])
      if (!content) continue
      if (item.role === 'user' && isImportedContextMessage(content)) continue
      messages.push({ role: item.role, content: item.role === 'user' ? cleanImportedUserText(content) : content, created_at: importTime(row.timestamp, mtime) })
    }
    return {
      runtime: 'codex', session_id: sessionId, workdir: meta.cwd,
      title: importTitle('', messages), updated_at: importTime(meta.timestamp, mtime),
      message_count: messages.length, ...(withMessages ? { messages: messages.slice(-sessionImport.messageLimit) } : {}),
    }
  }

  function codexImportTitles(workdir, codexHome) {
    const titles = new Map()
    if (!SqliteDatabaseSync) return titles
    const sources = [
      {
        file: path.join(codexHome, 'sqlite', 'codex-dev.db'),
        sql: `SELECT thread_id AS id,display_title AS title FROM local_thread_catalog
            WHERE cwd=? AND missing_candidate=0 AND display_title<>''`,
      },
      {
        file: path.join(codexHome, 'state_5.sqlite'),
        sql: `SELECT id,title FROM threads WHERE cwd=? AND title<>''`,
      },
      {
        file: path.join(codexHome, 'sqlite', 'state_5.sqlite'),
        sql: `SELECT id,title FROM threads WHERE cwd=? AND title<>''`,
      },
    ]
    for (const source of sources) {
      if (!fs.existsSync(source.file)) continue
      let db
      try {
        db = new SqliteDatabaseSync(source.file, { readOnly: true })
        for (const row of db.prepare(source.sql).all(workdir)) {
          const id = String(row.id || '')
          const title = String(row.title || '').trim()
          if (id && title && !titles.has(id)) titles.set(id, title)
        }
      } catch { /* Codex versions differ; JSONL remains the fallback. */ } finally { try { db?.close() } catch {} }
    }
    return titles
  }

  return {
    session: { path: id => codexSessionPath(id), exists: id => codexSessionExists(id) },
    import: {
      list: (wanted, withMessages) => {
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
        const codexRoot = path.join(codexHome, 'sessions')
        const codexTitles = codexImportTitles(wanted, codexHome)
        return recentFiles(codexRoot, name => name.endsWith('.jsonl')).flatMap(item => {
          const meta = codexImportMeta(item.file, item.mtime)
          if (!meta || !sameWorkdir(meta.workdir, wanted)) return []
          const session = withMessages ? codexImportSession(item.file, item.mtime, true) : meta
          if (!session) return []
          const nativeTitle = codexTitles.get(session.session_id)
          return [{
            ...session,
            ...(nativeTitle ? { title: importTitle(nativeTitle, []) } : {}),
            source_file: item.file,
            source_mtime: item.mtime,
          }]
        })
      },
      read: source => (source.file ? codexImportSession(source.file, source.mtime, true) : null),
      summary: source => codexImportSummary(source.file, source.mtime),
    },
  }
}

export function createCodexAdapter(ctx) {
  const { execFile, spawn, systemExec, VERSION_PROBE_MS, SqliteDatabaseSync, killCompactChild, killProcessTree, processIdentity, runtimeStops, artifactSpoolPath, runtimeInstructions, toolServerSpec, cleanTitle, titlePrompt, sessionImport, t } = ctx
  const files = createCodexFiles({ fs, os, path, SqliteDatabaseSync, t, sessionImport })
  // Override the codex executable (testing stubs / custom install paths).
  // Override the codex executable (testing stubs / custom install paths).
  const CODEX_BIN = ctx.config('CODEX_BIN') || 'codex'
  // Read through a function: the run handler's own parameter is also named ctx.
  const runnerVersion = () => ctx.runnerVersion

  function collectCodex() {
    return new Promise((resolve) => {
      execFile(CODEX_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => {
        // Login is not probed in the background (0.85.4): installed counts as usable, and the first real run proves it
        if (!err) return resolve({ installed: true, login: true, version: stdout.trim() || null })
        // Better to call an installed CLI usable than a usable one missing: only "command not found"
        // means not installed; a timeout or non-zero exit means the binary exists and this read just
        // failed, so the last known version is kept.
        const missing = err.code === 'ENOENT'
        console.error(`[probe] codex --version failed: code=${err.code ?? ''} signal=${err.signal ?? ''}${missing ? ' (not on PATH)' : ' (binary exists; keeping it available)'}`)
        resolve({ installed: !missing, login: !missing, version: missing ? null : (ctx.lastGoodStatus('codex')?.version ?? null) })
      })
    })
  }

  async function collectCodexQuota() {
    let tokens
    try { tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))?.tokens }
    catch { return quotaFailure('codex', t('Not logged in to Codex')) }
    if (!tokens?.access_token) return quotaFailure('codex', t('Not logged in to Codex'))
    try {
      const headers = { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'codex_cli_rs' }
      if (tokens.account_id) headers['chatgpt-account-id'] = tokens.account_id
      const data = await usageJson('https://chatgpt.com/backend-api/wham/usage', headers)
      const windows = []
      for (const window of [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]) {
        if (!window) continue
        const hours = (window.limit_window_seconds || 0) / 3600
        const days = Math.round(hours / 24)
        windows.push({
          label: hours >= 24 ? t('{n} days', { n: days }) : t('{n} hours', { n: Math.round(hours) }),
          short: hours >= 24 ? `${days}d` : `${Math.round(hours)}h`,
          percent: Math.round(window.used_percent || 0),
          resets_at: typeof window.reset_at === 'number' ? new Date(window.reset_at * 1000).toISOString() : null,
        })
      }
      return { runtime: 'codex', ok: true, plan: data.plan_type, windows, fetched_at: new Date().toISOString() }
    } catch (e) { return quotaFailure('codex', t('Could not fetch the quota: {detail}', { detail: e.message })) }
  }

  /** The codex catalog: `codex debug models`, run live. Cached for 60s and, like every other
   *  group, invalidated by "refresh" (force=true really runs it). A failure keeps the last raw
   *  output rather than dropping the whole group. */
  let codexCatalogCache = null // { raw, at }

  const CODEX_CATALOG_TTL_MS = 60_000

  async function codexCatalogRaw({ force = false } = {}) {
    if (!force && codexCatalogCache && Date.now() - codexCatalogCache.at < CODEX_CATALOG_TTL_MS) {
      return codexCatalogCache.raw
    }
    const raw = await new Promise((resolve) => {
      execFile(CODEX_BIN, ['debug', 'models'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err && stdout) return resolve(stdout)
        // Log the reason: it used to be dropped, leaving no way to tell a missing command from a timeout
        const tail = String(stderr || '').replace(os.homedir(), '~').trim().slice(-300)
        console.error(`[probe] codex debug models failed: code=${err?.code ?? ''} signal=${err?.signal ?? ''}${err ? '' : ' (empty output)'}${tail ? ` stderr: ${tail}` : ''}`)
        // Re-read the login PATH only when it was found before and is gone now: a machine without Codex
        // gets ENOENT every round, and must not start a shell every minute
        if (err?.code === 'ENOENT' && ctx.hasLastGood('codex')) ctx.refreshShellPath('codex catalog: command not found').catch(() => {})
        resolve(null)
      })
    })
    if (raw) codexCatalogCache = { raw, at: Date.now() }
    return raw || codexCatalogCache?.raw || null
  }

  /** The raw `codex debug models` catalog → top-level models / default_model / default_effort. */
  async function parseCodexCatalog(catalogRaw) {
    const configTxt = await fs.promises.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf-8').catch(() => null)
    const parsed = JSON.parse(catalogRaw)
    // visibility 'hide' just means "not in the default picker" — the model
    // still runs fine via -m, so surface everything except internal review
    // models and reserve (overflow capacity pool, not for interactive picking).
    const models = (parsed.models || [])
      .filter((m) => !m.slug.includes('review') && !m.slug.startsWith('gpt-reserve'))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map((m) => ({
        slug: m.slug,
        display_name: m.display_name || m.slug,
        description: m.description,
        default_reasoning_level: m.default_reasoning_level,
        reasoning_levels: m.supported_reasoning_levels || [],
      }))
    return {
      models,
      default_model: (configTxt && /^model\s*=\s*"([^"]+)"/m.exec(configTxt)?.[1]) || models[0]?.slug || null,
      default_effort: (configTxt && /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(configTxt)?.[1]) || null,
    }
  }

  // Only Runner-owned Codex processes are reusable. A logical child represents
  // exactly one run; the underlying app-server retains its native thread/client.
  function codexSessions() {
    return globalThis.__openTandemCodexSessions || (globalThis.__openTandemCodexSessions = new Map())
  }

  function codexArtifactContextPath(run) {
    const key = crypto.createHash('sha256').update(String(run.task_id || run.run_id)).digest('hex').slice(0, 24)
    return path.join(os.tmpdir(), `opentandem-codex-${process.pid}-${key}.json`)
  }

  function writeCodexArtifactContext(session, spool = '') {
    const file = session.contextPath
    fs.writeFileSync(file + '.tmp', JSON.stringify({ spool }), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }

  async function retireCodexSession(session) {
    if (!session) return
    session.stop()
    let timer
    try {
      await Promise.race([session.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex process did not stop; refusing to resume concurrently')), 10_000)
      })])
    } finally { clearTimeout(timer) }
  }

  async function closeCodexSessions(threadId = '') {
    for (const session of [...codexSessions().values()]) {
      if (threadId && session.threadId !== threadId) continue
      if (threadId && session.active) throw new Error('Codex session is still executing')
      await retireCodexSession(session)
    }
  }

  // Record process ancestry without reading environments or command arguments.
  // Codex's managed terminals may create their own process groups, so signalling
  // only the app-server's group cannot reap them after an unexpected crash.
  // The scan runs on the Runner's system process lane: on Windows the synchronous
  // PowerShell scan held the Runner for 0.76 s every 2 s while Codex ran.
  async function codexProcessSnapshot() {
    const rows = new Map()
    try {
      if (process.platform === 'win32') {
        const { error, stdout } = await systemExec('powershell.exe', ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress'],
        { timeout: 10_000 })
        if (error) return null
        const parsed = JSON.parse(stdout)
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
          rows.set(Number(row.ProcessId), { parent: Number(row.ParentProcessId), started: String(row.CreationDate), identity: `${row.CreationDate}|${row.Name}` })
        }
      } else {
        // The start time is the rest of the line: its word count follows the system locale
        // (a Chinese-locale macOS prints four words where English prints five), so it is never split into fields.
        // A pid plus its start time to the second already identifies one process.
        const { error, stdout } = await systemExec('ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 5_000 })
        if (error) return null
        for (const line of stdout.split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line)
          if (!match) continue
          rows.set(Number(match[1]), { parent: Number(match[2]), started: match[3], identity: match[3] })
        }
      }
    } catch { return null /* Failed inspection is not evidence that descendants exited. */ }
    return rows
  }

  // Periodic owners share one metadata scan across the Runner (a fresh cached one,
  // or the one in flight). Starts, tool starts and termination force a scan of their
  // own: stale identities must never be used as permission to signal a process.
  // Each scan carries the order it started in, because asynchronous scans can finish
  // out of order. Resolves { rows, seq } or null.
  function cachedCodexProcessSnapshot(force = false) {
    const cached = globalThis.__openTandemCodexProcessSnapshot
    if (!force) {
      if (cached && Date.now() - cached.at < 1_000) return Promise.resolve({ rows: cached.rows, seq: cached.seq })
      if (globalThis.__openTandemCodexProcessScan) return globalThis.__openTandemCodexProcessScan
    }
    const seq = globalThis.__openTandemCodexProcessSeq = (globalThis.__openTandemCodexProcessSeq || 0) + 1
    const scan = Promise.resolve(codexProcessSnapshot()).then(rows => {
      if (!rows) return null
      const latest = globalThis.__openTandemCodexProcessSnapshot
      if (!latest || latest.seq < seq) globalThis.__openTandemCodexProcessSnapshot = { rows, at: Date.now(), seq }
      return { rows, seq }
    }, () => null).finally(() => {
      if (globalThis.__openTandemCodexProcessScan === scan) globalThis.__openTandemCodexProcessScan = null
    })
    globalThis.__openTandemCodexProcessScan = scan
    return scan
  }

  // This is observation, not an OS job object: a child that forks and is
  // reparented before the first sample cannot be attributed safely. Do not
  // broaden cleanup to unrelated processes to hide that boundary.
  function trackCodexProcesses(rootPid) {
    const tracked = new Map()
    let rootIdentity = null
    let timer = null
    let appliedSeq = 0
    const apply = (snapshot) => {
      if (!snapshot) return null
      const { rows, seq } = snapshot
      // An older scan finishing late must not drop descendants a newer one recorded.
      if (seq < appliedSeq) return rows
      appliedSeq = seq
      const root = rows.get(rootPid)
      if (root && !rootIdentity) rootIdentity = root.started
      const owned = new Set()
      if (root && root.started === rootIdentity) owned.add(rootPid)
      for (const [pid, identity] of tracked) {
        if (rows.get(pid)?.identity === identity) owned.add(pid)
        else tracked.delete(pid)
      }
      // Previously observed descendants remain roots after reparenting. A PID
      // that was recycled with a different identity is never followed or killed.
      let expanded = true
      while (expanded) {
        expanded = false
        for (const [pid, row] of rows) {
          if (pid !== rootPid && !owned.has(pid) && owned.has(row.parent)) {
            owned.add(pid)
            tracked.set(pid, row.identity)
            expanded = true
          }
        }
      }
      return rows
    }
    /** Resolves the rows of this scan, or null when the inspection failed. */
    const capture = (force = true) => cachedCodexProcessSnapshot(force).then(apply)
    return {
      capture,
      start() {
        if (timer) return
        void capture()
        timer = setInterval(() => { void capture(false) }, process.platform === 'win32' ? 2_000 : 1_000)
        timer.unref?.()
      },
      pause() { clearInterval(timer); timer = null },
      async signal(signal) {
        const rows = await capture()
        if (!rows) return // Never signal a PID using the cached identity alone.
        for (const [pid, identity] of tracked) {
          if (rows.get(pid)?.identity !== identity) continue
          try { process.kill(pid, signal) } catch { /* Already gone. */ }
        }
      },
    }
  }

  async function acquireCodexChild(run, bin, argv, options) {
    const pool = codexSessions()
    const key = String(run.task_id || run.run_id)
    const acquiring = globalThis.__openTandemCodexAcquiring || (globalThis.__openTandemCodexAcquiring = new Set())
    if (acquiring.has(key)) throw new Error('Codex session is already executing; refusing concurrent turns')
    acquiring.add(key)
    try {
      const codexHome = options.env.CODEX_HOME || path.join(options.env.HOME || options.env.USERPROFILE || os.homedir(), '.codex')
      const configFiles = [path.join(codexHome, 'config.toml'), path.join(codexHome, 'auth.json'),
        path.join(options.cwd || process.cwd(), '.codex', 'config.toml')]
      // The workdir one may sit on a slow network drive: stat asynchronously.
      const configStamps = await Promise.all(configFiles.map(async file => {
        try { const stat = await fs.promises.stat(file); return [file, stat.mtimeMs, stat.size] } catch { return [file, null] }
      }))
      const fingerprint = JSON.stringify([bin, options.cwd || '', argv, options.env, configStamps])
      let session = pool.get(key)
      if (session?.active || session?.settling || session?.acquiring) throw new Error('Codex session is already executing; refusing concurrent turns')
      if (session && (session.fingerprint !== fingerprint || !run.resume_thread_id || session.threadId !== run.resume_thread_id || session.stopping || session.exited)) {
        session.acquiring = true
        await retireCodexSession(session)
        session = null
      }
      if (!session) {
        const raw = spawn(bin, argv, options)
        let closed
        session = { raw, identity: null, fingerprint, threadId: '', nextRpcId: 1, completedTurns: new Set(),
          contextPath: codexArtifactContextPath(run), active: null, idleTimer: null,
          stopping: false, exited: false, closed: new Promise(resolve => { closed = resolve }) }
        const owned = session
        // The identity comes from the Runner's system process lane; reaping waits for it.
        owned.identityReady = Promise.resolve(processIdentity(raw.pid)).then(identity => { owned.identity = identity; return identity }, () => null)
        owned.processes = trackCodexProcesses(raw.pid)
        let killTimer
        owned.stop = () => {
          if (owned.stopping || owned.exited) return
          owned.stopping = true
          clearTimeout(owned.idleTimer)
          owned.processes.pause()
          void owned.processes.signal('SIGTERM')
          try { fs.rmSync(owned.contextPath, { force: true }) } catch {}
          const signal = value => {
            if (owned.exited) return
            try { void killProcessTree(raw.pid, value) } catch { try { raw.kill(value) } catch {} }
          }
          signal('SIGTERM')
          killTimer = setTimeout(() => { void owned.processes.signal('SIGKILL'); signal('SIGKILL') }, 5_000)
          killTimer.unref?.()
        }
        runtimeStops().add(owned.stop)
        raw.stdin.on('error', () => {})
        raw.stdout.on('data', data => {
          // Sample promptly when a command/tool begins, before the next timer.
          if (data.toString().includes('item/started')) void owned.processes.capture()
          owned.active?.forward('stdout', 'data', data)
        })
        raw.stderr.on('data', data => owned.active?.forward('stderr', 'data', data))
        raw.on('error', error => {
          if (owned.active) owned.active.forward('', 'error', error)
          owned.stop()
        })
        let reaped = null
        const reapGroup = () => {
          if (reaped) return reaped
          owned.processes.pause()
          // A dead group leader can leave exec/MCP descendants behind. Reap this
          // owned group before a replacement is allowed to spawn (the pool entry
          // and `closed` wait for it). Never target a PID now occupied by an
          // unrelated process. Bounded: every process query has a timeout, and a
          // replacement waits at most 8 s here.
          const reap = (async () => {
            await owned.processes.signal('SIGKILL')
            const [identity, expected] = await Promise.all([processIdentity(raw.pid), owned.identityReady])
            if (raw.pid && (!identity || identity === expected)) {
              try { await killProcessTree(raw.pid, 'SIGKILL') } catch {}
            }
          })().catch(() => {})
          reaped = Promise.race([reap, new Promise(resolve => setTimeout(resolve, 8_000).unref?.())])
          return reaped
        }
        raw.on('exit', () => {
          owned.exited = true
          void reapGroup()
          clearTimeout(killTimer)
        })
        raw.on('close', (code, signal) => {
          void reapGroup()
          owned.exited = true
          clearTimeout(killTimer)
          clearTimeout(owned.idleTimer)
          runtimeStops().delete(owned.stop)
          try { fs.rmSync(owned.contextPath, { force: true }) } catch {}
          const active = owned.active
          owned.active = null
          void reapGroup().then(() => {
            if (pool.get(key) === owned) pool.delete(key)
            closed()
          })
          active?.forward('', 'close', code, signal)
        })
        pool.set(key, owned)
      }
      clearTimeout(session.idleTimer)
      try { writeCodexArtifactContext(session, artifactSpoolPath(run)) } catch (error) { session.stop(); throw error }
      const owned = session
      const child = Object.assign(new EventEmitter(), {
        pid: owned.raw.pid, stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: owned.raw.stdin, reusedThreadId: owned.threadId, identityReady: owned.identityReady,
        nextRpcId: () => owned.nextRpcId++,
        isPreviousTurn: id => owned.completedTurns.has(id),
        rememberTurn: id => { if (id) owned.completedTurns.add(id) },
        setThread: id => { owned.threadId = id },
        kill: () => owned.stop(),
        complete: () => {
          if (owned.active !== child) return
          writeCodexArtifactContext(owned)
          owned.processes.pause()
          owned.active = null
          owned.settling = true
          queueMicrotask(() => child.emit('close', 0, null))
        },
        release: () => {
          if (!owned.settling || owned.exited || owned.stopping) return
          owned.settling = false
          owned.idleTimer = setTimeout(() => owned.stop(), 5 * 60_000)
          owned.idleTimer.unref?.()
        },
      })
      const queued = []
      let attached = false
      child.forward = (stream, event, ...args) => {
        if (!attached) queued.push([stream, event, args])
        else (stream ? child[stream] : child).emit(event, ...args)
      }
      child.attach = () => {
        attached = true
        for (const [stream, event, args] of queued.splice(0)) (stream ? child[stream] : child).emit(event, ...args)
      }
      owned.active = child
      owned.processes.start()
      return child
    } finally { acquiring.delete(key) }
  }

  /** Codex always runs through app-server JSON-RPC (exec is gone since 0.51.0): exec exits after
   *  one turn, so a goal the model created in natural language never got to continue (device probe,
   *  2026-09-27); app-server stays up and codex starts the next turn itself while the goal is open.
   *  Sandbox/approval map exactly as they did for exec; MCP and runtime rules are injected with the
   *  same -c flags (schedule_* is directly visible in app-server mode, no tool_search needed).
   *  stdin stays open: the handler drives the handshake. */
  function codexSandboxMode(run) {
    return run?.exec_mode === 'readonly' ? 'read-only'
      : run?.exec_mode === 'full' || run?.exec_mode === 'yolo' ? 'danger-full-access'
      : 'workspace-write'
  }

  /** Passed to every app-server start: at startup Codex force-downloads a ~40MB remote plugin
   *  catalog regardless of cache, and with the remote catalog on it skips plugins installed from
   *  GitHub plugin repos (superpowers, canva, ...). */
  const CODEX_APP_SERVER_BASE_FLAGS = ['--disable', 'remote_plugin']

  function codexAppServerArgs(run) {
    const argv = ['app-server', ...CODEX_APP_SERVER_BASE_FLAGS, '--enable', 'default_mode_request_user_input', '-c', `sandbox_mode="${codexSandboxMode(run)}"`]
    if (codexSandboxMode(run) === 'workspace-write') argv.push('-c', 'sandbox_workspace_write.network_access=true')
    argv.push('-c', 'approval_policy="never"')
    if (run.model) argv.push('-c', `model=${JSON.stringify(run.model)}`)
    if (run.reasoning_effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(run.reasoning_effort)}`)
    if (runtimeInstructions(run)) {
      argv.push('-c', `developer_instructions=${JSON.stringify(runtimeInstructions(run))}`)
    }
    {
      const spec = toolServerSpec(run)
      argv.push('-c', `mcp_servers.opentandem.command=${JSON.stringify(spec.command)}`)
      argv.push('-c', `mcp_servers.opentandem.args=${JSON.stringify(spec.args)}`)
      // Optional MCP servers can be omitted while still starting up; these tools
      // must be ready before Codex builds the first turn's tool catalog.
      argv.push('-c', 'mcp_servers.opentandem.required=true')
      argv.push('-c', 'mcp_servers.opentandem.default_tools_approval_mode="approve"')
      for (const [k, v] of Object.entries(spec.env)) {
        argv.push('-c', `mcp_servers.opentandem.env.${k}=${JSON.stringify(v)}`)
      }
    }
    return { argv, stdinText: '', cwd: run.workdir || undefined, keepStdinOpen: true }
  }

  /** codex app-server → StreamEvents (every codex task; goal mode and plain tasks share one path).
   *  Behaviour follows the 2026-09-25 / 09-27 probes:
   *  - Bidirectional JSON-RPC: the handshake (initialize → thread/start|resume → [/goal only:
   *    goal/clear → goal/set] → turn/start) is driven by this handler through ctx.send; responses
   *    and notifications are interleaved on stdout.
   *  - A goal the model creates in natural language (create_goal) also emits thread/goal/updated
   *    and continues just like /goal.
   *  - Ending: on turn/completed, if the goal is not active (none / complete / blocked ...) this run
   *    ends; while the goal is still active, wait for codex to start the next turn itself.
   *  - agentMessage carries its phase (commentary/final_answer), so the exec-era trick of showing
   *    text as narration first and reclaiming it at turn end is unnecessary.
   *  - Headless goal auto-continuation works: as long as the goal is active when a turn ends,
   *    codex starts the next turn, and this only follows the thread/goal/updated state machine.
   *  - Reusing a thread whose goal already completed needs goal/clear first, or the status stays
   *    complete and never activates.
   */
  function codexAppServerHandler(ctx) {
    const GOAL_STATUS_TEXT = {
      paused: t('The goal is paused (waiting for an external condition)'),
      usageLimited: t('The goal is paused by the account usage limit; it can continue in this conversation once quota returns'),
      budgetLimited: t('The goal used up its token budget without finishing'),
      abandoned: t('The goal was abandoned'),
    }
    let nextRpcId = 1
    let finished = false
    const rpcTimers = new Map()
    let livenessTimer = null
    let livenessPending = false
    const clearProtocolTimers = () => {
      clearTimeout(livenessTimer)
      for (const timer of rpcTimers.values()) clearTimeout(timer)
      rpcTimers.clear()
    }
    const stop = (discard = false) => { finished = true; clearProtocolTimers(); ctx.stop(discard) }
    let threadId = ctx.resumeThreadId || ''
    let threadPolicy = {}
    let goalStatus = ''
    let sawChildThread = false
    let answerText = ''
    let tokenBase = null
    const startedTurnIds = new Set()
    let lastUnphasedMessage = ''
    const pending = new Map()
    const notify = (method, params) => ctx.send({ jsonrpc: '2.0', method, params })
    const rpc = (method, params) => {
      const id = ctx.nextRpcId ? ctx.nextRpcId() : nextRpcId++
      pending.set(id, method)
      // Bound protocol operations, not model thinking or shell execution time.
      const timer = setTimeout(() => {
        if (finished || !pending.has(id)) return
        ctx.setErrorText(`Codex app-server did not respond to ${method} within 60 seconds`)
        stop(true)
      }, 60_000)
      timer.unref?.()
      rpcTimers.set(id, timer)
      ctx.send({ jsonrpc: '2.0', id, method, params })
      return id
    }
    const checkLiveness = () => {
      clearTimeout(livenessTimer)
      livenessTimer = setTimeout(() => {
        if (finished || cleaning || livenessPending) return
        livenessPending = true
        rpc('thread/read', { threadId, includeTurns: false })
      }, 30_000)
      livenessTimer.unref?.()
    }
    const narrate = (text) => {
      if (!text) return
      ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: text })
      ctx.pump.push({ type: 'reasoning_delta', data: { text } })
    }
    const stopGoal = (errorText) => {
      if (errorText) ctx.setErrorText(errorText)
      stop()
    }
    // complete may arrive before the final reply, or be an old status replayed on resume.
    // Success ends only on turn/completed; a timer must never kill a turn still writing its reply.
    let failureTimer = null
    let cleanupTimer = null
    let terminalsPending = 0
    let cleaning = false
    const onGoalFailure = () => {
      if (failureTimer) return
      // The caller already recorded the failure text with setErrorText; keep the usual failure ending.
      failureTimer = setTimeout(() => stopGoal(null), 1_000)
    }
    let userInput = null
    const handler = { line(m) {}, flush() {}, answer(input) {
      if (finished || !userInput || input?.key !== userInput.key || !input.answers) return
      ctx.send({ jsonrpc: '2.0', id: userInput.id, result: { answers: input.answers } })
      ctx.pump.push({ type: 'user_input_answered', data: { key: userInput.key } })
      userInput = null
      void ctx.pump.finish()
    } }
    handler.line = (m) => {
      if (finished) return
      if (m && m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        onResp(m)
      } else if (m && m.method) {
        onNotify(m)
      }
    }
    const startTurn = () => rpc('turn/start', {
      threadId,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.reasoningEffort ? { effort: ctx.reasoningEffort } : {}),
      input: [{ type: 'text', text: ctx.instruction }, ...ctx.localImages.map(p => ({ type: 'localImage', path: p }))],
    })
    function prepareTurn() {
      // Codex resume accepts developerInstructions but does not append changed
      // instructions to model-visible history (0.159.2). Refresh the developer
      // channel before a resumed/reused turn, including its current reply-to.
      if ((ctx.resumeThreadId || ctx.reusedThreadId) && ctx.runtimeInstructions) {
        rpc('thread/inject_items', { threadId, items: [{
          type: 'message', role: 'developer', content: [{ type: 'input_text',
            text: '[Current runtime instructions]\nThese instructions replace previous runtime instructions and delegation metadata. Only the reply-to instruction in this block, if present, applies to the current request.\n' + ctx.runtimeInstructions + '\n[End of current runtime instructions]',
          }],
        }] })
      } else beginTurn()
    }
    function beginTurn() {
      if (ctx.goal?.objective) rpc('thread/goal/clear', { threadId })
      else startTurn()
    }
    function onResp(m) {
      const method = pending.get(m.id)
      clearTimeout(rpcTimers.get(m.id))
      rpcTimers.delete(m.id)
      pending.delete(m.id)
      if (method === 'thread/read') {
        livenessPending = false
        if (m.error) { ctx.setErrorText(`Codex app-server session check failed: ${m.error.message || 'thread/read'}`); stop(true); return }
        if (!cleaning) checkLiveness()
      } else if (method === 'thread/backgroundTerminals/list') {
        if (m.error) { stop(true); return }
        const terminals = m.result?.data
        if (!Array.isArray(terminals)) { stop(true); return }
        if (!terminals.length) { clearTimeout(cleanupTimer); stop(); return }
        terminalsPending = terminals.length
        for (const terminal of terminals) rpc('thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId })
      } else if (method === 'thread/backgroundTerminals/terminate') {
        if (m.error) { stop(true); return }
        if (--terminalsPending === 0) rpc('thread/backgroundTerminals/list', { threadId })
      } else if (method === 'initialize') {
        if (m.error) { ctx.setErrorText(t('Codex failed to initialize: {detail}', { detail: m.error.message || JSON.stringify(m.error) })); stop(); return }
        notify('initialized', {})
        // Sandbox and approval must be sent with every start/resume: thread/resume restores the
        // thread's own remembered settings over the process's -c sandbox_mode. The app-server
        // started for manual compaction is read-only, so one compaction left the task read-only
        // forever (Windows acceptance, 2026-09-28).
        threadPolicy = { sandbox: codexSandboxMode({ exec_mode: ctx.execMode }), approvalPolicy: 'never',
          ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
          ...(ctx.runtimeInstructions ? { developerInstructions: ctx.runtimeInstructions } : {}),
        }
        rpc(ctx.resumeThreadId ? 'thread/resume' : 'thread/start',
          ctx.resumeThreadId ? { threadId: ctx.resumeThreadId, excludeTurns: true, ...threadPolicy } : threadPolicy)
      } else if (method === 'thread/resume' && /already has an active writer/i.test(m.error?.message || '')) {
        // Another Codex process holds the writer lock (typically the ChatGPT desktop app has the
        // thread loaded and never releases it while running), so resume always fails and retrying is
        // useless. fork only reads the source and copies it into a new thread with the full history;
        // setSession reports the new id and later turns continue the fork (verified on 0.159.2, 2026-10-20).
        console.log('[codex] thread writer lock held elsewhere; forking the thread to continue')
        rpc('thread/fork', { threadId: ctx.resumeThreadId, excludeTurns: true, ...threadPolicy })
      } else if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
        if (m.error) { ctx.setErrorText(t('Codex could not load the session: {detail}', { detail: m.error.message || JSON.stringify(m.error) })); stop(); return }
        const id = m.result?.thread?.id
        if (!id) { ctx.setErrorText(t('Codex returned no session id')); stop(); return }
        threadId = id
        // Codex hands over its rollout path with the thread: the Runner then never walks the session store.
        const rollout = m.result.thread.path
        if (typeof rollout === 'string' && rollout) ctx.setSession(id, rollout)
        else ctx.setSession(id)
        // Setting a goal on a thread whose goal already completed without clearing keeps the status complete (probes 4/5)
        prepareTurn()
      } else if (method === 'thread/inject_items') {
        if (m.error) { ctx.setErrorText(`Codex could not refresh runtime instructions: ${m.error.message || JSON.stringify(m.error)}.`); stop(true); return }
        beginTurn()
      } else if (method === 'thread/goal/clear') {
        rpc('thread/goal/set', { threadId, objective: ctx.goal.objective, tokenBudget: ctx.goal.token_budget || 2_000_000 })
      } else if (method === 'thread/goal/set') {
        if (m.error) { ctx.setErrorText(t('Codex refused to set the goal: {detail}', { detail: m.error.message || JSON.stringify(m.error) })); stop(); return }
        goalStatus = m.result?.goal?.status || 'active'
        startTurn()
      } else if (method === 'turn/start' && m.result?.turn?.id) {
        startedTurnIds.add(m.result.turn.id)
        checkLiveness()
      } else if (method === 'turn/start' && m.error) {
        ctx.setErrorText(t('Codex refused to start the turn: {detail}', { detail: m.error.message || JSON.stringify(m.error) }))
        stop()
      }
    }
    function onNotify(m) {
      const p = m.params || {}
      // app-server also emits notifications for subagents. Only the thread we
      // started/resumed owns this run, including final answers, goals and tokens.
      // In particular a child's turn/completed must never stop the root process.
      const eventThread = p.threadId || p.thread?.id
      if (threadId && eventThread && eventThread !== threadId) sawChildThread = true
      if (cleaning || !threadId || p.threadId !== threadId) return
      const eventTurnId = p.turnId || p.turn?.id
      if (eventTurnId && ctx.isPreviousTurn?.(eventTurnId)) return
      if (m.method === 'turn/started' && eventTurnId) startedTurnIds.add(eventTurnId)
      const item = p.item
      if (m.method === 'item/tool/requestUserInput' && m.id !== undefined && Array.isArray(p.questions)) {
        const key = `${threadId}:${p.turnId}:${p.itemId}`
        if (userInput && userInput.key !== key) { ctx.setErrorText('Codex issued overlapping input requests'); stop(true); return }
        userInput = { id: m.id, key }
        ctx.pump.push({ type: 'user_input', data: { key, questions: p.questions.map(q => ({
          id: q.id, header: q.header || '', question: q.question, options: q.options || [],
          isOther: q.isOther !== false, isSecret: q.isSecret === true,
        })) } })
        void ctx.pump.finish()
      } else if (m.method === 'item/started' && item?.type === 'commandExecution' && item.command) {
        ctx.pump.push({ type: 'tool_event', data: { id: item.id, kind: 'command', label: item.command, status: 'running' } })
      } else if (m.method === 'item/completed' && item) {
        if (item.type === 'agentMessage' && item.text) {
          if (item.phase === 'final_answer') {
            // Multi-turn continuation: each turn's final_answer accumulates (the stream and the final
            // message stay consistent); intermediate narration goes commentary → reasoning timeline.
            answerText = answerText ? `${answerText}\n\n${item.text}` : item.text
            ctx.setFullText(answerText)
            ctx.pump.push({ type: 'content_delta', data: { text: (answerText === item.text ? '' : '\n\n') + item.text } })
          } else {
            if (!item.phase) lastUnphasedMessage = item.text
            narrate(item.text)
          }
        } else if (item.type === 'commandExecution' && item.command) {
          const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 2000) : ''
          ctx.reasoningParts.push({ kind: 'command', label: item.command, status: 'done', output })
          ctx.pump.push({ type: 'tool_event', data: { id: item.id, kind: 'command', label: item.command, status: 'done', output } })
        } else if (item.type === 'mcpToolCall') {
          const label = item.tool || item.name || item.title || t('MCP tool call')
          ctx.pump.push({ type: 'tool_event', data: { id: item.id, kind: 'tool', label, status: 'done' } })
        }
      } else if (m.method === 'thread/goal/updated') {
        const next = p.goal?.status || ''
        if (next && next !== goalStatus) {
          goalStatus = next
          if (GOAL_STATUS_TEXT[next]) { ctx.setErrorText(GOAL_STATUS_TEXT[next]); onGoalFailure() }
        }
      } else if (m.method === 'thread/goal/cleared') {
        // A cleared goal means no goal now: this turn runs to its end as usual. When resuming an old
        // thread for a new turn codex clears the previous goal first (killed twice by mistake on a Mac
        // mini, 2026-09-27), and our own goal/clear arrives here too.
        goalStatus = ''
      } else if (m.method === 'turn/failed') {
        ctx.setErrorText(t('The goal failed: {detail}', { detail: JSON.stringify(p.turn?.error || p).slice(0, 300) }))
        onGoalFailure()
      } else if (m.method === 'turn/completed') {
        const turn = p.turn || {}
        ctx.rememberTurn?.(turn.id)
        if (turn.status === 'failed' && turn.error?.message) ctx.setErrorText(turn.error.message)
        // The goal is still running: codex starts the next turn itself; failure endings are handled by onGoalFailure
        if (goalStatus === 'active' || failureTimer) return
        // Without a final_answer phase, the turn's last reply is the answer
        if (!answerText && lastUnphasedMessage) {
          answerText = lastUnphasedMessage
          ctx.setFullText(answerText)
          ctx.pump.push({ type: 'content_delta', data: { text: answerText } })
        }
        if (turn.status === 'completed') {
          ctx.markDone()
          if (ctx.cleanupBackground && sawChildThread) {
            // Child agents own their own exec managers. Retire the owned process
            // rather than allowing their work to outlive this run's final reply.
            console.log('[daemon] codex app-server retired after native subthread activity')
            stop(true)
            return
          }
          if (ctx.cleanupBackground) {
            cleaning = true
            // These RPCs target only this thread's managed exec sessions; keep
            // its model connection alive. Unsupported/slow cleanup retires the
            // whole process instead, preserving the already completed answer.
            cleanupTimer = setTimeout(() => stop(true), 5_000)
            rpc('thread/backgroundTerminals/list', { threadId })
            return
          }
        }
        stop()
      } else if (m.method === 'thread/tokenUsage/updated') {
        // total is cumulative for the whole thread (a resumed thread includes earlier turns); report this run's delta
        const { total, last, modelContextWindow } = p.tokenUsage || {}
        // Resume replays the previous turn's last usage before any new inference.
        // Its cumulative total is the baseline, not another billable response.
        if (eventTurnId && !startedTurnIds.has(eventTurnId)) {
          if (!tokenBase && total) tokenBase = { input: total.inputTokens, output: total.outputTokens }
          return
        }
        if (last?.totalTokens) ctx.contextUsage.tokens = last.totalTokens
        if (modelContextWindow) ctx.contextUsage.window = modelContextWindow
        if (total) {
          if (!tokenBase) tokenBase = { input: total.inputTokens - (last?.inputTokens || 0), output: total.outputTokens - (last?.outputTokens || 0) }
          ctx.tokens.input = total.inputTokens - tokenBase.input
          ctx.tokens.output = total.outputTokens - tokenBase.output
        }
      }
    }
    handler.flush = () => { finished = true; clearProtocolTimers(); clearTimeout(failureTimer); clearTimeout(cleanupTimer) }
    if (ctx.reusedThreadId) {
      threadId = ctx.reusedThreadId
      ctx.setSession(threadId)
      prepareTurn()
    } else rpc('initialize', { clientInfo: { name: 'opentandem-runner', title: 'OpenTandem Runner', version: runnerVersion() }, capabilities: { experimentalApi: true } })
    return handler
  }

  /** A separate codex app-server asks for a title once on an ephemeral thread, unrelated to the
   *  task's own session: no resume, nothing on disk, read-only sandbox; the task's model with
   *  reasoning effort lowered to low. */
  function codexTitle(run, text) {
    return new Promise(resolve => {
      const argv = ['app-server', ...CODEX_APP_SERVER_BASE_FLAGS, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"']
      if (run.model) argv.push('-c', `model=${JSON.stringify(run.model)}`)
      let child
      try {
        child = spawn(CODEX_BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: run.workdir || undefined, env: process.env, detached: process.platform !== 'win32' })
      } catch { resolve(''); return }
      let settled = false
      let answer = ''
      const finish = (title) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killCompactChild(child)
        resolve(cleanTitle(title))
      }
      const timer = setTimeout(() => finish(''), ctx.titleTimeoutMs)
      const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch { /* died */ } }
      const prompt = titlePrompt(text)
      let buf = ''
      child.stderr.on('data', () => {})
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          let m; try { m = JSON.parse(line) } catch { continue }
          if (m.id === 1) {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} })
            send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' } })
          } else if (m.id === 2) {
            const threadId = m.result?.thread?.id
            if (!threadId) { finish(''); continue }
            send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt }] } })
          } else if (m.id === 3 && m.error) {
            finish('')
          } else if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage' && m.params.item.text) {
            answer = m.params.item.text
          } else if (m.method === 'turn/completed' || m.method === 'turn/failed') {
            finish(m.method === 'turn/completed' ? answer : '')
          }
        }
      })
      child.on('error', () => finish(''))
      child.on('exit', () => finish(''))
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'opentandem-runner', title: 'OpenTandem Runner', version: runnerVersion() } } })
    })
  }

  async function compactCodex(sessionId, workdir) {
    return await new Promise(resolve => {
      const child = spawn(CODEX_BIN, ['app-server', ...CODEX_APP_SERVER_BASE_FLAGS], {
        stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir || undefined, env: process.env,
        detached: process.platform !== 'win32',
      })
      let settled = false
      let stderrTail = ''
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killCompactChild(child)
        resolve(payload)
      }
      const timer = setTimeout(
        () => finish({ error: t('Codex did not finish compaction within {seconds}s', { seconds: COMPACT_TIMEOUT_MS / 1000 }) }),
        COMPACT_TIMEOUT_MS
      ).unref?.() ?? setTimeout(() => {}, 0)
      const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch { /* died */ } }
      let buf = ''
      child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-500) })
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          let m; try { m = JSON.parse(line) } catch { continue }
          if (m.id === 1) {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} })
            // resume must come before compact: compact/start only accepts a loaded thread and answers
            // "thread not found" otherwise. excludeTurns avoids hydrating the whole history.
            setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'thread/resume', params: { threadId: sessionId, excludeTurns: true } }), 200)
          } else if (m.id === 2) {
            // "already has an active writer" = another process holds this thread (the Codex desktop
            // app does too). Report it as is, not as "compaction failed".
            if (m.error) finish({ error: t('Codex could not load the session: {detail}', { detail: m.error.message || JSON.stringify(m.error) }) })
            else send({ jsonrpc: '2.0', id: 3, method: 'thread/compact/start', params: { threadId: sessionId } })
          } else if (m.id === 3 && m.error) {
            finish({ error: t('Codex refused to compact: {detail}', { detail: m.error.message || JSON.stringify(m.error) }) })
          } else if (m.method === 'item/completed' && m.params?.item?.type === 'contextCompaction') {
            finish({ ok: true, detail: t('Codex finished one native context compaction') })
          } else if (m.method === 'turn/failed') {
            finish({ error: t('Codex compaction failed: {detail}', { detail: JSON.stringify(m.params?.turn?.error || m.params).slice(0, 300) }) })
          }
        }
      })
      child.on('error', e => finish({ error: t('Could not start codex app-server: {detail}', { detail: e.message }) }))
      child.on('exit', code => finish({ error: t('codex app-server exited unexpectedly (code={code}){tail}', { code, tail: stderrTail ? t(': {detail}', { detail: stderrTail.trim().slice(-200) }) : '' }) }))
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'opentandem-runner', title: 'OpenTandem Runner', version: runnerVersion() } } })
    })
  }

  return {
    id: 'codex',
    label: 'Codex',
    executes: true,
    bin: () => CODEX_BIN,
    detect: collectCodex,
    install: {
      native: (real, home) => real.startsWith(`${home}/.local/share/codex/`) || real.startsWith(`${home}/.codex/bin/`),
      oneClick: npmInstall('codex', '@openai/codex'),
      npmPackage: () => '@openai/codex',
      brewUpdate: ({ brewFile }) => ({ kind: 'brew', file: brewFile, formula: 'codex', cask: true }),
    },
    nativeInstructions: true,
    quota: () => collectCodexQuota(),
    artifactContextPath: run => codexArtifactContextPath(run),
    catalog: options => codexCatalogRaw(options),
    parseCatalog: parseCodexCatalog,
    rescanCatalog: async () => {
      const raw = await codexCatalogRaw({ force: true })
      const n = raw ? ((JSON.parse(raw).models || []).length) : 0
      return n ? { ok: true, count: n } : { ok: false, error: t('codex debug models produced no output') }
    },
    session: files.session,
    ownFiles: createCodexFiles,
    command: run => codexAppServerArgs(run),
    import: files.import,
    acquireChild: (run, bin, argv, options) => acquireCodexChild(run, bin, argv, options),
    handler: codexAppServerHandler,
    completion: 'handler',
    submitMethod: 'turn/start',
    cleanupBackground: true,
    emptyAnswerError: 'Codex completed the turn without a final answer',
    ownTitle: (run, text) => codexTitle(run, text),
    compact: async (id, workdir) => { await closeCodexSessions(id); return await compactCodex(id, workdir) },
    // Close the pooled app-servers before the Runner replaces itself.
    shutdown: () => closeCodexSessions(),
    userChoices: { tool: 'request_user_input', fields: 'label and description', ruleExtra: ' Use only request_user_input for this and never request_user_input_async, because the async variant returns immediately without waiting and the answer would not reach you.' },
  }
}
