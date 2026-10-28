#!/usr/bin/env node
'use strict'
// The `opentandem` command. Started by launcher.mjs, which keeps this file and the Node.js runtime up to date.
//
//   remote                 connect this computer by scanning a QR code with your phone; when it is already
//                          connected, show its status and a QR code that opens OpenTandem on the phone
//   connect --key <key>    connect with the credential from the web page (Settings → Computers → Add a computer);
//                          what the web page's install command runs, so it is not listed in the help
//   list                   the Runners on this computer (one per workspace), their ids and whether each is online
//   start | stop | restart [<id> | all]
//                          one Runner, or all of them (`all` also turns start at login on or off); without an id
//                          the only Runner, and a list to choose from when there are several
//   logs [<id>] [-f]       latest Runner log lines, or follow them
//   update                 update the CLI and the Runner now and restart the service
//   uninstall              remove the service and the program; the local conversation history stays
//   run                    the background service itself (started by launchd, systemd or the login item)
//
// One background supervisor per server keeps one Runner per connection (core.cjs RunnerPool); the Runner
// updates itself, the CLI is updated by the launcher. Everything runs on OpenTandem Service, the same program the
// desktop app uses (see launcher.mjs). A computer has one manager per server: when the desktop app already
// connects it, this command only shows its state and leaves the rest to the app.
// Only node: built-in modules are used.
const CLI_VERSION = '0.3.2'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const core = require('./core.cjs')
const service = require('./service.cjs')

const argv = process.argv.slice(2)
const VALUE_OPTIONS = new Set(['server', 'key', 'machine'])
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] || '' : '' }
const has = (...names) => names.some(name => argv.includes(name))
const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && VALUE_OPTIONS.has(argv[i - 1].replace(/^--/, ''))))

const SERVER = new URL(option('server') || process.env.OPENTANDEM_SERVER || 'https://opentandem.org').origin
const INSTANCE = (() => { const u = new URL(SERVER); return `${u.hostname}${u.port ? `_${u.port}` : ''}` })()
const ROOT = process.env.OPENTANDEM_ROOT || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'OpenTandem')
  : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenTandem')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opentandem'))
const HOME = process.env.OPENTANDEM_HOME || path.join(ROOT, INSTANCE)
const NODE = process.env.OPENTANDEM_NODE || process.execPath
// The pinned Node.js folder (npm and `node`); on macOS OpenTandem Service is an app bundle without them.
const NODE_DIR = process.env.OPENTANDEM_NODE_DIR || path.dirname(NODE)
const LAUNCHER = process.env.OPENTANDEM_LAUNCHER || path.join(HOME, 'launcher.mjs')
const RUNNER_DIR = path.join(HOME, 'runner')
const SOURCE_REPO = 'https://github.com/opentandem/opentandem'
const SPEC = { server: SERVER, instance: INSTANCE, home: HOME, node: NODE, nodeDir: NODE_DIR, launcher: LAUNCHER }

// ---------- text ----------
function zhLocale() {
  const forced = process.env.OPENTANDEM_LOCALE
  if (forced) return /^zh/i.test(forced)
  try {
    if (process.platform === 'darwin') return /^\s*\(?\s*"?zh/i.test(execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 3000 }).replace(/^\(\s*/, ''))
    if (process.platform === 'win32') return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {}
  return /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
}
const ZH = zhLocale() ? (() => { try { return require('./messages.zh.json') } catch { return {} } })() : {}
const t = (text, vars = {}) => (ZH[text] || text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
const say = (text, vars) => console.log(t(text, vars))
const fail = (text, vars) => { console.error(`✗ ${t(text, vars)}`); process.exit(1) }

// ---------- helpers ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const openStore = () => new core.BindingStore(path.join(HOME, 'connection.json'), SERVER, core.deviceHash(SERVER))
const shortOs = () => `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'} ${os.arch()}`

async function post(route, body, cookie = '') {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `opentandem-cli/${CLI_VERSION}` }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(`${SERVER}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) }
}

function runnerStatus(machineId, dir = RUNNER_DIR) {
  let status = {}
  try { status = JSON.parse(fs.readFileSync(path.join(dir, machineId, 'state', 'status.json'), 'utf8')) } catch {}
  // A Runner killed hard (Windows `stop`) cannot mark itself stopped, so a recent heartbeat alone is not enough.
  const online = status.state === 'connected' && Date.now() - Date.parse(status.last_heartbeat_at || '') < 60_000 && core.pidAlive(status.pid)
  return { online, version: status.version || '', error: status.error || '' }
}

/**
 * The desktop app's connections to this server, when it is installed and connected (any of its builds). The app and this
 * command compute the same device id, so connecting both to one workspace would make each revoke the other's credential.
 */
function desktopConnection() {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) : ''
  if (!base) return null
  for (const name of ['opentandem-desktop', 'opentandem-desktop-staging', 'opentandem-desktop-local']) {
    const dir = path.join(base, name)
    const bindings = new core.BindingStore(path.join(dir, 'connection.json'), SERVER, core.deviceHash(SERVER)).bindings.filter(b => !b.disconnected)
    if (bindings.length) return { dir, runnerDir: path.join(dir, 'runner'), bindings }
  }
  return null
}

/** Commands that change the background service belong to the app when the app manages this computer: point there and stop. */
function leaveToDesktop() {
  if (openStore().bindings.length || !desktopConnection()) return
  say('→ This computer is managed by the OpenTandem app. Open the OpenTandem app on this computer to start, stop or disconnect it.')
  process.exit(0)
}

/** Newest Runner downloaded on this computer, or '' before the first download. */
function latestRunner() {
  try {
    return fs.readdirSync(path.join(RUNNER_DIR, 'daemon')).map(n => (/^machine-daemon-(\d+\.\d+\.\d+)\.mjs$/.exec(n) || [])[1]).filter(Boolean)
      .reduce((best, v) => (!best || core.newerVersion(v, best) ? v : best), '')
  } catch { return '' }
}

/** QR codes come from the server already laid out as text; paint them dark-on-light so phones read them on any terminal theme. */
function printQr(qr) {
  const lines = String(qr).replace(/\n+$/, '').split('\n')
  if (!process.stdout.isTTY) { console.log(lines.join('\n')); return }
  for (const line of lines) console.log(`  \x1b[30;107m${line}\x1b[0m`)
}

/** The `opentandem` command on PATH: the installed launcher with the pinned runtime, defaulting to this server. */
function installCommand() {
  if (process.platform === 'win32') {
    const dir = path.join(ROOT, 'bin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'opentandem.cmd'), `@setlocal\r\n@if not defined OPENTANDEM_SERVER set "OPENTANDEM_SERVER=${SERVER}"\r\n@"${NODE}" "${LAUNCHER}" %*\r\n`)
    const current = (() => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim() } catch { return null } })()
    if (current !== null && !current.split(';').some(p => p.toLowerCase() === dir.toLowerCase())) {
      const next = current ? `${current};${dir}` : dir
      try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path', $env:OT_PATH, 'User')`], { env: { ...process.env, OT_PATH: next }, windowsHide: true, timeout: 15_000 }) } catch {}
    }
    return dir
  }
  const dir = path.join(os.homedir(), '.local', 'bin')
  fs.mkdirSync(dir, { recursive: true })
  const quoted = value => `'${String(value).replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(path.join(dir, 'opentandem'), `#!/bin/sh\nOPENTANDEM_SERVER="\${OPENTANDEM_SERVER:-${SERVER}}" exec ${quoted(NODE)} ${quoted(LAUNCHER)} "$@"\n`, { mode: 0o755 })
  return dir
}

function pathHint(dir) {
  const onPath = (process.env.PATH || '').split(path.delimiter).some(p => path.resolve(p) === path.resolve(dir))
  if (onPath) return
  // On Windows installCommand has already added the folder to the user PATH; only windows opened from now on see it.
  if (process.platform === 'win32') say('Open a new terminal window to run `opentandem` directly (this window does not see the new PATH yet).')
  else say('Tip: add {dir} to your PATH to run `opentandem` directly, or keep using `npx opentandem@latest <command>`.', { dir })
}

/** After a successful connection, list the everyday commands in the system language. */
function commandHint() {
  console.log(`
${t('Manage this computer with:')}
  opentandem list                      ${t('List the Runners on this computer and whether each is online')}
  opentandem stop | start | restart    ${t('Stop, start or restart (add an id for one Runner, or all)')}
  opentandem logs                      ${t('Show recent logs (add -f to keep watching)')}
  opentandem uninstall                 ${t('Remove OpenTandem from this computer; your local chat history stays')}`)
}

/** Download the Runner the server currently publishes when it is newer than the newest local copy. */
async function updateRunner() {
  const want = process.env.OPENTANDEM_RUNNER_VERSION || ''
  const daemonDir = path.join(RUNNER_DIR, 'daemon')
  fs.mkdirSync(daemonDir, { recursive: true })
  const have = fs.readdirSync(daemonDir).map(n => (/^machine-daemon-(\d+\.\d+\.\d+)\.mjs$/.exec(n) || [])[1]).filter(Boolean)
    .reduce((best, v) => (!best || core.newerVersion(v, best) ? v : best), '')
  if (want && have && !core.newerVersion(want, have)) return have
  const script = await core.ensureDaemonScript(SERVER, daemonDir)
  if (!want || !core.newerVersion(want, script.version)) return script.version
  const response = await fetch(`${SERVER}/api/daemon-script`, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Runner download failed (HTTP ${response.status})`)
  const source = await response.text()
  if (!source.includes(`const DAEMON_VERSION = '${want}'`)) throw new Error('Runner download is invalid')
  const target = path.join(daemonDir, `machine-daemon-${want}.mjs`)
  fs.writeFileSync(`${target}.tmp`, source, { mode: 0o700 })
  fs.renameSync(`${target}.tmp`, target)
  return want
}

/** Install the command and the background service, then wait until a Runner reports online. */
async function bringOnline(store, label) {
  const dir = installCommand()
  await updateRunner().catch(error => say('! Runner update failed: {error}', { error: error.message }))
  service.start(SPEC)
  const ids = store.bindings.map(b => b.machineId)
  for (let waited = 0; waited < 60; waited++) {
    if (ids.some(id => runnerStatus(id).online)) {
      if (label) say('✓ Connected to "{team}" as {name}', label)
      say('✓ Runs in the background and starts with your computer')
      if (service.state(SPEC).lingerOff) say('To stay online after you log out, run: sudo loginctl enable-linger {user}', { user: os.userInfo().username })
      pathHint(dir)
      commandHint()
      return true
    }
    await sleep(1000)
  }
  console.error(`✗ ${t('Not online within 60 seconds. Recent log:')}`)
  for (const id of ids) tail(path.join(RUNNER_DIR, id, 'runner.log'), 20)
  return false
}

function tail(file, lines) {
  try { console.error(fs.readFileSync(file, 'utf8').split('\n').slice(-lines - 1).join('\n')) } catch {}
}

function connectError(error) {
  if (error.code === 'admin_only') fail('Only workspace admins can connect computers.')
  if (error.code === 'link_expired') fail('This command has expired. Copy it again from the web page.')
  if (error.code === 'device_mismatch') fail('This command belongs to another computer. Use Add a computer on the web to connect this one.')
  fail('Connection failed: {error}', { error: error.message })
}

/** The app already connects this computer to this server: connecting again would replace the app's credential, so point to the app. */
async function showDesktop() {
  say('✓ This computer is already connected through the OpenTandem app, so there is no need to connect it from the command line.')
  say('  Open the OpenTandem app on this computer to use and manage it.\n')
  list()
  const r = await post('/api/auth/agent-pair', { action: 'app_qr' }).catch(() => null)
  if (r?.ok && r.data.qr) {
    say('Scan to open OpenTandem on your phone:')
    printQr(r.data.qr)
    console.log(`  ${r.data.url}`)
  }
}

/** Rewrite the command and the background service so they start the current program, then restart it. */
function refreshService() {
  installCommand()
  service.start(SPEC)
  if (process.platform !== 'linux') service.restart(SPEC)
}

// ---------- commands ----------
async function remote() {
  const store = openStore()
  if (!store.bindings.length && desktopConnection()) return showDesktop()
  if (store.bindings.length) {
    if (!service.state(SPEC).running) await bringOnline(store, null)
    say('✓ This computer is already connected, so there is nothing to scan. The QR code below opens OpenTandem on your phone.\n')
    list(store)
    const r = await post('/api/auth/agent-pair', { action: 'app_qr' }).catch(() => null)
    if (r?.ok && r.data.qr) {
      say('Scan to open OpenTandem on your phone:')
      printQr(r.data.qr)
      console.log(`  ${r.data.url}`)
    }
    return
  }

  console.log('\n  OpenTandem')
  // The Runner is needed anyway once connected; download it while the phone is not involved yet.
  await updateRunner().catch(() => {})
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const start = await post('/api/auth/agent-pair', { action: 'start', challenge, device_name: core.deviceName(), os: shortOs() })
    .catch(error => fail('Cannot reach {server} ({error}).', { server: SERVER, error: error.message }))
  if (!start.ok) fail(start.data.reason === 'rate' ? 'Too many attempts from this network. Try again in 10 minutes.' : 'Cannot start pairing (HTTP {status}).', { status: start.status })
  say('  Scan with your phone to sign in and allow this computer:')
  printQr(start.data.qr)
  console.log(`  ${start.data.url}\n`)
  say('  Waiting for your phone… (valid for 10 minutes)')

  const deadline = Date.now() + 10 * 60_000
  let allowed = null
  while (Date.now() < deadline && !allowed) {
    await sleep(2000)
    const r = await post('/api/auth/agent-pair', { action: 'poll', code: start.data.code, verifier }).catch(() => null)
    if (!r?.ok) continue
    if (r.data.state === 'denied') fail('Denied on the phone. Nothing was connected.')
    if (r.data.state === 'expired') fail('The QR code has expired. Run the command again.')
    if (r.data.state === 'allowed' && r.data.session) allowed = r.data
  }
  if (!allowed) fail('The QR code has expired. Run the command again.')

  // The session is used once to register this computer and is signed out right after.
  const cookie = `${core.SESSION_COOKIE}=${allowed.session}`
  const result = await core.connectComputer({ server: SERVER, cookie, device: store.device }).catch(error => ({ error }))
  await post('/api/auth/logout', {}, cookie).catch(() => {})
  if (result.error) connectError(result.error)
  const name = result.name || core.deviceName()
  store.put({ ...result.binding, name, team: allowed.team || '', account: allowed.email || '' })
  if (result.legacyRemoved) say('✓ Took over the Runner installed earlier on this computer')
  if (!(await bringOnline(store, { team: allowed.team || SERVER, name }))) process.exit(1)
  say('  Open OpenTandem on your phone, pick this computer and send a task.')
}

async function connect() {
  const key = option('key') || positional[1] || ''
  if (!core.machineIdOfKey(key)) fail('Invalid credential. Copy the command from the web page again.')
  const store = openStore()
  if (!store.bindings.length && desktopConnection()) return showDesktop()
  // A credential is replaced on first use: running the same command again reconnects with the stored one.
  const done = store.bindings.find(b => b.machineId === core.machineIdOfKey(key))
  const attempt = linkKey => core.connectComputer({ server: SERVER, linkKey, device: store.device })
  const result = await attempt(key).catch(error => {
    if (error.code === 'link_expired' && done) return attempt(done.key)
    throw error
  }).catch(connectError)
  const name = result.name || core.deviceName()
  store.put({ ...result.binding, name })
  if (result.legacyRemoved) say('✓ Took over the Runner installed earlier on this computer')
  if (!(await bringOnline(store, { team: SERVER, name }))) process.exit(1)
}

function list(store = openStore()) {
  if (!store.bindings.length) {
    const desktop = desktopConnection()
    if (!desktop) { say('This computer is not connected to {server}. Run `opentandem remote` to connect it.', { server: SERVER }); return }
    say('Server: {server}', { server: SERVER })
    say('Managed by the OpenTandem app ({dir})', { dir: desktop.dir })
    for (const b of desktop.bindings) {
      const s = runnerStatus(b.machineId, desktop.runnerDir)
      console.log(`  ${s.online ? '●' : '○'} ${b.name || b.machineId}  ${t(s.online ? 'online' : 'offline')}  ${b.machineId}${s.version ? `  Runner ${s.version}` : ''}`)
    }
    return
  }
  const svc = service.state(SPEC)
  say('Server: {server}', { server: SERVER })
  say(svc.running ? 'Background service: running' : 'Background service: stopped (run `opentandem start`)')
  for (const b of store.bindings) {
    const s = runnerStatus(b.machineId)
    const where = [b.team && `"${b.team}"`, b.account].filter(Boolean).join(' · ')
    const state = b.paused ? t('stopped') : t(s.online ? 'online' : 'offline')
    console.log(`  ${s.online && !b.paused ? '●' : '○'} ${b.machineId}  ${state}  ${b.name || ''}  ${where}${s.version ? `  Runner ${s.version}` : ''}`)
    if (!s.online && s.error) console.log(`      ${s.error}`)
  }
}

function needConnection() {
  if (!openStore().bindings.length) fail('This computer is not connected yet. Run `opentandem remote` first.')
}

async function logs() {
  const store = openStore()
  const desktop = store.bindings.length ? null : desktopConnection()
  const id = (positional[1] || '').toLowerCase()
  const own = store.bindings.filter(b => b.machineId.startsWith(id))
  const files = (desktop ? desktop.bindings.filter(b => b.machineId.startsWith(id)).map(b => path.join(desktop.runnerDir, b.machineId, 'runner.log'))
    : [...own.map(b => path.join(RUNNER_DIR, b.machineId, 'runner.log')), ...(id ? [] : [path.join(HOME, 'service.log')])]).filter(f => fs.existsSync(f))
  if (!files.length) { say('No logs yet.'); return }
  for (const file of files) { console.log(`==> ${file} <==`); try { console.log(fs.readFileSync(file, 'utf8').split('\n').slice(-51).join('\n')) } catch {} }
  if (!has('-f', '--follow')) return
  const sizes = new Map(files.map(f => [f, fs.statSync(f).size]))
  setInterval(() => {
    for (const file of files) {
      let size = 0
      try { size = fs.statSync(file).size } catch { continue }
      const from = size < sizes.get(file) ? 0 : sizes.get(file)
      if (size > from) {
        const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(size - from)
        fs.readSync(fd, buffer, 0, buffer.length, from)
        fs.closeSync(fd)
        process.stdout.write(buffer)
      }
      sizes.set(file, size)
    }
  }, 1000)
}

/**
 * The Runner a start/stop/restart targets: an id (or a unique start of it); null means all of them, which is also what
 * a computer with a single Runner gets without an id. With several Runners and no id, list them and ask.
 */
function pickRunner(store, verb) {
  const arg = (positional[1] || '').toLowerCase()
  if (arg === 'all' || (!arg && store.bindings.length === 1)) return null
  if (!arg) {
    say('This computer has several Runners. Add an id for one of them, or all: opentandem {verb} <id> | all', { verb })
    list(store)
    process.exit(2)
  }
  const found = store.bindings.filter(b => b.machineId.startsWith(arg))
  if (found.length > 1) fail('More than one Runner id starts with {id}. Type more of it.', { id: arg })
  if (!found.length) fail('No Runner with id {id}. Run `opentandem list` to see the ids.', { id: arg })
  return found[0]
}

/** One Runner is stopped by a flag in connection.json; the supervisor follows the file within 2 seconds. */
function setPaused(store, binding, paused) {
  binding.paused = paused || undefined
  store.save()
}

function startCommand() {
  leaveToDesktop()
  needConnection()
  const store = openStore()
  const target = pickRunner(store, 'start')
  for (const b of target ? [target] : store.bindings) if (b.paused) setPaused(store, b, false)
  installCommand()
  if (!target || !service.state(SPEC).running) service.start(SPEC)
  if (target) say('✓ Started {id}.', { id: target.machineId })
  else say('✓ Started. It also starts with your computer.')
}

function stopCommand() {
  leaveToDesktop()
  needConnection()
  const store = openStore()
  const target = pickRunner(store, 'stop')
  if (!target) { service.stop(SPEC); say('✓ Stopped. It will not start with your computer until you run `opentandem start`.'); return }
  setPaused(store, target, true)
  say('✓ Stopped {id}; the other Runners keep running. Run `opentandem start {id}` to start it again.', { id: target.machineId })
}

function restartCommand() {
  leaveToDesktop()
  needConnection()
  const store = openStore()
  const target = pickRunner(store, 'restart')
  if (!target) { refreshService(); say('✓ Restarted.'); return }
  if (target.paused) setPaused(store, target, false)
  else {
    // The supervisor starts a Runner that exited again within 5 seconds.
    try {
      const pid = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, target.machineId, 'state', 'status.json'), 'utf8')).pid
      if (core.pidAlive(pid)) core.killTree(pid, 'SIGTERM')
    } catch {}
  }
  if (!service.state(SPEC).running) service.start(SPEC)
  say('✓ Restarted {id}.', { id: target.machineId })
}

async function update() {
  leaveToDesktop()
  const version = await updateRunner().catch(error => fail('Runner update failed: {error}', { error: error.message }))
  if (openStore().bindings.length && service.state(SPEC).autostart) refreshService()
  say('✓ Up to date: CLI {cli}, Runner {runner}', { cli: CLI_VERSION, runner: version })
}

function uninstall() {
  service.stop(SPEC)
  // Only the CLI's own entries: the Runner's local conversation database in the same folder stays.
  for (const name of ['connection.json', 'runner', 'cli', 'client', 'launcher.mjs', 'service.log', 'supervisor.pid', 'start.vbs']) {
    fs.rmSync(path.join(HOME, name), { recursive: true, force: true })
  }
  const others = (() => { try { return fs.readdirSync(ROOT).filter(n => fs.existsSync(path.join(ROOT, n, 'launcher.mjs'))) } catch { return [] } })()
  if (!others.length && process.platform === 'win32') removeAfterExit([path.join(ROOT, 'runtime'), path.join(ROOT, 'bin')], path.join(ROOT, 'bin'))
  else if (!others.length) {
    fs.rmSync(path.join(ROOT, 'runtime'), { recursive: true, force: true })
    fs.rmSync(path.join(os.homedir(), '.local', 'bin', 'opentandem'), { force: true })
  }
  say('✓ OpenTandem was removed from this computer. Your local conversation history is kept in {dir}.', { dir: HOME })
  say('To remove this computer from the workspace too, delete it on the web under Settings → Computers.')
}

/**
 * Windows cannot delete node.exe while this command still runs on it: a hidden PowerShell removes the folders once it exits.
 * Started through Start-Process: a `detached` spawn never runs there, and a plain child dies with Node's job object.
 */
function removeAfterExit(dirs, pathEntry) {
  const q = value => `'${value.replace(/'/g, "''")}'`
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($p) { [Environment]::SetEnvironmentVariable('Path', ((($p -split ';') | Where-Object { $_ -and $_ -ne ${q(pathEntry)} }) -join ';'), 'User') }`,
    `for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 1; Remove-Item -Recurse -Force ${dirs.map(q).join(', ')}; if (-not (${dirs.map(d => `(Test-Path ${q(d)})`).join(' -or ')})) { break } }`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`],
  { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
}

/**
 * PATH for the Runners: the program's folder first (as before), the pinned Node.js folder last when it is a different
 * folder (macOS), so the Runner's one-click installs find npm and `node` without shadowing the user's own Node.js.
 */
function runnerPath() {
  const parts = [path.dirname(NODE), ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)]
  if (!parts.includes(NODE_DIR)) parts.push(NODE_DIR)
  return parts.join(path.delimiter)
}

/** The background supervisor: one Runner per connection, following connection.json. */
function supervise() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const other = service.supervisorPid(SPEC)
  if (other && other !== process.pid) { console.log(`[opentandem] another supervisor is running (pid ${other}); exiting`); process.exit(0) }
  fs.writeFileSync(service.pidFile(SPEC), String(process.pid))
  let store = openStore()
  // A supervisor that was killed hard leaves its Runners behind; stop them so a machine never runs twice.
  for (const b of store.bindings) {
    try {
      const pid = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, b.machineId, 'state', 'status.json'), 'utf8')).pid
      if (core.pidAlive(pid) && pid !== process.pid) core.killTree(pid, 'SIGTERM')
    } catch {}
  }
  let mtime = 0
  const file = path.join(HOME, 'connection.json')
  const pool = new core.RunnerPool({
    server: SERVER, directory: RUNNER_DIR, node: { command: NODE },
    env: { PATH: runnerPath() },
    onDeleted: machineId => { store.remove(machineId); console.log(`[opentandem] machine ${machineId} was deleted on the web; connection removed`) },
  })
  const reload = () => {
    let next = 0
    try { next = fs.statSync(file).mtimeMs } catch {}
    if (next !== mtime) { mtime = next; store = openStore() }
    pool.sync(store.bindings.filter(b => !b.paused))
    pool.checkDeleted()
  }
  updateRunner().catch(error => console.log(`[opentandem] runner update skipped: ${error.message}`)).finally(() => {
    reload()
    setInterval(reload, 2000)
  })
  const stop = () => {
    pool.stopAll()
    try { if (Number(fs.readFileSync(service.pidFile(SPEC), 'utf8')) === process.pid) fs.rmSync(service.pidFile(SPEC)) } catch {}
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', stop)
}

function help() {
  console.log(`OpenTandem CLI ${CLI_VERSION}

${t('Usage')}: opentandem <command> [--server <url>]

  remote                             ${t('Connect this computer by scanning a QR code with your phone')}
  list                               ${t('List the Runners on this computer, their ids and whether each is online')}
  start | stop | restart [<id>|all]  ${t('One Runner, or all of them (all also turns start at login on or off)')}
  logs [<id>] [-f]                   ${t('Show the latest log lines, or follow them')}
  update                             ${t('Update the CLI and the Runner now')}
  uninstall                          ${t('Remove the service and the program; local history stays')}
`)
}

function version() {
  const runner = latestRunner()
  console.log(`opentandem CLI ${CLI_VERSION}${runner ? `, Runner ${runner}` : ''} (${SERVER})`)
  // Each released version is tagged in the open-source repository, so the code that runs here can be read there.
  console.log(`Source: ${SOURCE_REPO}/tree/cli-v${CLI_VERSION}/cli${runner ? `  ${SOURCE_REPO}/tree/runner-v${runner}/runner` : ''}`)
}

/**
 * `schedule` and `conversation` belong to the Runner's own entry point (~/.sophon/bin/opentandem), which agents without
 * MCP call by bare name. When this command comes first on their PATH, hand the call over unchanged.
 */
function forwardToRunner() {
  const wrapper = path.join(os.homedir(), '.sophon', 'bin', 'opentandem')
  if (!fs.existsSync(wrapper)) fail('`opentandem {command}` is available to agents while a Runner is running on this computer.', { command: positional[0] })
  const result = require('node:child_process').spawnSync(wrapper, argv, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

async function main() {
  if (['schedule', 'conversation'].includes(positional[0])) return forwardToRunner()
  const command = has('--version', '-v') ? 'version' : has('--help', '-h') ? 'help' : positional[0] || 'help'
  switch (command) {
    case 'remote': return remote()
    case 'connect': return connect()
    case 'list': return list()
    case 'start': return startCommand()
    case 'stop': return stopCommand()
    case 'restart': return restartCommand()
    case 'logs': return logs()
    case 'update': return update()
    case 'uninstall': return uninstall()
    case 'run': return supervise()
    case 'version': return version()
    case 'help': return help()
    default: console.error(t('Unknown command: {command}', { command })); help(); process.exit(2)
  }
}

main().catch(error => { console.error(`✗ ${error.message}`); process.exit(1) })
