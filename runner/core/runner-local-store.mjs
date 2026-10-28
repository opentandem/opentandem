// Runner local conversation database: the user's conversation records are "local first"; the Runner
// keeps a copy in SQLite on the user's computer,
// and the cloud MySQL is only a cache. This module is responsible only for this local database and is called by machine-daemon.
//
// Bundling constraints: this file is bundled into the single-file Runner (runner/build/bundle.mjs):
// imports go only at the top of the file and may only reference relative-path modules or node:
// built-ins; exports use only export function / export const. Each module has its own scope, so
// top-level names no longer collide with machine-daemon.
// Built-in modules are obtained with process.getBuiltinModule; if it is unavailable (a Node that is
// too old), the local database is skipped entirely.

import runnerZh from './locales/runner.zh.json' with { type: 'json' }
import runnerEn from './locales/runner.en.json' with { type: 'json' }

const readmeZh = runnerZh.LocalStore
const readmeEn = runnerEn.LocalStore

/** Get a Node built-in module; returns null if unavailable (a Node that is too old). */
function localBuiltin(name) {
  try {
    const g = globalThis.process
    return g && typeof g.getBuiltinModule === 'function' ? g.getBuiltinModule(name) || null : null
  } catch {
    return null
  }
}

/**
 * Default node:sqlite loader. Synchronous: uses getBuiltinModule rather than a dynamic import,
 * so it neither depends on async nor fails because vitest/vite resolves node:sqlite as an ordinary package.
 * node:sqlite needs no flag from Node 22.13 on; older Node cannot get it -> throws -> the upper layer degrades to null.
 */
function localDefaultSqliteLoader() {
  const mod = localBuiltin('node:sqlite')
  if (!mod || !mod.DatabaseSync) throw new Error('node:sqlite is not available in this Node version')
  return mod
}

// ───────────────────────── Paths ─────────────────────────

/**
 * Root directory of local data (pure function, three platforms). Note: it must be a sibling, not a
 * parent or child, of the Runner install directory
 * (`.../OpenTandem Runner`, `.../opentandem-runner`) --
 * uninstalling the Runner only deletes the install directory, and the conversation database must stay.
 */
export function localDataRoot(opts = {}) {
  const proc = globalThis.process || {}
  const platform = opts.platform || proc.platform
  const env = opts.env || proc.env || {}
  const pathMod = localBuiltin('node:path')
  const flavor = platform === 'win32' ? pathMod.win32 : pathMod.posix
  // Override for tests and advanced users: used as is, with no subdirectory appended.
  if (env.OPENTANDEM_DATA_DIR) return env.OPENTANDEM_DATA_DIR
  const home = opts.homedir || localBuiltin('node:os').homedir()
  if (platform === 'darwin') return flavor.join(home, 'Library', 'Application Support', 'OpenTandem')
  if (platform === 'win32') {
    return flavor.join(env.LOCALAPPDATA || flavor.join(home, 'AppData', 'Local'), 'OpenTandem')
  }
  return flavor.join(env.XDG_DATA_HOME || flavor.join(home, '.local', 'share'), 'opentandem')
}

/**
 * One separate subdirectory per server: when the staging-environment Runner and the Hong Kong Runner
 * are installed on the same computer, they do not compete for the same database.
 * server is an origin string (https://opentandem.example.com); the directory name keeps only [A-Za-z0-9._-].
 */
export function localDataDirFor(server, opts = {}) {
  let host = String(server == null ? '' : server).trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try { host = new URL(host).host } catch { /* If it cannot be parsed, sanitize the original string */ }
  } else {
    host = host.split(/[/?#]/)[0]
  }
  let name = host.replace(/:/g, '_').replace(/[^A-Za-z0-9._-]/g, '_')
  // An empty string or pure dots ('.' '..') would make the path point to the root or the parent, so they
  // are replaced with a placeholder name.
  if (!name || /^\.+$/.test(name)) name = '_'
  const platform = opts.platform || (globalThis.process || {}).platform
  const pathMod = localBuiltin('node:path')
  return (platform === 'win32' ? pathMod.win32 : pathMod.posix).join(localDataRoot(opts), name)
}

// ───────────────────────── Migrations ─────────────────────────

// Migration rules (local database upgrades rely only on this set of rules; do not invent another):
//   - The version number is stored in `PRAGMA user_version`; LOCAL_MIGRATIONS is an ordered array, and
//     item N upgrades version N to N+1.
//   - Each migration runs in one transaction and sets user_version in the same transaction; if any
//     step fails, everything rolls back.
//   - Only adding tables, adding columns with a default value, and adding indexes is allowed; dropping
//     columns, renaming and changing types are forbidden.
//     A column to be retired only stops being written and is not dropped -- an older Runner may still
//       be reading it.
//   - When the database's user_version is higher than the version this code knows (the user rolled the
//     Runner back), open it for normal read and write,
//     do not refuse and do not downgrade; tables and columns added by the newer version are
//       transparent to the older code, which is exactly why the previous restriction exists.
//   - When a migration needs to run (0 < old version < LOCAL_SCHEMA_VERSION), first
//     wal_checkpoint(TRUNCATE),
//     then copy the database file to opentandem.db.bak-v<old version>, keeping only the most recent
//       one (overwriting the older backup);
//     a brand-new database (version 0) has nothing to back up, so no backup is made.
//   - Migration failure -> roll back, openLocalStore returns null and logs, and the caller decides
//     whether to degrade to cloud-only.
//
// The table structure matches the cloud db/schema.sql but without the tenant field, and [never creates any identity field]
// (author_id / author_name / created_by / email / user id): the local database can be read by the execution tool,
// and once the sender's identity lands in it, the model can see it, which violates the iron rule
// "never leak user identity to the LLM".
// Time columns always store the UTC string passed in by the caller (YYYY-MM-DD HH:MM:SS); this module
// never reads the system clock.
const LOCAL_MIGRATIONS = [
  // v0 -> v1: initial table structure
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workdir TEXT,
    runtime TEXT,
    model TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_events TEXT,
    trigger_source TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_channel_seq ON messages (channel_id, seq);
  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    runtime TEXT,
    runtime_session_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX idx_task_runs_task ON task_runs (task_id);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    local_path TEXT NOT NULL,
    oss_object_key TEXT NOT NULL,
    size INTEGER,
    content_type TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, local_path)
  );`,
  `ALTER TABLE messages ADD COLUMN source_task_id TEXT;
   ALTER TABLE messages ADD COLUMN source_runtime TEXT;`,
]

export const LOCAL_SCHEMA_VERSION = LOCAL_MIGRATIONS.length

const LOCAL_DB_FILE = 'opentandem.db'

const LOCAL_README = `OpenTandem - ${readmeZh.readmeTitle} / ${readmeEn.readmeTitle}
${'='.repeat(58)}

${readmeZh.readmeHeading}
${readmeZh.readmeBody}

${readmeEn.readmeHeading}
${readmeEn.readmeBody}
`

// ───────────────────────── Opening ─────────────────────────

function localSafeChmod(fs, p, mode) {
  try { fs.chmodSync(p, mode) } catch { /* Windows or an unsupported file system: ignore */ }
}

/** Delete the old backup and copy a new one: only the most recent .bak-v* is kept. */
function localBackup(fs, path, dir, dbPath, oldVersion) {
  const keep = `${LOCAL_DB_FILE}.bak-v${oldVersion}`
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${LOCAL_DB_FILE}.bak-v`) && name !== keep) {
      try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* If it cannot be deleted, leave it; the migration is not affected */ }
    }
  }
  const dest = path.join(dir, keep)
  fs.copyFileSync(dbPath, dest)
  localSafeChmod(fs, dest, 0o600)
}

/**
 * Identity of the database file (dev:ino); returns null if the file does not exist. When ino is
 * unavailable (for example Windows returns 0), the placeholder 'nofileid' is used,
 * and then we can only tell whether the file exists, not whether it was replaced by a new file --
 * Windows cannot delete an open file anyway.
 */
function localFileId(fs, p) {
  try {
    const st = fs.statSync(p)
    return st.ino ? `${st.dev}:${st.ino}` : 'nofileid'
  } catch {
    return null
  }
}

/**
 * Open (creating and migrating if necessary) the local conversation database.
 * Returns a store; if node:sqlite is unavailable, the directory is not writable, or opening/migration
 * fails, it always returns null,
 * calls log only once, and never throws -- the local database is a copy, and when broken it must not
 * drag the Runner down.
 * opts: server (determines the default directory) / dir (explicit directory, for tests) / log(msg) /
 * migrations (test injection only) / sqliteLoader (test injection only, synchronously returns a module containing DatabaseSync).
 */
export function openLocalStore(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  let logged = false
  const fail = (msg) => {
    if (!logged) {
      logged = true
      try { log(`[local-store] ${msg}`) } catch { /* log itself failing must not throw either */ }
    }
    return null
  }
  let db = null
  try {
    const fs = localBuiltin('node:fs')
    const path = localBuiltin('node:path')
    if (!fs || !path) return fail('node builtins unavailable (Node too old)')
    const migrations = Array.isArray(opts.migrations) ? opts.migrations : LOCAL_MIGRATIONS
    const target = migrations.length

    let sqlite
    try { sqlite = (opts.sqliteLoader || localDefaultSqliteLoader)() } catch (e) {
      return fail(`sqlite unavailable: ${e && e.message ? e.message : e}`)
    }
    if (!sqlite || !sqlite.DatabaseSync) return fail('sqlite unavailable: no DatabaseSync')

    const dir = opts.dir || localDataDirFor(opts.server || '')
    const prepareDir = () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      localSafeChmod(fs, dir, 0o700)
      const readme = path.join(dir, 'README.txt')
      let current = null
      try { current = fs.readFileSync(readme, 'utf8') } catch { /* Not there yet */ }
      if (current !== LOCAL_README) fs.writeFileSync(readme, LOCAL_README)
    }
    try {
      prepareDir()
    } catch (e) {
      return fail(`data dir not writable (${dir}): ${e && e.message ? e.message : e}`)
    }

    const dbPath = path.join(dir, LOCAL_DB_FILE)
    /**
     * Open the database file and bring migrations up to date, returning { db, ino }. On failure it closes
     * the half-open connection itself and then throws.
     */
    const openDb = () => {
      let handle = null
      try {
        handle = new sqlite.DatabaseSync(dbPath)
        // busy_timeout must be set first: the same database may be opened by two Runner processes (or two
        // instances) at the same time,
        // and the WAL switch and migrations that follow will both touch locks.
        handle.exec('PRAGMA busy_timeout = 5000')
        handle.exec('PRAGMA journal_mode = WAL')
        handle.exec('PRAGMA foreign_keys = ON')
        localSafeChmod(fs, dbPath, 0o600)

        const readVersion = () => Number(handle.prepare('PRAGMA user_version').get().user_version)
        const before = readVersion()
        if (before < target) {
          if (before > 0) {
            // Keep a rollback-able copy of the whole database before upgrading. Checkpoint first so the copy
            // contains the latest data in the WAL.
            handle.exec('PRAGMA wal_checkpoint(TRUNCATE)')
            localBackup(fs, path, dir, dbPath, before)
          }
          for (let n = before; n < target; n++) {
            handle.exec('BEGIN IMMEDIATE')
            try {
              // Re-read after getting the write lock: another process may have just finished the migration for us,
              // and it must not be run twice.
              if (readVersion() <= n) {
                const step = migrations[n]
                if (typeof step === 'function') step(handle)
                else handle.exec(step)
                handle.exec(`PRAGMA user_version = ${n + 1}`)
              }
              handle.exec('COMMIT')
            } catch (e) {
              try { handle.exec('ROLLBACK') } catch { /* The transaction may already have been ended automatically by sqlite */ }
              throw new Error(`migration v${n}->v${n + 1} failed: ${e && e.message ? e.message : e}`)
            }
          }
        }
        // before > target: the user rolled the Runner back, and the database is newer than this code. Read and
        // write as usual; see the LOCAL_MIGRATIONS comment.
        return { db: handle, ino: localFileId(fs, dbPath) }
      } catch (e) {
        if (handle) { try { handle.close() } catch { /* Ignore */ } }
        throw e
      }
    }
    const opened = openDb()
    db = opened.db
    return localMakeStore(db, log, dbPath, {
      ino: opened.ino,
      // Whether the database file is still the one we opened: deleted (including the whole directory being
      // cleared) or replaced with a new file by another process both count as not.
      alive: (ino) => {
        const now = localFileId(fs, dbPath)
        return now !== null && (ino === null || now === ino)
      },
      // Rebuild: restore the directory and README, reopen and migrate; on failure it throws, and the caller
      // logs it and tries again next time.
      // When the database file is gone, the same-named -wal/-shm files are leftovers of the old database;
      // WAL does not check which database file it belongs to,
      // and leaving them would have them replayed into the new database as a valid log, so they are removed
      // first. If the database file is still there (replaced with a new one by another process), leave them alone.
      reopen: () => {
        prepareDir()
        if (localFileId(fs, dbPath) === null) {
          for (const ext of ['-wal', '-shm']) {
            try { fs.rmSync(dbPath + ext, { force: true }) } catch { /* If it cannot be deleted, let sqlite report the error itself */ }
          }
        }
        return openDb()
      },
    })
  } catch (e) {
    if (db) { try { db.close() } catch { /* Ignore */ } }
    return fail(`open failed: ${e && e.message ? e.message : e}`)
  }
}

// ───────────────────────── store ─────────────────────────

/** node:sqlite does not accept undefined parameters, so they are all folded to null. */
function localNull(v) { return v === undefined ? null : v }

/**
 * A NUL (\u0000) in the body text is treated by node:sqlite as the end of a C string, silently
 * truncating everything after it (verified).
 * We would rather replace it with a visible U+FFFD than lose the second half of the whole message. All
 * other characters (including emoji and Chinese) round-trip unchanged.
 */
function localText(v) { return typeof v === 'string' ? v.replace(/\u0000/g, '\uFFFD') : v }

function localMakeStore(initialDb, log, dbPath, heal) {
  let db = initialDb
  let ino = heal ? heal.ino : null
  let healLogged = false
  let closed = false
  const warn = (what, e) => {
    try { log(`[local-store] ${what} failed: ${e && e.message ? e.message : e}`) } catch { /* Ignore */ }
  }
  /**
   * All writes go inside a BEGIN IMMEDIATE transaction: the several writes of one run are either all
   * there or all absent,
   * and this also avoids the read-then-upgrade deadlock where two connections writing in an interleaved
   * way trip over each other with SQLITE_BUSY.
   */
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* Ignore */ }
      throw e
    }
  }
  /**
   * If the database file is deleted while running (the user cleans the directory, or deletes it by
   * mistake) or replaced, the old connection keeps writing into a file that is no longer in the directory,
   * the writes "succeed" but never reach disk, and there is no error at all. So check before every
   * access, and rebuild if it is gone.
   * What gets rebuilt is an empty database: the deleted history cannot be recovered, and only new
   * records from then on reach disk.
   */
  const ensureAlive = () => {
    if (!heal || heal.alive(ino)) { healLogged = false; return }
    if (!healLogged) {
      healLogged = true
      try { log(`[local-store] database file was deleted or replaced while running; rebuilding ${dbPath} (earlier local records are lost, new records resume)`) } catch { /* Ignore */ }
    }
    try { db.close() } catch { /* The old connection may no longer be usable */ }
    const next = heal.reopen()
    db = next.db
    ino = next.ino
    healLogged = false
  }
  const guard = (what, fallback, fn) => {
    try {
      if (closed) throw new Error('store is closed')
      ensureAlive()
      return fn()
    } catch (e) {
      warn(what, e)
      return fallback
    }
  }

  return {
    dbPath,

    /**
     * Start of a run: refresh the task snapshot (the title and so on may change every run), and register
     * the channel, this run's user message, and the running run.
     */
    recordRunStart(p) {
      return guard('recordRunStart', false, () => {
        const t = p.task
        tx(() => {
          db.prepare(
            `INSERT INTO tasks (id, title, workdir, runtime, model, archived, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, workdir = excluded.workdir,
               runtime = excluded.runtime, model = excluded.model, archived = excluded.archived,
               updated_at = excluded.updated_at`,
          ).run(t.id, t.title, localNull(t.workdir), localNull(t.runtime), localNull(t.model),
            t.archived ? 1 : 0, t.created_at, t.updated_at)
          db.prepare(
            `INSERT INTO channels (id, task_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          ).run(p.channelId, t.id, t.created_at)
          const ins = db.prepare(
            `INSERT INTO messages (id, channel_id, role, content, tool_events, trigger_source, source_task_id, source_runtime, created_at)
             VALUES (?, ?, 'user', ?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          )
          for (const m of p.userMessages || []) {
            ins.run(m.id, p.channelId, localText(m.content), localNull(m.trigger_source), localNull(m.source_task_id), localNull(m.source_runtime), m.created_at)
          }
          // When replaying start, only a run that is still running may be refreshed; a run that has already
          // finished must not be changed back to running.
          db.prepare(
            `INSERT INTO task_runs (id, task_id, status, runtime, runtime_session_id, started_at)
             VALUES (?, ?, 'running', ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET runtime = excluded.runtime,
               runtime_session_id = COALESCE(excluded.runtime_session_id, task_runs.runtime_session_id)
             WHERE task_runs.status = 'running'`,
          ).run(p.runId, t.id, localNull(p.runtime), localNull(p.sessionId), localNull(p.startedAt))
        })
        return true
      })
    },

    /**
     * End of a run: write the assistant reply (id fixed as reply-<runId>, aligned with the cloud
     * completeRemoteRun so the two sides can be cross-checked),
     * update the run, and register attachments. When there is no reply text (for example on cancel), no
     * assistant message is written.
     */
    recordRunEnd(p) {
      return guard('recordRunEnd', false, () => {
        tx(() => {
          if (typeof p.replyText === 'string' && p.replyText !== '') {
            const tools = p.toolSummary == null ? null : JSON.stringify(p.toolSummary)
            db.prepare(
              `INSERT INTO messages (id, channel_id, role, content, tool_events, trigger_source, created_at)
               VALUES (?, ?, 'assistant', ?, ?, NULL, ?)
               ON CONFLICT(id) DO UPDATE SET content = excluded.content, tool_events = excluded.tool_events`,
            ).run(`reply-${p.runId}`, p.channelId, localText(p.replyText), localText(tools), p.finishedAt)
          }
          // Use upsert rather than UPDATE: if the local write at start failed, end can still create this row.
          db.prepare(
            `INSERT INTO task_runs (id, task_id, status, runtime_session_id, input_tokens, output_tokens, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status,
               runtime_session_id = COALESCE(excluded.runtime_session_id, task_runs.runtime_session_id),
               input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
               finished_at = excluded.finished_at`,
          ).run(p.runId, p.taskId, p.status, localNull(p.sessionId), localNull(p.inputTokens),
            localNull(p.outputTokens), localNull(p.finishedAt))
          const att = db.prepare(
            `INSERT INTO attachments (id, task_id, local_path, oss_object_key, size, content_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id, local_path) DO UPDATE SET oss_object_key = excluded.oss_object_key,
               size = excluded.size, content_type = excluded.content_type`,
          )
          for (const a of p.attachments || []) {
            // The id is derived from (task, path), so registering the same file repeatedly lands on the same row.
            att.run(`${p.taskId}:${a.local_path}`, p.taskId, a.local_path, a.oss_object_key,
              localNull(a.size), localNull(a.content_type), p.finishedAt)
          }
        })
        return true
      })
    },

    /**
     * After the execution tool generates the session title, sync the local snapshot (the title often comes
     * back after a run has ended, by which time the snapshot from recordRunStart is stale).
     * Only updates a task row that already exists locally and does nothing otherwise; like the cloud, it
     * does not accept an empty title.
     */
    setTaskTitle(taskId, title) {
      return guard('setTaskTitle', false, () => {
        const text = localText(String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 512))
        if (!text) return false
        return Number(db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(text, taskId).changes) > 0
      })
    },

    /**
     * Delete a task: messages (via channels), channels, runs, attachments, and the task itself, in one
     * transaction. Returns the number of messages deleted.
     */
    deleteTask(taskId) {
      return guard('deleteTask', 0, () => tx(() => {
        const n = Number(db.prepare(
          'SELECT COUNT(*) AS c FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE task_id = ?)',
        ).get(taskId).c)
        db.prepare('DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE task_id = ?)').run(taskId)
        db.prepare('DELETE FROM channels WHERE task_id = ?').run(taskId)
        db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId)
        db.prepare('DELETE FROM attachments WHERE task_id = ?').run(taskId)
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
        return n
      }))
    },

    /**
     * All conversation of a task (ascending by seq). For tests and for the later "restore from local" feature.
     */
    getTaskTranscript(taskId) {
      return guard('getTaskTranscript', { task: null, messages: [] }, () => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null
        const messages = db.prepare(
          `SELECT id, role, content, tool_events, trigger_source, source_task_id, source_runtime, created_at FROM messages
           WHERE channel_id IN (SELECT id FROM channels WHERE task_id = ?) ORDER BY seq ASC`,
        ).all(taskId).map((m) => ({ ...m }))
        return { task: task ? { ...task } : null, messages }
      })
    },

    stats() {
      return guard('stats', { tasks: 0, messages: 0, schemaVersion: 0 }, () => ({
        tasks: Number(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c),
        messages: Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c),
        schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      }))
    },

    close() {
      if (closed) return
      closed = true
      try { db.close() } catch (e) { warn('close', e) }
    },
  }
}
