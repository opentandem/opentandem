// Helpers shared by several agent adapters. Nothing here depends on Runner
// state; anything that does comes in through the adapter context instead.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Build a temporary directory view that symlinks the real configuration and
 * replaces only explicitly named files. This keeps login/session state while
 * ensuring OpenTandem's MCP entry exists only for this child process. */
export function configOverlay(realDir, prefix, files, persist) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.chmodSync(root, 0o700)
  const names = Object.keys(files).map(name => name.split(path.sep))
  const walk = (source, target, parts = []) => {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    let entries = []
    try { entries = fs.readdirSync(source, { withFileTypes: true }) } catch {}
    for (const entry of entries) {
      const next = [...parts, entry.name]
      const rel = next.join(path.sep)
      if (Object.hasOwn(files, rel)) continue
      const needsDescent = names.some(bits => bits.length > next.length && bits.slice(0, next.length).every((bit, i) => bit === next[i]))
      const from = path.join(source, entry.name)
      const to = path.join(target, entry.name)
      if (needsDescent && entry.isDirectory()) walk(from, to, next)
      else {
        try { fs.symlinkSync(from, to, entry.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file') } catch {}
      }
    }
  }
  walk(realDir, root)
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, content, { mode: 0o600 })
  }
  return {
    home: root,
    // The Runner passes `persist` (ctx.persistOverlay): moving new state back can copy whole
    // session trees, so it runs on the Runner's scan thread. That lane is FIFO, so a session
    // lookup queued after cleanup sees the moved files.
    cleanup: persist
      ? () => { void persist(root, realDir, Object.keys(files)) }
      : () => { persistOverlayState(root, realDir, files); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

/** The overlay only links entries that ALREADY exist in the real directory. On
 *  a fresh machine the CLI's first run creates sessions/, session indexes and
 *  the like inside the overlay; unless they are moved back to the real
 *  directory before cleanup they vanish with it, and the next turn can never
 *  resume (seen on a new Windows machine on 2026-09-28: Kimi rebuilt context
 *  every turn). Symlinks/junctions (which already write through) and the files
 *  replaced for this run are not moved. */
export function persistOverlayState(root, realDir, files) {
  const walk = (overlay, real, parts) => {
    let entries = []
    try { entries = fs.readdirSync(overlay, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const next = [...parts, entry.name]
      if (Object.hasOwn(files, next.join(path.sep))) continue
      const from = path.join(overlay, entry.name)
      const to = path.join(real, entry.name)
      let stat
      try { stat = fs.lstatSync(from) } catch { continue }
      if (stat.isSymbolicLink()) continue
      if (fs.existsSync(to)) {
        if (stat.isDirectory()) walk(from, to, next)
        continue
      }
      try {
        fs.mkdirSync(real, { recursive: true })
        fs.renameSync(from, to)
      } catch {
        try { fs.cpSync(from, to, { recursive: true }) } catch { /* if it cannot be moved back, leave it; never fail the run over it */ }
      }
    }
  }
  walk(root, realDir, [])
}

/** The user's MCP JSON file with one extra `opentandem` server entry. */
export function mergedMcpJson(file, serverSpec) {
  let current = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch {}
  return JSON.stringify({
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      opentandem: serverSpec,
    },
  })
}


// A CLI stream can contain child-session events. Bind once (or to the resumed
// session) and never let another session replace the run's reply or identity.
// Events without a session field keep the CLI's existing process-exit boundary;
// absence is not evidence that a child session or the main run has completed.
export function mainSessionEventGuard(ctx) {
  let sessionId = ctx.resumeThreadId || ''
  return (eventSessionId) => {
    if (typeof eventSessionId !== 'string' || !eventSessionId) return true
    if (!sessionId) sessionId = eventSessionId
    return eventSessionId === sessionId
  }
}

// One-click installs go to ~/.local/share/opentandem/runtimes/<id>. npm
// packages use the Runner's own npm there and never touch the user's global
// npm; script installs run the vendor's official install script.
/** Where one-click installs live: one directory per agent, never the user's global npm. */
export const AGENT_RUNTIMES_DIR = path.join(os.homedir(), '.local', 'share', 'opentandem', 'runtimes')
export function npmInstall(id, pkg, extra = []) {
  const dir = path.join(AGENT_RUNTIMES_DIR, id)
  return { kind: 'npm', dir, pkg, extra, pathDirs: [path.join(dir, 'node_modules', '.bin')] }
}
export function scriptInstall(url, pathDirs) {
  return { kind: 'script', url, pathDirs }
}

/** Terminal output without colour codes, OSC sequences and control characters. */
export function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

/** One shared timeout for native compaction, which waits for the model to
 *  write a summary. It is a little shorter than the server's, so the timeout
 *  happens here and the user sees "the agent did not finish compacting within
 *  N seconds" instead of a vague "the machine did not answer". */
export const COMPACT_TIMEOUT_MS = 150_000

export function compactDeadline(ms = COMPACT_TIMEOUT_MS) {
  const until = Date.now() + ms
  return () => until - Date.now()
}

/** A provider error (possibly JSON nested in JSON) as `code status: message`. */
export function providerErrorText(raw) {
  let current = raw
  let code = ''
  let status = ''
  let message = typeof raw === 'string' ? raw : String(raw || '')
  for (let depth = 0; depth < 3; depth++) {
    let parsed = current
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { break }
    }
    if (!parsed || typeof parsed !== 'object') break
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed
    if (error.code != null) code = String(error.code)
    if (error.status) status = String(error.status)
    if (typeof error.message !== 'string') break
    message = error.message.trim()
    current = message
  }
  return `${[code, status].filter(Boolean).join(' ')}${code || status ? ': ' : ''}${message}`.trim()
}

/** Handler for CLIs whose stdout is the plain final answer, not JSONL (stream.raw). */
export function plainTextHandler(ctx) {
  let answer = ''
  return {
    raw(text) {
      answer += text
      ctx.pump.push({ type: 'content_delta', data: { text } })
    },
    line() { /* stdout is plain final text, not JSONL */ },
    flush() {
      const finalText = answer.trim()
      if (finalText) ctx.setFullText(finalText)
    },
  }
}

/** CLI output safe to show: colour codes stripped, API keys and bearer tokens redacted, capped. */
export function sanitizeRuntimeDetail(raw) {
  return String(raw || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/AIza[\w-]{20,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[\w.+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, 4000)
}

/** Quota entry for a runtime whose usage could not be read. */
export function quotaFailure(runtime, reason) {
  return { runtime, ok: false, reason, windows: [], fetched_at: new Date().toISOString() }
}

/** GET a usage endpoint as JSON (8s timeout; non-2xx throws). */
export async function usageJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Stop waiting past the deadline: log one line, hand back the fallback if there is one, otherwise
// throw, so the surrounding loop carries on. The stuck wait is simply abandoned (accepted: whatever
// connection or memory it holds is not reclaimed). On 2026-10-20 two Runners each had a wait that
// never returned, and their full heartbeats never reported quota again. This only covers a wait that
// never returns; a synchronous call that freezes the whole process (e.g. readdirSync hitting an OS
// permission prompt) has to run in a child process instead.
/** Settle with `fallback` (or reject when none) if `promise` takes longer than `ms`. */
export function withDeadline(promise, ms, label, fallback) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        console.error(`[daemon] ${label} stalled after ${Math.round(ms / 1000)}s; moving on`)
        if (fallback === undefined) reject(new Error(`${label} timed out`))
        else resolve(typeof fallback === 'function' ? fallback() : fallback)
      }, ms)
    }),
  ])
}
