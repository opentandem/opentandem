// Hermes Agent (`hermes`): one-shot `chat -Q` runs; sessions live in
// HERMES_HOME/state.db and the model comes from HERMES_HOME/config.yaml.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createHermesFiles(io) {
  const { fs, os, path, SqliteDatabaseSync } = io
  const hermesHome = () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')

  /** Hermes keeps every session in HERMES_HOME/state.db (SQLite, table
   *  sessions, id = session id). An unreadable database means "missing", so
   *  the turn rebuilds full context instead of resuming into an empty session. */
  function hermesSessionPath(sessionId) {
    if (!sessionId || !SqliteDatabaseSync) return ''
    const dbPath = path.join(hermesHome(), 'state.db')
    if (!fs.existsSync(dbPath)) return ''
    let db
    try {
      db = new SqliteDatabaseSync(dbPath, { readOnly: true })
      return db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) ? dbPath : ''
    } catch {
      return ''
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
  }

  function hermesSessionExists(sessionId) {
    return !!hermesSessionPath(sessionId)
  }

  return {
    session: { path: id => hermesSessionPath(id), exists: id => hermesSessionExists(id) },
  }
}

export function createHermesAdapter(ctx) {
  const { cliProbe, execFile, SqliteDatabaseSync, t } = ctx
  const files = createHermesFiles({ fs, os, path, SqliteDatabaseSync })
  const IS_WIN = process.platform === 'win32'
  // The official installer puts hermes in ~/.local/bin, which is not always on
  // PATH when the Runner is started by launchd or another service manager.
  const HERMES_BIN = ctx.config('HERMES_BIN') || (!IS_WIN && fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'hermes')) ? path.join(os.homedir(), '.local', 'bin', 'hermes') : 'hermes')

  /** All Hermes data lives in HERMES_HOME (default ~/.hermes): config.yaml is
   *  the configuration and state.db the session database. */
  function hermesHome() {
    return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
  }

  /** The `model:` block of config.yaml decides which model Hermes uses
   *  (default + provider). Only these two fields are read, never the keys in
   *  the same file; anything unreadable yields empty values. */
  function hermesConfiguredModel() {
    try {
      const yml = fs.readFileSync(path.join(hermesHome(), 'config.yaml'), 'utf8')
      const block = yml.match(/^model:[ \t]*\n((?:[ \t]+.*\n?|[ \t]*\n)*)/m)?.[1] || ''
      const pick = (key) => block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'#\\n]+?)["']?[ \\t]*(?:#.*)?$`, 'm'))?.[1]?.trim() || ''
      const model = pick('default') || yml.match(/^model:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*$/m)?.[1]?.trim() || ''
      return { model, provider: pick('provider') }
    } catch { return { model: '', provider: '' } }
  }

  async function collectHermes() {
    // Python starts in ~0.9 s, and with a dozen probes running at Runner start
    // ~4 s; the default 8 s budget is too thin and a timeout reads as "not installed".
    const version = await cliProbe(HERMES_BIN, ['--version'], 20_000)
    if (!version.ok) return { installed: false, login: false, version: null }
    const first = version.stdout.trim().split('\n')[0] || ''
    return { installed: true, login: true, version: first.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1] || first || null }
  }

  /** The Hermes model is the single `model.default` from config.yaml, so the
   *  catalog follows that file (users switch models with `hermes model`). Runs
   *  pass neither -m nor --provider; the slug only tells menu entries apart. */
  async function hermesGroup() {
    const status = await collectHermes().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    const { model, provider } = hermesConfiguredModel()
    const name = model || 'default'
    return {
      runtime: 'hermes',
      models: [{
        slug: `hermes/${name}`,
        display_name: name,
        description: provider
          ? t('Default model configured in Hermes config.yaml ({provider})', { provider })
          : t('Default model configured in Hermes config.yaml'),
        reasoning_levels: [],
      }],
      default_model: `hermes/${name}`,
      default_effort: null,
    }
  }

  /** Headless one-shot call: `chat -Q` prints only the final reply on stdout
   *  and the session id on stderr as `session_id: <id>` (v0.17.0; resuming adds
   *  a `↻ Resumed session` line). `--source tool` is the marker Hermes reserves
   *  for integrations, so these sessions stay out of the user's own list.
   *  `--yolo` is the only approval switch (there is no read-only mode; the
   *  server maps permissions to full). Model and provider follow
   *  ~/.hermes/config.yaml. The prompt is passed as `--query=` so text starting
   *  with `-` is not parsed as an option; images have no reliable channel, so
   *  their paths go into the prompt for Hermes' own tools to read. */
  function hermesArgs(run, localImages, instruction) {
    const prompt = localImages.length
      ? `${instruction}\n\n[Image files attached to this message]\n${localImages.join('\n')}`
      : instruction
    const argv = ['chat', `--query=${prompt}`, '-Q', '--source', 'tool', '--yolo']
    if (run.resume_thread_id) argv.push('--resume', run.resume_thread_id)
    return { argv, stdinText: '', cwd: run.workdir || undefined }
  }

  /** stdout is the final reply as plain text; stderr carries `session_id: <id>`
   *  (the same id when resuming). */
  function hermesHandler(ctx) {
    let answer = ''
    let errTail = ''
    return {
      raw(text) {
        answer += text
        ctx.pump.push({ type: 'content_delta', data: { text } })
      },
      stderr(text) {
        errTail = (errTail + text).slice(-4096)
        const id = errTail.match(/^session_id:[ \t]*([\w.-]+)[ \t]*$/m)?.[1]
        if (id) ctx.setSession(id)
      },
      line() { /* stdout is plain final text, not JSONL */ },
      flush() {
        const finalText = answer.trim()
        if (finalText) ctx.setFullText(finalText)
      },
    }
  }

  return {
    id: 'hermes',
    label: 'Hermes Agent',
    executes: true,
    bin: () => HERMES_BIN,
    detect: collectHermes,
    models: () => hermesGroup(),
    session: files.session,
    ownFiles: createHermesFiles,
    command: hermesArgs,
    handler: hermesHandler,
    stream: { raw: true, stderr: 'stderr' },
    // Sessions live in state.db, not in files: delete through Hermes itself (a
    // second call reporting "not found" is normal). Python takes a second or
    // two to start, so it runs in the background without blocking heartbeats.
    purgeSide: ({ sid }) => {
      if (sid) execFile(HERMES_BIN, ['sessions', 'delete', sid, '--yes'], { timeout: 30_000 }, () => {})
    },
  }
}
