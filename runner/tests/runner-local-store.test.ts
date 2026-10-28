// Runner local conversation store (runner/core/runner-local-store.mjs).
// Everything uses temp directories and never touches the real user directory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as ls from '../core/runner-local-store.mjs'

const T0 = '2026-10-10 01:00:00'
const T1 = '2026-10-10 01:00:05'

let tmp: string
let opened: any[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-local-store-'))
  opened = []
})
afterEach(() => {
  for (const s of opened) { try { s.close() } catch { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
})

function open(opts: any = {}): any {
  const logs: string[] = []
  const s = ls.openLocalStore({ dir: path.join(tmp, 'db'), log: (m: string) => logs.push(m), ...opts })
  if (s) opened.push(s)
  return Object.assign(s || {}, { __logs: logs, __null: !s })
}

function task(id = 't1', extra: any = {}) {
  return { id, title: 'hello', workdir: '/w', runtime: 'codex', model: 'm', archived: false, created_at: T0, updated_at: T0, ...extra }
}
function start(s: any, runId = 'r1', extra: any = {}) {
  return s.recordRunStart({
    task: task(extra.taskId || 't1', extra.task), channelId: extra.channelId || 'c1', runId, runtime: 'codex', sessionId: 'sess',
    startedAt: T0, userMessages: extra.userMessages || [{ id: `u-${runId}`, content: 'hi', created_at: T0, trigger_source: null }],
  })
}
function end(s: any, runId = 'r1', extra: any = {}) {
  return s.recordRunEnd({
    runId, taskId: 't1', channelId: 'c1', status: 'done', replyText: 'answer', toolSummary: { calls: 2 },
    inputTokens: 10, outputTokens: 20, sessionId: 'sess', finishedAt: T1, attachments: [], ...extra,
  })
}
const rawDb = (dir: string) => {
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite')
  return new DatabaseSync(path.join(dir, 'opentandem.db'))
}

describe('localDataRoot / localDataDirFor', () => {
  const home = { darwin: '/Users/a', win32: 'C:\\Users\\a', linux: '/home/a' }
  it('darwin', () => {
    expect(ls.localDataRoot({ platform: 'darwin', env: {}, homedir: home.darwin }))
      .toBe('/Users/a/Library/Application Support/OpenTandem')
  })
  it('win32: uses LOCALAPPDATA, falling back to AppData\\Local when missing', () => {
    expect(ls.localDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' }, homedir: home.win32 }))
      .toBe('D:\\Local\\OpenTandem')
    expect(ls.localDataRoot({ platform: 'win32', env: {}, homedir: home.win32 }))
      .toBe('C:\\Users\\a\\AppData\\Local\\OpenTandem')
  })
  it('linux: XDG_DATA_HOME first, defaulting to ~/.local/share', () => {
    expect(ls.localDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/x/data' }, homedir: home.linux }))
      .toBe('/x/data/opentandem')
    expect(ls.localDataRoot({ platform: 'linux', env: {}, homedir: home.linux }))
      .toBe('/home/a/.local/share/opentandem')
    expect(ls.localDataRoot({ platform: 'freebsd', env: {}, homedir: '/h' })).toBe('/h/.local/share/opentandem')
  })
  it('OPENTANDEM_DATA_DIR overrides all three platforms', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(ls.localDataRoot({ platform, env: { OPENTANDEM_DATA_DIR: '/custom' }, homedir: '/h' })).toBe('/custom')
    }
  })
  it('is not equal to and not inside the Runner install directory', () => {
    const cases: [string, string, string][] = [
      ['darwin', '/Users/a', '/Users/a/Library/Application Support/OpenTandem Runner'],
      ['win32', 'C:\\Users\\a', 'C:\\Users\\a\\AppData\\Local\\OpenTandem Runner'],
      ['linux', '/home/a', '/home/a/.local/share/opentandem-runner'],
    ]
    for (const [platform, h, install] of cases) {
      const root = ls.localDataRoot({ platform, env: {}, homedir: h })
      const sep = platform === 'win32' ? '\\' : '/'
      expect(root).not.toBe(install)
      expect(root.startsWith(install + sep)).toBe(false)
      expect(install.startsWith(root + sep)).toBe(false) // nor the other way round as parent and child: uninstalling the install directory does not delete the database with it
    }
  })
  it('different servers get separate directories; ports and illegal characters are sanitized', () => {
    const o = { platform: 'linux', env: { OPENTANDEM_DATA_DIR: '/r' }, homedir: '/h' }
    const a = ls.localDataDirFor('https://runner.example.com', o)
    const b = ls.localDataDirFor('https://opentandem.org', o)
    const c = ls.localDataDirFor('http://127.0.0.1:4567', o)
    expect(a).toBe('/r/runner.example.com')
    expect(b).toBe('/r/opentandem.org')
    expect(c).toBe('/r/127.0.0.1_4567')
    expect(new Set([a, b, c]).size).toBe(3)
    expect(ls.localDataDirFor('https://evil.com/../../x?y=1', o)).toBe('/r/evil.com')
    expect(ls.localDataDirFor('weird host*name', o)).toBe('/r/weird_host_name')
    expect(ls.localDataDirFor('runner.example.com:4567', o)).toBe('/r/runner.example.com_4567')
    for (const bad of ['', '..', '.', '/', '   ']) {
      const d = ls.localDataDirFor(bad, o)
      expect(path.posix.dirname(d)).toBe('/r') // never escapes the root directory
    }
    expect(ls.localDataDirFor('https://a.com', { platform: 'win32', env: { OPENTANDEM_DATA_DIR: 'C:\\r' }, homedir: 'C:\\h' }))
      .toBe('C:\\r\\a.com')
  })
})

describe('openLocalStore creates the database on first use', () => {
  it('tables, user_version, README, permissions', () => {
    const s = open()
    expect(s.__null).toBe(false)
    expect(ls.LOCAL_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    expect(s.stats()).toEqual({ tasks: 0, messages: 0, schemaVersion: ls.LOCAL_SCHEMA_VERSION })
    const dir = path.join(tmp, 'db')
    const db = rawDb(dir)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r: any) => r.name)
    expect(tables).toEqual(['attachments', 'channels', 'messages', 'task_runs', 'tasks'])
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal')
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r: any) => r.name)
    expect(idx).toContain('idx_messages_channel_seq')
    expect(idx).toContain('idx_task_runs_task')
    db.close()
    expect(fs.readdirSync(dir).some((n) => n.includes('.bak-v'))).toBe(false) // a brand-new database is not backed up
    expect(s.__logs).toEqual([])
  })
  it('key sentences in the README, in Chinese and English', () => {
    open()
    const txt = fs.readFileSync(path.join(tmp, 'db', 'README.txt'), 'utf8')
    expect(txt).toContain('不会删除本目录')
    expect(txt).toContain('永久丢失')
    expect(txt).toContain('请勿手动修改 opentandem.db')
    expect(txt).toContain('does NOT delete this folder')
    expect(txt).toContain('permanently loses')
    expect(txt).toContain('Do not edit opentandem.db')
  })
  it('a modified README is restored; opening repeatedly does not error', () => {
    const s1 = open(); s1.close()
    fs.writeFileSync(path.join(tmp, 'db', 'README.txt'), 'tampered')
    open()
    expect(fs.readFileSync(path.join(tmp, 'db', 'README.txt'), 'utf8')).toContain('OpenTandem')
  })
  it.skipIf(process.platform === 'win32')('directory 0700, database file 0600', () => {
    open()
    expect(fs.statSync(path.join(tmp, 'db')).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(tmp, 'db', 'opentandem.db')).mode & 0o777).toBe(0o600)
  })
  it.skipIf(process.platform === 'win32')('an existing directory with loose permissions is tightened to 0700', () => {
    fs.mkdirSync(path.join(tmp, 'db'), { mode: 0o755 })
    open()
    expect(fs.statSync(path.join(tmp, 'db')).mode & 0o777).toBe(0o700)
  })
  it('the tables have no identity fields at all', () => {
    open()
    const db = rawDb(path.join(tmp, 'db'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r: any) => r.name)
    expect(tables.length).toBe(5)
    for (const t of tables) {
      for (const col of db.prepare(`PRAGMA table_info(${t})`).all() as any[]) {
        expect(col.name, `${t}.${col.name}`).not.toMatch(/author|created_by|email|user|owner|sender|tenant/i)
      }
    }
    db.close()
  })
})

describe('degradation: never throws, logs only once', () => {
  it('node:sqlite unavailable', () => {
    const logs: string[] = []
    const s = ls.openLocalStore({ dir: path.join(tmp, 'db'), log: (m: string) => logs.push(m), sqliteLoader: () => { throw new Error('boom') } })
    expect(s).toBeNull()
    expect(logs.length).toBe(1)
    expect(ls.openLocalStore({ dir: path.join(tmp, 'db'), sqliteLoader: () => ({}) })).toBeNull() // no DatabaseSync
  })
  it('directory not writable (parent path is a file)', () => {
    const f = path.join(tmp, 'afile')
    fs.writeFileSync(f, 'x')
    const logs: string[] = []
    const s = ls.openLocalStore({ dir: path.join(f, 'sub'), log: (m: string) => logs.push(m) })
    expect(s).toBeNull()
    expect(logs.length).toBe(1)
  })
  it('corrupted database file -> null', () => {
    fs.mkdirSync(path.join(tmp, 'db'))
    fs.writeFileSync(path.join(tmp, 'db', 'opentandem.db'), Buffer.from('this is definitely not sqlite '.repeat(200)))
    const logs: string[] = []
    expect(ls.openLocalStore({ dir: path.join(tmp, 'db'), log: (m: string) => logs.push(m) })).toBeNull()
    expect(logs.length).toBe(1)
  })
  it('an exception thrown by log itself does not leak out; works without passing log too', () => {
    expect(ls.openLocalStore({ dir: path.join(tmp, 'a', '\0bad'), log: () => { throw new Error('x') } })).toBeNull()
    expect(ls.openLocalStore({ dir: path.join(tmp, 'b'), sqliteLoader: () => { throw new Error('x') } })).toBeNull()
  })
  it('methods do not throw after close', () => {
    const s = open()
    s.close(); s.close()
    expect(start(s)).toBe(false)
    expect(s.deleteTask('t1')).toBe(0)
    expect(s.getTaskTranscript('t1')).toEqual({ task: null, messages: [] })
    expect(s.stats().schemaVersion).toBe(0)
    expect(s.__logs.length).toBeGreaterThan(0)
  })
  it('bad arguments do not throw (missing task)', () => {
    const s = open()
    expect(s.recordRunStart({ channelId: 'c', runId: 'r' })).toBe(false)
    expect(s.recordRunEnd({})).toBe(false)
    expect(s.stats().tasks).toBe(0)
  })
})

describe('recording and idempotency', () => {
  it('start + end round trip', () => {
    const s = open()
    expect(start(s)).toBe(true)
    expect(end(s)).toBe(true)
    const tr = s.getTaskTranscript('t1')
    expect(tr.task).toMatchObject({ id: 't1', title: 'hello', archived: 0, created_at: T0 })
    expect(tr.messages.map((m: any) => [m.id, m.role, m.content])).toEqual([['u-r1', 'user', 'hi'], ['reply-r1', 'assistant', 'answer']])
    expect(JSON.parse(tr.messages[1].tool_events)).toEqual({ calls: 2 })
    expect(tr.messages[0].tool_events).toBeNull()
    expect(tr.messages[1].created_at).toBe(T1)
    const db = rawDb(path.join(tmp, 'db'))
    expect(db.prepare('SELECT * FROM task_runs').get()).toMatchObject({
      id: 'r1', task_id: 't1', status: 'done', runtime: 'codex', runtime_session_id: 'sess',
      input_tokens: 10, output_tokens: 20, started_at: T0, finished_at: T1,
    })
    db.close()
  })
  it('repeated start / end produce no duplicate rows and keep seq order', () => {
    const s = open()
    for (let i = 0; i < 3; i++) { start(s); end(s) }
    const db = rawDb(path.join(tmp, 'db'))
    for (const [t, n] of [['tasks', 1], ['channels', 1], ['messages', 2], ['task_runs', 1]] as const) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, t).toBe(n)
    }
    db.close()
    expect(s.getTaskTranscript('t1').messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
  })
  it('replaying start after end does not change the run back to running', () => {
    const s = open()
    start(s); end(s); start(s)
    const db = rawDb(path.join(tmp, 'db'))
    expect(db.prepare('SELECT status FROM task_runs').get().status).toBe('done')
    db.close()
  })
  it('the task title and similar fields are refreshed every turn, created_at stays the same', () => {
    const s = open()
    start(s, 'r1')
    start(s, 'r2', { task: { title: 'renamed', archived: true, updated_at: T1, created_at: T1 } })
    const t = s.getTaskTranscript('t1').task
    expect(t).toMatchObject({ title: 'renamed', archived: 1, updated_at: T1, created_at: T0 })
  })
  it('setTaskTitle: updates an existing task\'s title, collapses whitespace, truncates overlong titles, and leaves empty titles and unknown tasks alone', () => {
    const s = open()
    start(s, 'r1')
    expect(s.setTaskTitle('t1', '  新   标题\n第二行 ')).toBe(true)
    expect(s.getTaskTranscript('t1').task.title).toBe('新 标题 第二行')
    expect(s.setTaskTitle('t1', 'x'.repeat(600))).toBe(true)
    expect(s.getTaskTranscript('t1').task.title).toHaveLength(512)
    expect(s.setTaskTitle('t1', '   ')).toBe(false)
    expect(s.setTaskTitle('t1', null)).toBe(false)
    expect(s.getTaskTranscript('t1').task.title).toHaveLength(512)
    expect(s.setTaskTitle('nope', 'x')).toBe(false)
    expect(s.stats().tasks).toBe(1)
  })
  it('setTaskTitle: does not throw when the database is closed', () => {
    const s = open()
    start(s, 'r1')
    s.close()
    expect(() => s.setTaskTitle('t1', 'x')).not.toThrow()
    expect(s.setTaskTitle('t1', 'x')).toBe(false)
  })
  it('assistant id is fixed as reply-<runId>, one per turn across multiple turns', () => {
    const s = open()
    start(s, 'r1'); end(s, 'r1', { replyText: 'a1' })
    start(s, 'r2'); end(s, 'r2', { replyText: 'a2' })
    const ids = s.getTaskTranscript('t1').messages.map((m: any) => m.id)
    expect(ids).toEqual(['u-r1', 'reply-r1', 'u-r2', 'reply-r2'])
  })
  it('replaying end with the same runId but changed reply text -> updates the same row, no new row', () => {
    const s = open()
    start(s); end(s, 'r1', { replyText: 'v1' }); end(s, 'r1', { replyText: 'v2' })
    const m = s.getTaskTranscript('t1').messages.filter((x: any) => x.role === 'assistant')
    expect(m.length).toBe(1)
    expect(m[0].content).toBe('v2')
  })
  it('cancelled with no reply text -> no assistant row written, the run is still updated', () => {
    const s = open()
    start(s)
    for (const replyText of [undefined, null, '']) {
      end(s, 'r1', { status: 'cancelled', replyText, toolSummary: null })
    }
    expect(s.getTaskTranscript('t1').messages.map((m: any) => m.role)).toEqual(['user'])
    const db = rawDb(path.join(tmp, 'db'))
    expect(db.prepare('SELECT status FROM task_runs').get().status).toBe('cancelled')
    db.close()
  })
  it('toolSummary is null -> tool_events stored as NULL', () => {
    const s = open()
    start(s); end(s, 'r1', { toolSummary: null })
    expect(s.getTaskTranscript('t1').messages[1].tool_events).toBeNull()
  })
  it('end without a start can still be stored (the run row is filled in)', () => {
    const s = open()
    expect(end(s, 'rX')).toBe(true)
    expect(s.stats().messages).toBe(1)
  })
  it('missing fields (undefined) are treated as NULL without error', () => {
    const s = open()
    expect(s.recordRunStart({
      task: { id: 't1', title: 'x', created_at: T0, updated_at: T0 }, channelId: 'c1', runId: 'r1', startedAt: T0,
      userMessages: [{ id: 'u1', content: 'c', created_at: T0 }],
    })).toBe(true)
    expect(s.getTaskTranscript('t1').messages[0].trigger_source).toBeNull()
  })
  it('conversation source metadata survives local persistence', () => {
    const store = open()
    start(store, 'r1', { userMessages: [{ id: 'sent', content: 'unchanged', created_at: T0, source_task_id: 'origin', source_runtime: 'codex' }] })
    expect(store.getTaskTranscript('t1').messages[0]).toMatchObject({ content: 'unchanged', source_task_id: 'origin', source_runtime: 'codex' })
  })

  it('stores trigger_source as-is', () => {
    const s = open()
    start(s, 'r1', { userMessages: [{ id: 'u1', content: 'x', created_at: T0, trigger_source: 'schedule' }] })
    expect(s.getTaskTranscript('t1').messages[0].trigger_source).toBe('schedule')
  })
  it('deduplicates attachments by (task, local_path) and updates them', () => {
    const s = open()
    start(s)
    const a = { local_path: '/w/a.png', oss_object_key: 'k1', size: 5, content_type: 'image/png' }
    end(s, 'r1', { attachments: [a, { local_path: '/w/b.txt', oss_object_key: 'k2', size: 1, content_type: 'text/plain' }] })
    end(s, 'r1', { attachments: [{ ...a, oss_object_key: 'k1b', size: 6 }] })
    const db = rawDb(path.join(tmp, 'db'))
    const rows = db.prepare('SELECT local_path, oss_object_key, size FROM attachments ORDER BY local_path').all().map((r: any) => ({ ...r }))
    expect(rows).toEqual([{ local_path: '/w/a.png', oss_object_key: 'k1b', size: 6 }, { local_path: '/w/b.txt', oss_object_key: 'k2', size: 1 }])
    db.close()
  })
})

describe('round-trips content losslessly', () => {
  it('5MB large message', () => {
    const s = open()
    const big = 'x'.repeat(5 * 1024 * 1024 - 3) + '尾巴!'
    start(s); end(s, 'r1', { replyText: big })
    const got = s.getTaskTranscript('t1').messages[1].content
    expect(got.length).toBe(big.length)
    expect(got === big).toBe(true)
  })
  it('round-trips emoji / Chinese text / combining characters / NUL', () => {
    const s = open()
    const text = '你好，世界 😀👨‍👩‍👧‍👦 🇨🇳 é e\u0301 中\n\t"\'`;--'
    start(s, 'r1', { userMessages: [{ id: 'u1', content: text, created_at: T0 }] })
    expect(s.getTaskTranscript('t1').messages[0].content).toBe(text)
  })
  it('a NUL character does not truncate the content after it (replaced with U+FFFD)', () => {
    const s = open()
    start(s, 'r1', { userMessages: [{ id: 'u1', content: 'before\u0000after', created_at: T0 }] })
    expect(s.getTaskTranscript('t1').messages[0].content).toBe('before\uFFFDafter')
  })
  it('lone surrogates: no throw; SQLite stores UTF-8, so lone surrogates are replaced with U+FFFD (accepted)', () => {
    const s = open()
    const text = 'a\uD83Db\uDE00c'
    expect(start(s, 'r1', { userMessages: [{ id: 'u1', content: text, created_at: T0 }] })).toBe(true)
    const got = s.getTaskTranscript('t1').messages[0].content
    // Not required to be identical character for character (UTF-8 cannot represent lone surrogates);
    // only that the normal parts are lossless and the whole entry is not lost
    expect(got.startsWith('a') && got.includes('b') && got.endsWith('c')).toBe(true)
    expect(got.length).toBeGreaterThanOrEqual(5)
  })
  it('SQL-injection-style content is just plain text', () => {
    const s = open()
    const evil = "'); DROP TABLE messages;--"
    start(s, 'r1', { userMessages: [{ id: 'u1', content: evil, created_at: T0 }] })
    expect(s.getTaskTranscript('t1').messages[0].content).toBe(evil)
  })
})

describe('concurrency (WAL)', () => {
  it('two store instances writing to the same database lose nothing', () => {
    const a = open(), b = open()
    for (let i = 0; i < 60; i++) {
      start(a, `ra${i}`, { taskId: 'ta', channelId: 'ca', userMessages: [{ id: `ua${i}`, content: 'a', created_at: T0 }] })
      start(b, `rb${i}`, { taskId: 'tb', channelId: 'cb', userMessages: [{ id: `ub${i}`, content: 'b', created_at: T0 }] })
      // Both sides interleave writes to the same channel of the same task
      start(i % 2 ? a : b, `rs${i}`, { taskId: 'ts', channelId: 'cs', userMessages: [{ id: `us${i}`, content: 's', created_at: T0 }] })
    }
    expect(a.stats().messages).toBe(180)
    expect(b.stats().messages).toBe(180)
    expect(a.getTaskTranscript('ts').messages.length).toBe(60)
    expect(a.__logs).toEqual([]); expect(b.__logs).toEqual([])
  })
  it('two instances migrating the same old database at once migrate only once without error', () => {
    const m1 = 'CREATE TABLE t1 (a INTEGER)'
    const m2 = 'CREATE TABLE t2 (a INTEGER)'
    open({ migrations: [m1] }).close()
    const a = open({ migrations: [m1, m2] })
    const b = open({ migrations: [m1, m2] })
    expect(a.__null || b.__null).toBe(false)
    expect(a.stats().schemaVersion).toBe(0) // the test migrations have no tasks table, so stats uses the fallback; the version comes from the database
    const d = rawDb(path.join(tmp, 'db')); expect(d.prepare('PRAGMA user_version').get().user_version).toBe(2); d.close()
  })
})

describe('deleteTask', () => {
  it('cascades the delete without affecting other tasks; returns the message count; returns 0 if missing', () => {
    const s = open()
    start(s, 'r1'); end(s, 'r1', { attachments: [{ local_path: '/w/a', oss_object_key: 'k', size: 1, content_type: 'x' }] })
    start(s, 'r2', { taskId: 't2', channelId: 'c2', userMessages: [{ id: 'u-other', content: 'o', created_at: T0 }] })
    s.recordRunEnd({ runId: 'r2', taskId: 't2', channelId: 'c2', status: 'done', replyText: 'ok', toolSummary: null, finishedAt: T1, attachments: [{ local_path: '/w/a', oss_object_key: 'k9' }] })
    expect(s.deleteTask('t1')).toBe(2)
    const db = rawDb(path.join(tmp, 'db'))
    const count = (t: string, w: string) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).get().c
    expect(count('tasks', "id='t1'")).toBe(0)
    expect(count('channels', "task_id='t1'")).toBe(0)
    expect(count('task_runs', "task_id='t1'")).toBe(0)
    expect(count('attachments', "task_id='t1'")).toBe(0)
    expect(count('messages', "channel_id='c1'")).toBe(0)
    expect(count('tasks', "id='t2'")).toBe(1)
    expect(count('messages', "channel_id='c2'")).toBe(2)
    expect(count('attachments', "task_id='t2'")).toBe(1) // attachments with the same path in different tasks are independent
    db.close()
    expect(s.deleteTask('t1')).toBe(0)
    expect(s.deleteTask('nope')).toBe(0)
    expect(s.getTaskTranscript('t1')).toEqual({ task: null, messages: [] })
    expect(s.getTaskTranscript('t2').messages.length).toBe(2)
    expect(s.stats()).toMatchObject({ tasks: 1, messages: 2 })
  })
  it('clears all channels of a task', () => {
    const s = open()
    start(s, 'r1', { channelId: 'c1' })
    start(s, 'r2', { channelId: 'cX' })
    expect(s.deleteTask('t1')).toBe(2)
  })
})

describe('migrations', () => {
  const m1 = 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)'
  const m2 = 'ALTER TABLE a ADD COLUMN w TEXT DEFAULT \'\''
  const m3 = (db: any) => db.exec('CREATE TABLE b (id INTEGER)')
  const m4 = 'CREATE INDEX idx_a_v ON a (v)'
  const dir = () => path.join(tmp, 'db')
  const baks = () => fs.readdirSync(dir()).filter((n) => n.includes('.bak-v')).sort()
  const ver = () => { const d = rawDb(dir()); const v = d.prepare('PRAGMA user_version').get().user_version; d.close(); return v }

  it('LOCAL_SCHEMA_VERSION equals the number of built-in migrations', () => {
    expect(ls.LOCAL_SCHEMA_VERSION).toBe(2)
  })
  it('upgrading an old-version database: backs up to .bak-v<old>, keeps data; a further upgrade keeps only the latest backup', () => {
    const s1 = open({ migrations: [m1] })
    s1.close()
    const d = rawDb(dir()); d.exec("INSERT INTO a (v) VALUES ('keep')"); d.close()
    expect(baks()).toEqual([])

    const s2 = open({ migrations: [m1, m2, m3] })
    expect(s2.__null).toBe(false)
    s2.close()
    expect(ver()).toBe(3)
    expect(baks()).toEqual(['opentandem.db.bak-v1'])
    // The backup is a snapshot from before the upgrade: version 1, data present, no table b
    const bak = new ((process as any).getBuiltinModule('node:sqlite').DatabaseSync)(path.join(dir(), 'opentandem.db.bak-v1'))
    expect(bak.prepare('PRAGMA user_version').get().user_version).toBe(1)
    expect(bak.prepare('SELECT v FROM a').get().v).toBe('keep')
    expect(bak.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='b'").get().c).toBe(0)
    bak.close()
    const d2 = rawDb(dir()); expect(d2.prepare('SELECT v, w FROM a').get()).toMatchObject({ v: 'keep', w: '' }); d2.close()

    const s3 = open({ migrations: [m1, m2, m3, m4] })
    s3.close()
    expect(ver()).toBe(4)
    expect(baks()).toEqual(['opentandem.db.bak-v3']) // the old bak-v1 is removed
  })
  it('the backup includes the latest data still in the WAL that has not been checkpointed', () => {
    const s1 = open({ migrations: [m1] })
    const hold = rawDb(dir()) // another connection stays open, ruling out shortcuts other than the automatic checkpoint on close
    hold.exec("INSERT INTO a (v) VALUES ('in-wal')")
    s1.close()
    const s2 = open({ migrations: [m1, m2] })
    s2.close(); hold.close()
    const bak = new ((process as any).getBuiltinModule('node:sqlite').DatabaseSync)(path.join(dir(), 'opentandem.db.bak-v1'))
    expect(bak.prepare('SELECT v FROM a').get().v).toBe('in-wal')
    bak.close()
  })
  it('same version: no migration, no backup', () => {
    open({ migrations: [m1, m2] }).close()
    open({ migrations: [m1, m2] }).close()
    expect(baks()).toEqual([])
  })
  it('a hand-built old database (user_version=0 but tables exist) is treated as a fresh database, no backup', () => {
    fs.mkdirSync(dir())
    const d = rawDb(dir()); d.exec('CREATE TABLE zzz (x INTEGER)'); d.close()
    const s = open()
    expect(s.__null).toBe(false)
    expect(baks()).toEqual([])
    expect(ver()).toBe(ls.LOCAL_SCHEMA_VERSION)
    const d2 = rawDb(dir()); expect(d2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='zzz'").get().c).toBe(1); d2.close() // leaves unrelated tables untouched
  })
  it('user_version higher than known: opens and reads/writes as usual, no downgrade, no backup', () => {
    open({ migrations: [m1, m2, m3] }).close()
    const s = open() // the default migrations have only 1 entry
    expect(s.__null).toBe(false)
    expect(s.__logs).toEqual([])
    expect(ver()).toBe(3)
    // The tables from the default code do not exist in the database; writes fail but do not throw, and return false
    expect(start(s)).toBe(false)
    s.close()
    expect(ver()).toBe(3)
    expect(baks()).toEqual([])
  })
  it('user_version higher but all tables present: reads and writes as usual', () => {
    const s0 = open(); s0.close()
    const d = rawDb(dir()); d.exec('PRAGMA user_version = 99'); d.close()
    const s = open()
    expect(s.__null).toBe(false)
    expect(start(s)).toBe(true)
    expect(end(s)).toBe(true)
    expect(s.stats()).toMatchObject({ messages: 2, schemaVersion: 99 })
    expect(baks()).toEqual([])
  })
  it('migration fails midway: rolls back as a whole, returns null, logs only once', () => {
    const s1 = open({ migrations: [m1] }); s1.close()
    const logs: string[] = []
    const bad = ls.openLocalStore({
      dir: dir(), log: (m: string) => logs.push(m),
      migrations: [m1, (db: any) => { db.exec('CREATE TABLE half (x INTEGER)'); throw new Error('injected') }],
    })
    expect(bad).toBeNull()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatch(/injected/)
    expect(ver()).toBe(1)
    const d = rawDb(dir()); expect(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='half'").get().c).toBe(0); d.close()
    // After the migration is fixed, the upgrade can continue
    const ok = open({ migrations: [m1, m2] })
    expect(ok.__null).toBe(false)
    expect(ver()).toBe(2)
  })
  it('a migration with an SQL syntax error also rolls back', () => {
    const logs: string[] = []
    const bad = ls.openLocalStore({ dir: dir(), log: (m: string) => logs.push(m), migrations: [m1, 'CREATE TABLE c (x INTEGER); THIS IS NOT SQL'] })
    expect(bad).toBeNull()
    expect(logs.length).toBe(1)
    expect(ver()).toBe(1) // the first step is committed; the second step rolls back as a whole (including its earlier successful CREATE TABLE c)
    const d = rawDb(dir()); expect(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='c'").get().c).toBe(0); d.close()
  })
})

describe('database file deleted while running: rebuilds automatically and logs one line', () => {
  const dbDir = () => path.join(tmp, 'db')
  const rebuildLogs = (s: any) => s.__logs.filter((m: string) => m.includes('rebuilding'))

  it('whole directory wiped: the next write recreates the directory, README and a new database; old history is lost, new records are persisted', () => {
    const s = open()
    expect(start(s, 'r1')).toBe(true)
    expect(end(s, 'r1')).toBe(true)
    fs.rmSync(dbDir(), { recursive: true, force: true })
    expect(fs.existsSync(dbDir())).toBe(false)

    expect(start(s, 'r2', { taskId: 't2', channelId: 'c2' })).toBe(true)
    expect(fs.existsSync(path.join(dbDir(), 'opentandem.db'))).toBe(true)
    expect(fs.existsSync(path.join(dbDir(), 'README.txt'))).toBe(true)
    expect(rebuildLogs(s).length).toBe(1)
    expect(rebuildLogs(s)[0]).toContain('deleted or replaced')
    // The old task is gone and the new task is present; verified by reading the file on disk through an external connection, not the store's own connection
    const raw = rawDb(dbDir())
    const ids = raw.prepare('SELECT id FROM tasks ORDER BY id').all().map((r: any) => r.id)
    raw.close()
    expect(ids).toEqual(['t2'])
  })

  it('keeps writing normally after the rebuild, without rebuilding every time or logging repeatedly', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    start(s, 'r2', { taskId: 't2', channelId: 'c2' })
    end(s, 'r2', { taskId: 't2', channelId: 'c2' })
    start(s, 'r3', { taskId: 't2', channelId: 'c2' })
    expect(rebuildLogs(s).length).toBe(1)
    expect(s.stats().messages).toBe(3) // the user message of r2 + the reply + the user message of r3
  })

  it('deleting it again rebuilds it again and logs another line', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    start(s, 'r2')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    start(s, 'r3')
    expect(rebuildLogs(s).length).toBe(2)
    expect(fs.existsSync(path.join(dbDir(), 'opentandem.db'))).toBe(true)
  })

  it('only the database file deleted with -wal/-shm leftovers: the old database\'s log is not replayed into the new one', () => {
    const s = open()
    start(s, 'r1')
    end(s, 'r1')
    const dbFile = path.join(dbDir(), 'opentandem.db')
    expect(fs.existsSync(dbFile + '-wal')).toBe(true)
    fs.rmSync(dbFile, { force: true })

    expect(start(s, 'r2', { taskId: 't2', channelId: 'c2' })).toBe(true)
    const raw = rawDb(dbDir())
    const ids = raw.prepare('SELECT id FROM tasks ORDER BY id').all().map((r: any) => r.id)
    const msgs = Number(raw.prepare('SELECT COUNT(*) c FROM messages').get().c)
    raw.close()
    expect(ids).toEqual(['t2'])
    expect(msgs).toBe(1)
  })

  it('database file replaced by another process with a new file: detected, reconnects to the new file, and both sides read the same data', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    const other = open() // another Runner process created a new database in the same directory
    start(other, 'r9', { taskId: 't9', channelId: 'c9' })

    expect(start(s, 'r2', { taskId: 't2', channelId: 'c2' })).toBe(true)
    expect(rebuildLogs(s).length).toBe(1)
    const ids = other.stats().tasks
    expect(ids).toBe(2) // t9 from other + t2 written by s after reconnecting
    expect(s.stats().tasks).toBe(2)
  })

  it('database untouched: no rebuild, no log', () => {
    const s = open()
    for (let i = 0; i < 5; i++) start(s, `r${i}`)
    expect(rebuildLogs(s).length).toBe(0)
    expect(s.__logs.length).toBe(0)
  })

  it('read methods also trigger a rebuild (stats / getTaskTranscript / deleteTask / setTaskTitle)', () => {
    for (const call of [
      (s: any) => s.stats(),
      (s: any) => s.getTaskTranscript('t1'),
      (s: any) => s.deleteTask('t1'),
      (s: any) => s.setTaskTitle('t1', 'x'),
    ]) {
      const s = open({ dir: path.join(tmp, `db-${opened.length}`) })
      start(s, 'r1')
      fs.rmSync(path.dirname(path.join(s.dbPath)), { recursive: true, force: true })
      expect(() => call(s)).not.toThrow()
      expect(fs.existsSync(s.dbPath)).toBe(true)
      expect(rebuildLogs(s).length).toBe(1)
    }
  })

  it('rebuild fails: no throw, writes return false; after recovery the next write succeeds', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    fs.writeFileSync(dbDir(), 'now a file') // a file occupies the directory location, so mkdir always fails
    expect(start(s, 'r2')).toBe(false)
    expect(() => s.stats()).not.toThrow()
    fs.rmSync(dbDir(), { force: true })
    expect(start(s, 'r3')).toBe(true)
    expect(fs.existsSync(path.join(dbDir(), 'opentandem.db'))).toBe(true)
    expect(rebuildLogs(s).length).toBe(1)
  })

  it('closing after a rebuild does not throw, and using it again does not throw', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    start(s, 'r2')
    expect(() => { s.close(); s.close() }).not.toThrow()
    expect(start(s, 'r3')).toBe(false)
  })

  it('the rebuilt database still has no identity fields, and its version is the current version', () => {
    const s = open()
    start(s, 'r1')
    fs.rmSync(dbDir(), { recursive: true, force: true })
    start(s, 'r2')
    const raw = rawDb(dbDir())
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    const bad: string[] = []
    for (const t of tables) for (const c of raw.prepare(`PRAGMA table_info(${t})`).all()) if (/author|email|user/i.test(c.name)) bad.push(`${t}.${c.name}`)
    const ver = Number(raw.prepare('PRAGMA user_version').get().user_version)
    raw.close()
    expect(bad).toEqual([])
    expect(ver).toBe(ls.LOCAL_SCHEMA_VERSION)
  })
})
