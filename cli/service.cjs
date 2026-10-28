'use strict'
// Background service for `opentandem run` (the supervisor that keeps one Runner per connection running).
//   macOS    a LaunchAgent (starts at login, restarted by launchd if it exits)
//   Linux    a systemd user service (plus linger, so it keeps running after logout and starts at boot)
//   Windows  a hidden start at login (HKCU Run key that runs a small VBScript without a console window)
// Linux without a systemd user manager (containers, some WSL setups) falls back to a detached process that
// does not start with the computer. `start` turns the start-at-login on; `stop` turns it off.
// Only node: built-in modules are used.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', timeout: 20_000, windowsHide: true, encoding: 'utf8', ...options })
const tryRun = (command, args, options) => { try { run(command, args, options); return true } catch { return false } }
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
const pidFile = spec => path.join(spec.home, 'supervisor.pid')
function supervisorPid(spec) {
  try { const pid = Number(fs.readFileSync(pidFile(spec), 'utf8').trim()); return pidAlive(pid) ? pid : 0 } catch { return 0 }
}

/** Environment the supervisor starts with: the PATH of the shell that ran the command, so agent CLIs are found. */
function serviceEnv(spec) {
  const env = { HOME: os.homedir(), PATH: `${path.dirname(spec.node)}${path.delimiter}${process.env.PATH || ''}`, OPENTANDEM_SERVER: spec.server }
  for (const name of ['USER', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}
const commandLine = spec => [spec.node, spec.launcher, 'run', '--server', spec.server]

// ---------- macOS ----------
const macLabel = spec => `org.opentandem.cli.${spec.instance.replace(/[^\w.-]/g, '_')}`
const macPlist = spec => path.join(os.homedir(), 'Library', 'LaunchAgents', `${macLabel(spec)}.plist`)
const macDomain = () => `gui/${process.getuid()}`
const macLoaded = spec => tryRun('/bin/launchctl', ['print', `${macDomain()}/${macLabel(spec)}`])

function macStart(spec) {
  const env = serviceEnv(spec)
  const log = path.join(spec.home, 'service.log')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>`
    + `<key>Label</key><string>${xml(macLabel(spec))}</string>`
    + `<key>ProgramArguments</key><array>${commandLine(spec).map(a => `<string>${xml(a)}</string>`).join('')}</array>`
    + `<key>WorkingDirectory</key><string>${xml(os.homedir())}</string>`
    + `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>`
    + `<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>`
    // Standard, not the default Background: background jobs are throttled and their network requests stall.
    + `<key>ProcessType</key><string>Standard</string>`
    + `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer></dict></plist>\n`
  const file = macPlist(spec)
  let previous = ''
  try { previous = fs.readFileSync(file, 'utf8') } catch {}
  if (macLoaded(spec)) {
    if (previous === plist) return
    macStop(spec, false)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, plist, { mode: 0o600 })
  run('/bin/launchctl', ['bootstrap', macDomain(), file])
}

function macStop(spec, removeFile = true) {
  tryRun('/bin/launchctl', ['bootout', `${macDomain()}/${macLabel(spec)}`])
  // bootout returns before the job is fully gone; bootstrapping again too early fails with an I/O error.
  for (let i = 0; i < 50 && macLoaded(spec); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (removeFile) fs.rmSync(macPlist(spec), { force: true })
}

// ---------- Linux ----------
const linuxUnit = spec => `opentandem-${spec.instance}.service`
const linuxUnitFile = spec => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', linuxUnit(spec))
const systemdUser = () => tryRun('systemctl', ['--user', 'show-environment'])

function linuxStart(spec) {
  if (!systemdUser()) return detachedStart(spec)
  const env = serviceEnv(spec)
  const quote = value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`
  const unit = `[Unit]\nDescription=OpenTandem (${spec.instance})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n`
    + Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}\n`).join('')
    + `ExecStart=${commandLine(spec).map(quote).join(' ')}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`
  fs.mkdirSync(path.dirname(linuxUnitFile(spec)), { recursive: true })
  fs.writeFileSync(linuxUnitFile(spec), unit, { mode: 0o600 })
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', linuxUnit(spec)])
  run('systemctl', ['--user', 'restart', linuxUnit(spec)])
  // A user service stops with the last login session and waits for a login after boot unless linger is on.
  const user = os.userInfo().username
  if (!tryRun('loginctl', ['--no-ask-password', 'enable-linger', user])) tryRun('sudo', ['-n', 'loginctl', 'enable-linger', user])
}

function linuxStop(spec) {
  if (systemdUser() && fs.existsSync(linuxUnitFile(spec))) {
    tryRun('systemctl', ['--user', 'disable', '--now', linuxUnit(spec)])
    fs.rmSync(linuxUnitFile(spec), { force: true })
    tryRun('systemctl', ['--user', 'daemon-reload'])
  }
  detachedStop(spec)
}

const lingerOff = () => {
  try { return run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']).trim() !== 'yes' } catch { return false }
}

// ---------- Windows ----------
const winValue = spec => `OpenTandem CLI (${spec.instance})`
const winRunKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const winScript = spec => path.join(spec.home, 'start.vbs')

function winStart(spec) {
  // VBScript doubles quotes inside a string literal; the 0 runs it without a window.
  const line = commandLine(spec).map(a => `""${a}""`).join(' ')
  fs.writeFileSync(winScript(spec), `CreateObject("WScript.Shell").Run "${line}", 0, False\r\n`)
  run('reg', ['add', winRunKey, '/v', winValue(spec), '/t', 'REG_SZ', '/d', `wscript.exe "${winScript(spec)}"`, '/f'])
  if (!supervisorPid(spec)) spawn('wscript.exe', [winScript(spec)], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

function winStop(spec) {
  tryRun('reg', ['delete', winRunKey, '/v', winValue(spec), '/f'])
  detachedStop(spec)
}

// ---------- detached fallback ----------
function detachedStart(spec) {
  if (supervisorPid(spec)) return
  const log = fs.openSync(path.join(spec.home, 'service.log'), 'a')
  const [command, ...args] = commandLine(spec)
  spawn(command, args, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...serviceEnv(spec) }, windowsHide: true }).unref()
  fs.closeSync(log)
}

function detachedStop(spec) {
  const pid = supervisorPid(spec)
  if (!pid) return
  if (process.platform === 'win32') { tryRun('taskkill', ['/PID', String(pid), '/T', '/F']); return }
  try { process.kill(pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 50 && pidAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
}

// ---------- public ----------
const platform = process.platform
function start(spec) { platform === 'darwin' ? macStart(spec) : platform === 'win32' ? winStart(spec) : linuxStart(spec) }
function stop(spec) { platform === 'darwin' ? macStop(spec) : platform === 'win32' ? winStop(spec) : linuxStop(spec) }
function restart(spec) {
  if (platform === 'darwin' && macLoaded(spec)) { run('/bin/launchctl', ['kickstart', '-k', `${macDomain()}/${macLabel(spec)}`]); return }
  if (platform === 'linux' && systemdUser() && fs.existsSync(linuxUnitFile(spec))) { run('systemctl', ['--user', 'restart', linuxUnit(spec)]); return }
  stop(spec)
  start(spec)
}
/** Whether start-at-login is on and the supervisor is running. */
function state(spec) {
  const running = !!supervisorPid(spec)
  const autostart = platform === 'darwin' ? fs.existsSync(macPlist(spec))
    : platform === 'win32' ? tryRun('reg', ['query', winRunKey, '/v', winValue(spec)])
    : fs.existsSync(linuxUnitFile(spec))
  return { running, autostart, lingerOff: platform === 'linux' && autostart && lingerOff() }
}

module.exports = { start, stop, restart, state, supervisorPid, pidFile, pidAlive }
