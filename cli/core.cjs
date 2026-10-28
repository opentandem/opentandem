// Client core shared by the Mac / Windows desktop app (Electron main process) and the `opentandem` command line (cli/opentandem.cjs). Only node: built-in modules are used.
// The source lives in cli/ and is open source with the command line; the desktop app loads it through desktop/core.cjs and electron-builder copies it into the app's cli/ folder.
//
// - Device id (device_hash): when the app data is deleted and the computer connects again, the server finds the same machine with it.
// - Connections (connection.json v2): one computer can connect to several workspaces, one machine and one Runner credential each.
// - Earlier Runners: credentials left by the earlier install method are handed to the server on connect (so one computer never shows up twice) and the earlier Runner is removed.
// - Runner pool: one Runner per connection. A Runner that updates itself writes the new script into the daemon folder and exits with 75; the pool restarts it with the newest script.
// - Local ticket: proves a request comes from the app on this computer (local-only tasks, the remote switch and disconnecting this computer need it).
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')

const SESSION_COOKIE = 'sophon_session'
const WATCH_MS = 15_000
const LOST_MS = 120_000
const KEY_RE = /^ot_[0-9a-f-]{36}\.([0-9a-f]{16})\.[0-9a-f]{64}$/i

/** The system's own device id (not a MAC address), the commonly used one on each platform; placeholder values count as none. */
function rawDeviceId(platform = process.platform) {
  let raw = ''
  try {
    if (platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 })
      raw = (out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/) || [])[1] || ''
    } else if (platform === 'win32') {
      // A 32-bit process reading HKLM is redirected; /reg:64 always reads the 64-bit view.
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      raw = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || ''
    } else {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { raw = fs.readFileSync(file, 'utf8').trim() } catch {}
        if (raw) break
      }
    }
  } catch {}
  raw = raw.trim().toLowerCase()
  const bare = raw.replace(/-/g, '')
  if (!raw || raw === 'uninitialized' || /^0+$/.test(bare) || /^f+$/.test(bare)) return ''
  return raw
}

/** Only a keyed hash bound to the server address is sent: the raw device id never leaves the computer, and ids differ between servers. */
function deviceHash(server, platform = process.platform) {
  const raw = rawDeviceId(platform)
  return raw ? crypto.createHmac('sha256', 'opentandem-device-v1').update(`${raw}\n${new URL(server).origin}`).digest('hex') : ''
}

function machineIdOfKey(key) {
  return (KEY_RE.exec(String(key || '').trim()) || [])[1]?.toLowerCase() || ''
}

/** connection.json：{ v: 2, server, device_hash, bindings: [{ machineId, key, userId, tenantId }] }。 */
class BindingStore {
  constructor(file, server, device) {
    this.file = file
    this.server = server
    this.device = device
    this.bindings = []
    let data = null
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    // v1 holds a single record with the same fields as one v2 binding.
    if (data && !data.v && data.machineId) data = { v: 2, server: data.server, device_hash: '', bindings: [data] }
    if (!data || data.server !== server) return
    // A data folder copied whole to another computer carries the other computer's device id: those connections must not run here.
    if (data.device_hash && device && data.device_hash !== device) return
    this.bindings = (data.bindings || []).filter(b => b && machineIdOfKey(b.key) === b.machineId && b.userId && b.tenantId)
      .map(({ machineId, key, userId, tenantId, disconnected, paused, name, team, account }) => ({ machineId, key, userId, tenantId,
        ...(disconnected ? { disconnected: true } : {}), ...(paused ? { paused: true } : {}), ...(name ? { name: String(name) } : {}), ...(team ? { team: String(team) } : {}), ...(account ? { account: String(account) } : {}) }))
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ v: 2, server: this.server, device_hash: this.device, bindings: this.bindings }), { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }
  /** One machine per workspace: a reconnect replaces the earlier record of the same workspace. Returns the replaced records. */
  put(binding) {
    const replaced = this.bindings.filter(b => b.machineId === binding.machineId || (b.userId === binding.userId && b.tenantId === binding.tenantId))
    this.bindings = [...this.bindings.filter(b => !replaced.includes(b)), binding]
    this.save()
    return replaced.filter(b => b.machineId !== binding.machineId)
  }
  remove(machineId) {
    const before = this.bindings.length
    this.bindings = this.bindings.filter(b => b.machineId !== machineId)
    if (this.bindings.length !== before) this.save()
  }
  /** Local cache of "disconnected" (the source of truth is machines.disconnected_at on the server) and display labels (machine, workspace, account); only the local record changes. */
  patch(machineId, fields) {
    const binding = this.bindings.find(b => b.machineId === machineId)
    if (!binding) return false
    let changed = false
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'disconnected') { if (!!binding.disconnected !== !!value) { if (value) binding.disconnected = true; else delete binding.disconnected; changed = true } }
      else if (typeof value === 'string' && value && binding[name] !== value) { binding[name] = value; changed = true }
    }
    if (changed) this.save()
    return changed
  }
  forTenant(userId, tenantId) {
    return this.bindings.find(b => b.userId === userId && b.tenantId === tenantId) || null
  }
}

/**
 * Instances the earlier install method (the copied Runner command) left on this computer for the same server: folder, credential and uninstall entry.
 * Only folders named after this server (host[_port], optionally followed by .<machine id>) count: credentials of another server are never sent here.
 */
function legacyRunners(server, platform = process.platform, env = process.env) {
  const origin = new URL(server)
  const instance = `${origin.hostname}${origin.port ? `_${origin.port}` : ''}`
  const home = os.homedir()
  const root = platform === 'darwin' ? path.join(home, 'Library/Application Support/OpenTandem Runner')
    : platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'OpenTandem Runner')
    : path.join(home, '.local/share/opentandem-runner')
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const name of names) {
    if (name !== instance && !name.startsWith(`${instance}.`)) continue
    const dir = path.join(root, name)
    let key = ''
    try { key = fs.readFileSync(path.join(dir, 'runner.key'), 'utf8').split(/\r?\n/)[0].trim() } catch { continue }
    const machineId = machineIdOfKey(key)
    if (!machineId) continue
    const manager = platform === 'win32' ? path.join(dir, 'opentandem-runner.ps1') : path.join(dir, 'bin/opentandem-runner')
    out.push({ dir, key, machineId, manager: fs.existsSync(manager) ? manager : '' })
  }
  return out
}

/** Stop and remove an earlier Runner with its own manager script (stops the service, removes start at login, deletes the folder). */
function uninstallLegacy(runner, platform = process.platform) {
  if (!runner.manager) return false
  try {
    if (platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner.manager, 'uninstall'],
        { stdio: 'ignore', timeout: 60_000, windowsHide: true })
    } else execFileSync('/bin/sh', [runner.manager, 'uninstall'], { stdio: 'ignore', timeout: 60_000 })
    return !fs.existsSync(path.join(runner.dir, 'runner.key'))
  } catch { return false }
}

const deviceName = () => os.hostname().replace(/\.local$/i, '').slice(0, 60)
const deviceOs = () => `${os.type()} ${os.release()} (${os.arch()})`

/**
 * Connect this computer. The account is proven either by a signed-in session (cookie) or by the credential of that machine from the web command (linkKey).
 * On success the earlier Runner that was taken over is removed, and the new binding is returned.
 */
async function connectComputer({ server, cookie = '', linkKey = '', device = '', platform = process.platform, fetchImpl = fetch }) {
  const legacy = legacyRunners(server, platform)
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const response = await fetchImpl(`${server}/api/desktop/connect`, {
    method: 'POST', headers, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ link_key: linkKey || undefined, adopt: legacy.map(r => r.key).slice(0, 10), device_hash: device || undefined, name: deviceName(), os: deviceOs() }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`)
    error.code = data.error
    error.status = response.status
    error.machineName = typeof data.machine_name === 'string' ? data.machine_name : ''
    throw error
  }
  const binding = { machineId: data.machine_id, key: data.runner_key, userId: data.user_id, tenantId: data.tenant_id }
  // An earlier Runner and the new one serving the same machine would compete for tasks: remove the earlier one before the new one starts.
  const removed = legacy.filter(r => r.machineId === binding.machineId).map(r => uninstallLegacy(r, platform))
  return { binding, name: data.name, matched: data.matched, legacyRemoved: removed.some(Boolean) }
}

/** Exit code as a signed 32-bit number: Node reports Windows native crash codes (such as 0xC0000005) unsigned, and the server column is int. */
function exitCodeOf(code, signal) {
  if (Number.isInteger(code)) return code | 0
  const number = signal && os.constants.signals[signal]
  return Number.isInteger(number) ? number : null
}

/** Human-readable exit reason: the signal name, or the hexadecimal exit code on Windows. */
function exitText(code, signal) {
  if (signal) return `signal=${signal}`
  if (!Number.isInteger(code)) return 'code=?'
  return process.platform === 'win32' && (code | 0) < 0 ? `code=0x${(code >>> 0).toString(16).toUpperCase()}` : `code=${code}`
}

/** Version comparison: x.y.z only. */
const versionParts = v => String(v).split('.').map(n => Number(n) || 0)
const newerVersion = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }

/** Runner script: kept in the daemon folder, newest version wins; downloaded from the server when there is none (the same address the earlier Runner installer used). */
async function ensureDaemonScript(server, directory, fetchImpl = fetch) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const latest = () => fs.readdirSync(directory).map(name => (/^machine-daemon-(\d+\.\d+\.\d+)\.mjs$/.exec(name) || [])[1]).filter(Boolean)
    .reduce((best, v) => (!best || newerVersion(v, best) ? v : best), '')
  let version = latest()
  if (!version) {
    const response = await fetchImpl(`${server}/api/daemon-script`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Runner download failed (HTTP ${response.status})`)
    const source = await response.text()
    version = (/^const DAEMON_VERSION = '(\d+\.\d+\.\d+)'/m.exec(source) || [])[1]
    if (!version) throw new Error('Runner download is invalid')
    const target = path.join(directory, `machine-daemon-${version}.mjs`)
    fs.writeFileSync(`${target}.tmp`, source, { mode: 0o700 })
    fs.renameSync(`${target}.tmp`, target)
  }
  // Keep only the two newest versions.
  const all = fs.readdirSync(directory).filter(n => /^machine-daemon-\d+\.\d+\.\d+\.mjs$/.test(n))
    .sort((a, b) => newerVersion(a.slice(15, -4), b.slice(15, -4)) ? -1 : 1)
  for (const name of all.slice(2)) fs.rmSync(path.join(directory, name), { force: true })
  return { file: path.join(directory, `machine-daemon-${version}.mjs`), version }
}

/**
 * One Runner process per connection. The caller provides node: OpenTandem Service on the Mac app, the app itself on Windows
 * (ELECTRON_RUN_AS_NODE), and the pinned Node.js runtime for the command line.
 */
class RunnerPool {
  constructor({ server, directory, node, env = {}, launchdLabel = '', onChange = () => {}, onDeleted = () => {}, fetchImpl = fetch, diag = null }) {
    // launchdLabel set (packaged Mac app): launchd runs the Runner with label <launchdLabel>.<machine id>, and it keeps running after the app quits.
    // diag: runtime problem reporting (see the desktop app's diagnostics.cjs); nothing is reported without it.
    Object.assign(this, { server, directory, node, env, launchdLabel, onChange, onDeleted, fetchImpl, diag })
    this.lostSince = new Map()
    this.lostReported = new Set()
    this.lastTick = Date.now()
    if (diag) setInterval(() => this.watch(), WATCH_MS).unref?.()
    this.daemonDir = path.join(directory, 'daemon')
    this.children = new Map()
    this.timers = new Map()
    this.keys = new Map()
    this.stopping = false
    this.lastError = ''
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  machineDir(machineId) { return path.join(this.directory, machineId) }
  status(machineId) {
    let status = {}
    try { status = JSON.parse(fs.readFileSync(path.join(this.machineDir(machineId), 'state/status.json'), 'utf8')) } catch {}
    const child = this.children.get(machineId)
    if (child?.launchd ? !pidAlive(status.pid) : status.pid !== child?.pid) status = {}
    const last = Date.parse(status.last_heartbeat_at || '')
    return { state: child ? 'starting' : 'stopped', ...status, machineId,
      connected: status.state === 'connected' && Date.now() - last < 60_000 }
  }
  /** Make the running processes match the connections: stop the extra ones, start the missing ones. */
  sync(bindings) {
    const wanted = new Map(bindings.map(b => [b.machineId, b]))
    this.latest = wanted
    for (const id of [...this.children.keys(), ...this.timers.keys()]) if (!wanted.has(id)) this.stop(id)
    // A reconnect issued a new credential: the running Runner still holds the old one, which stops working once the new one is used, so restart it.
    for (const [id, binding] of wanted) if (this.keys.has(id) && this.keys.get(id) !== binding.key) this.stop(id)
    for (const binding of wanted.values()) if (!this.children.has(binding.machineId) && !this.timers.has(binding.machineId)) void this.start(binding)
  }
  async start(requested) {
    // A scheduled restart uses the latest connection (the credential may have changed meanwhile); a removed connection is not started again.
    const binding = this.latest ? this.latest.get(requested.machineId) : requested
    if (!binding) return
    const id = binding.machineId
    this.timers.delete(id)
    if (this.stopping || this.children.has(id)) return
    let script
    try { script = await ensureDaemonScript(this.server, this.daemonDir, this.fetchImpl) } catch (error) {
      this.lastError = error.message
      this.onChange()
      this.timers.set(id, setTimeout(() => this.start(binding), 30_000))
      return
    }
    if (this.stopping || this.children.has(id)) return
    this.lastError = ''
    const dir = this.machineDir(id)
    const stateDir = path.join(dir, 'state')
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    // A machine that was deleted and then restored still has the earlier deleting state in its folder; left there, deletion detection would disconnect the new connection.
    if (!this.launchdLabel || ['deleting', 'cleanup_pending'].includes(this.readState(id))) fs.rmSync(path.join(stateDir, 'status.json'), { force: true })
    // The credential is rewritten from the connection every time: after a reconnect the Runner must use the new one.
    const keyFile = path.join(dir, 'runner.key')
    const oldKey = this.launchdLabel ? (() => { try { return fs.readFileSync(keyFile, 'utf8').trim() } catch { return '' } })() : ''
    fs.writeFileSync(keyFile, binding.key + '\n', { mode: 0o600 })
    this.keys.set(id, binding.key)
    if (this.launchdLabel) {
      try { this.startLaunchd(id, dir, keyFile, stateDir, binding.key !== oldKey) } catch (error) {
        this.lastError = `Runner failed to start: ${error.message}`
        this.onChange()
        this.timers.set(id, setTimeout(() => this.start(binding), 30_000))
        return
      }
      this.children.set(id, { launchd: true, label: `${this.launchdLabel}.${id}` })
      this.onChange()
      return
    }
    const log = fs.openSync(path.join(dir, 'runner.log'), 'a', 0o600)
    const child = spawn(this.node.command, [...(this.node.args || []), script.file, '--server', this.server, '--id', id,
      '--token-file', keyFile, '--status-file', path.join(stateDir, 'status.json')], {
      cwd: os.homedir(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, ...this.env, ...(this.node.env || {}), SOPHON_MANAGED: 'desktop',
        SOPHON_DESKTOP_DAEMON_DIR: this.daemonDir },
    })
    fs.closeSync(log)
    this.children.set(id, child)
    child.on('error', error => {
      if (this.children.get(id) !== child) return
      this.children.delete(id)
      this.lastError = `Runner failed to start: ${error.message}`
      this.onChange()
    })
    child.on('exit', (code, signal) => {
      if (this.children.get(id) !== child) return
      this.children.delete(id)
      const status = this.readState(id)
      // The machine was deleted on the web: after the server-signed uninstall instruction the Runner writes deleting / cleanup_pending.
      if (status === 'deleting' || status === 'cleanup_pending') { this.forget(id); return }
      this.reportExit(id, stateDir, code, signal)
      this.onChange()
      // 75 = the Runner wrote a new version into the daemon folder: restart with it right away; other exits restart after 5 seconds.
      if (!this.stopping) this.timers.set(id, setTimeout(() => this.start(binding), code === 75 ? 200 : 5000))
    })
    this.onChange()
  }
  /** Write a LaunchAgent and hand it to launchd: when it is already running with the same configuration and credential, keep it (an app restart does not interrupt the Runner); otherwise reload. */
  startLaunchd(id, dir, keyFile, stateDir, keyChanged) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid machine id')
    const label = `${this.launchdLabel}.${id}`
    const file = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
    const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // The program is OpenTandem Service itself (not sh), so System Settings > Login Items shows its name.
    // The launcher always takes the newest script in the daemon folder: after a self-update the Runner exits and launchd restarts it with the new one.
    const launcher = path.join(this.daemonDir, 'launcher.mjs')
    const launcherSource = "import fs from 'node:fs'\nimport path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n"
      + "const dir = path.dirname(fileURLToPath(import.meta.url))\n"
      + "const files = fs.readdirSync(dir).filter(f => /^machine-daemon-.+\\.mjs$/.test(f)).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)\n"
      + "if (!files.length) { console.error('no runner script'); process.exit(1) }\n"
      + "await import(pathToFileURL(path.join(dir, files[0].f)).href)\n"
    fs.mkdirSync(this.daemonDir, { recursive: true })
    try { if (fs.readFileSync(launcher, 'utf8') !== launcherSource) throw 0 } catch { fs.writeFileSync(launcher, launcherSource) }
    const args = [this.node.command, launcher, '--server', this.server, '--id', id, '--token-file', keyFile, '--status-file', path.join(stateDir, 'status.json')]
    const env = { SOPHON_MANAGED: 'desktop', SOPHON_DESKTOP_DAEMON_DIR: this.daemonDir, HOME: os.homedir() }
    for (const name of ['PATH', 'USER', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    Object.assign(env, this.env, this.node.env || {})
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>`
      + `<key>Label</key><string>${xml(label)}</string>`
      + `<key>AssociatedBundleIdentifiers</key><string>${xml(this.launchdLabel)}</string>`
      + `<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>`
      + `<key>WorkingDirectory</key><string>${xml(os.homedir())}</string>`
      + `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>`
      + `<key>StandardOutPath</key><string>${xml(path.join(dir, 'runner.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(dir, 'runner.log'))}</string>`
      + `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer></dict></plist>\n`
    let previous = ''
    try { previous = fs.readFileSync(file, 'utf8') } catch {}
    const loaded = launchdLoaded(label)
    if (loaded && previous === plist && !keyChanged) return
    if (loaded) {
      launchctl(['bootout', `gui/${process.getuid()}/${label}`])
      // bootout returns before the job is fully gone; bootstrapping again too early fails with an I/O error, so wait until it disappears.
      for (let i = 0; i < 50 && launchdLoaded(label); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, plist, { mode: 0o600 })
    launchctl(['bootstrap', `gui/${process.getuid()}`, file])
  }
  stopLaunchd(label) {
    try { launchctl(['bootout', `gui/${process.getuid()}/${label}`]) } catch {}
    try { fs.rmSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`), { force: true }) } catch {}
  }
  /** Runner exited unexpectedly (0 is a normal exit, 75 a self-update restart). When the Runner wrote last-fatal.json (a process-level crash) it reports that itself after restarting. */
  reportExit(id, stateDir, code, signal) {
    if (!this.diag || this.stopping || code === 0 || code === 75) return
    if (code === 1 && fs.existsSync(path.join(stateDir, 'last-fatal.json'))) return
    this.diag.record({ stage: 'crash', step: 'runner_exit', exitCode: exitCodeOf(code, signal), machineId: id,
      detail: `Runner exited ${exitText(code, signal)}` })
  }
  /**
   * Disconnect tracking: every 15 seconds look at each connection's Runner; report once when it has not been connected for 2 minutes.
   * Connections the user disconnected do not count; an unusually long gap between checks means the computer slept, which does not count either, and timing starts again.
   */
  watch() {
    const t = Date.now()
    const slept = t - this.lastTick > WATCH_MS * 3
    this.lastTick = t
    if (slept) this.lostSince.clear()
    if (!this.stopping && this.latest) {
      for (const [id, binding] of this.latest) {
        const state = this.status(id)
        if (binding.disconnected || state.connected) { this.lostSince.delete(id); this.lostReported.delete(id); continue }
        if (!this.lostSince.has(id)) this.lostSince.set(id, t)
        if (t - this.lostSince.get(id) < LOST_MS || this.lostReported.has(id)) continue
        this.lostReported.add(id)
        const reason = state.error || (state.state === 'stopped' ? this.lastError : '') || ''
        this.diag.record({ stage: 'lost', step: 'runner_disconnected', machineId: id,
          detail: `Runner not connected for ${Math.round((t - this.lostSince.get(id)) / 60000)}m state=${state.state === 'connected' ? 'heartbeat-stale' : state.state || 'unknown'}${reason ? ` ${reason}` : ''}` })
      }
    }
    void this.diag.flush()
  }
  readState(machineId) {
    try { return JSON.parse(fs.readFileSync(path.join(this.machineDir(machineId), 'state/status.json'), 'utf8')).state || '' } catch { return '' }
  }
  /** Deletion detection: in desktop mode the Runner does not delete files itself (no service manages it), it only writes its state; here the process, folder and record are removed. */
  checkDeleted() {
    for (const id of this.children.keys()) {
      const state = this.readState(id)
      if (state === 'deleting' || state === 'cleanup_pending') this.forget(id)
    }
  }
  forget(machineId) {
    this.stop(machineId)
    setTimeout(() => {
      if (this.children.has(machineId) || this.timers.has(machineId)) return // restored within 4 seconds: the folder belongs to the new connection
      try { fs.rmSync(this.machineDir(machineId), { recursive: true, force: true }) } catch {}
    }, 4000).unref?.()
    this.onDeleted(machineId)
    this.onChange()
  }
  stop(machineId) {
    clearTimeout(this.timers.get(machineId))
    this.timers.delete(machineId)
    const child = this.children.get(machineId)
    this.children.delete(machineId)
    this.keys.delete(machineId)
    if (child?.launchd) { this.stopLaunchd(child.label); return }
    if (!child?.pid) return
    killTree(child.pid, 'SIGTERM')
    setTimeout(() => killTree(child.pid, 'SIGKILL'), 3000).unref?.()
  }
  stopAll() {
    this.stopping = true
    for (const id of [...this.children.keys(), ...this.timers.keys()]) {
      // A launchd-managed Runner keeps running after the app quits; only the app's own bookkeeping is released here.
      if (this.children.get(id)?.launchd) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.children.delete(id); this.keys.delete(id) } else this.stop(id)
    }
  }
}

function launchctl(args) { return execFileSync('/bin/launchctl', args, { stdio: 'pipe', timeout: 10_000 }) }
function launchdLoaded(label) {
  try { launchctl(['print', `gui/${process.getuid()}/${label}`]); return true } catch { return false }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function killTree(pid, signal) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }) } catch {}
    return
  }
  try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch {} }
}

module.exports = {
  SESSION_COOKIE, rawDeviceId, deviceHash, machineIdOfKey, BindingStore, legacyRunners, uninstallLegacy,
  connectComputer, ensureDaemonScript, RunnerPool, deviceName, deviceOs, newerVersion, exitCodeOf, exitText, killTree, pidAlive,
}
