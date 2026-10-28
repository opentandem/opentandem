#!/usr/bin/env node
// OpenTandem command-line launcher.
//
// This is the only file in the npm package and the file the background service starts. On every run it:
//   1. asks the server which CLI, Runner and Node.js versions are current (3 second limit; offline falls back
//      to what is already installed);
//   2. installs the pinned Node.js runtime once (checked against a pinned sha256), so the background service
//      never depends on whichever Node.js happens to be on PATH;
//   3. prepares OpenTandem Service, the program every Runner runs on, the same one the desktop app uses: on macOS
//      the signed OpenTandem Service.app published with the desktop app (checked against the sha256 the server
//      gives), on Windows and Linux a copy of the pinned Node.js named after it;
//   4. downloads the CLI files of the current version into <data>/cli/<version>/ (the previous version is kept);
//   5. runs `opentandem.cjs` on OpenTandem Service and passes the exit code through. Without OpenTandem Service
//      (an older server, or the download failed) it falls back to the pinned Node.js.
// The CLI and the Runner always follow the version the server publishes, so a server rollback rolls them back too.
// Only node: built-in modules are used.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const DEFAULT_SERVER = 'https://opentandem.org'
const CLI_FILES = ['launcher.mjs', 'opentandem.cjs', 'core.cjs', 'service.cjs', 'messages.zh.json']
const args = process.argv.slice(2)

function serverFromArgs() {
  const i = args.indexOf('--server')
  const raw = (i >= 0 ? args[i + 1] : '') || process.env.OPENTANDEM_SERVER || DEFAULT_SERVER
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('https only')
    return url.origin
  } catch {
    console.error(`✗ Invalid server address: ${raw}`)
    process.exit(2)
  }
}

const SERVER = serverFromArgs()
const INSTANCE = (() => { const u = new URL(SERVER); return `${u.hostname}${u.port ? `_${u.port}` : ''}` })()
// Same root the Runner uses for its local conversation database; the CLI only touches its own entries in it.
const ROOT = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'OpenTandem')
  : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenTandem')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opentandem')
const HOME = path.join(ROOT, INSTANCE)
const CLI_DIR = path.join(HOME, 'cli')
const quiet = args[0] === 'run'
const note = message => { if (!quiet) console.error(message) }
// Same language rule as opentandem.cjs (the system display language). The launcher is the only file in the npm package
// and runs before the CLI files exist, so it carries its own few Chinese lines.
const ZH = (() => {
  if (process.env.OPENTANDEM_LOCALE) return /^zh/i.test(process.env.OPENTANDEM_LOCALE)
  try {
    if (process.platform === 'darwin') return /^\s*\(?\s*"?zh/i.test(String(spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 3000 }).stdout || '').replace(/^\(\s*/, ''))
    if (process.platform === 'win32') return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {}
  return /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
})()
const L = (en, zh) => (ZH ? zh : en)

async function getJson(url, ms) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'opentandem-cli' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function download(url, file, ms) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'opentandem-cli' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

const runtimeArch = () => process.arch === 'arm64' ? 'arm64' : 'x64'
const nodeBinary = dir => process.platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')

/** Pinned Node.js runtime under <root>/runtime, shared by every server instance on this computer. */
async function ensureRuntime(node) {
  const target = node?.targets?.[`${process.platform}-${runtimeArch()}`]
  const installed = () => {
    let dirs = []
    try { dirs = fs.readdirSync(path.join(ROOT, 'runtime')).filter(name => name.startsWith('node-v')) } catch {}
    const preferred = node?.version && dirs.find(name => name === `node-v${node.version}-${process.platform}-${runtimeArch()}`)
    const dir = preferred || dirs.sort().reverse()[0]
    return dir && fs.existsSync(nodeBinary(path.join(ROOT, 'runtime', dir))) ? nodeBinary(path.join(ROOT, 'runtime', dir)) : ''
  }
  if (!target) {
    const existing = installed()
    if (existing) return existing
    throw new Error(`No Node.js runtime is available for ${process.platform}-${process.arch}`)
  }
  const dir = path.join(ROOT, 'runtime', `node-v${node.version}-${process.platform}-${runtimeArch()}`)
  if (fs.existsSync(nodeBinary(dir))) return nodeBinary(dir)
  note(L('→ Downloading the Node.js runtime (one time, about 30 MB)…', '→ 正在下载 Node.js 运行环境（只需一次，约 30 MB）…'))
  fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true })
  const stage = fs.mkdtempSync(path.join(ROOT, 'runtime', '.stage-'))
  try {
    const archive = path.join(stage, target.filename)
    await download(`${SERVER}/api/runner-runtime/${runtimeArch()}?platform=${process.platform}`, archive, 600_000)
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    if (digest !== target.sha256) throw new Error('Node.js runtime checksum mismatch')
    // Extract straight into place: Windows refuses to rename a folder of freshly extracted programs
    // while antivirus software is still scanning them ("Access denied").
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir)
    const result = spawnSync('tar', ['-xf', archive, '-C', dir, '--strip-components=1'], { stdio: 'ignore' })
    if (result.status !== 0 || !fs.existsSync(nodeBinary(dir))) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new Error('Cannot extract the Node.js runtime')
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  // Older runtimes are removed once the new one is in place. On Windows a service still running on one
  // keeps its node.exe locked; that folder stays until a later run.
  for (const name of fs.readdirSync(path.join(ROOT, 'runtime'))) {
    if (name.startsWith('node-v') && name !== path.basename(dir)) try { fs.rmSync(path.join(ROOT, 'runtime', name), { recursive: true, force: true }) } catch {}
  }
  return nodeBinary(dir)
}

// Stable paths, so the `opentandem` command and the background service keep working when Node.js is updated.
const SERVICE_APP = path.join(ROOT, 'runtime', 'OpenTandem Service.app')
const serviceBinary = () => process.platform === 'darwin' ? path.join(SERVICE_APP, 'Contents', 'MacOS', 'OpenTandem Service')
  : process.platform === 'win32' ? path.join(ROOT, 'runtime', 'current', 'OpenTandem Service.exe')
  : path.join(ROOT, 'runtime', 'current', 'bin', 'opentandem-service')

/**
 * OpenTandem Service: Node.js under our name, so Activity Monitor, Task Manager, login items and the macOS privacy
 * settings show OpenTandem rather than node. Returns its path, or '' when it is not available.
 */
async function ensureService(node, service) {
  if (process.platform === 'darwin') return ensureMacService(service)
  // Windows and Linux: a copy next to node, so the Runner still finds npm and `node` beside the program it runs on;
  // `current` points at the pinned runtime folder (a junction on Windows, which needs no extra rights).
  const dir = path.dirname(process.platform === 'win32' ? node : path.dirname(node))
  const copy = process.platform === 'win32' ? path.join(dir, 'OpenTandem Service.exe') : path.join(dir, 'bin', 'opentandem-service')
  if (!fs.existsSync(copy)) {
    try { fs.linkSync(node, copy) } catch { fs.copyFileSync(node, copy) }
    if (process.platform !== 'win32') fs.chmodSync(copy, 0o755)
  }
  const current = path.join(ROOT, 'runtime', 'current')
  let points = ''
  try { points = fs.realpathSync(current) } catch {}
  if (points !== fs.realpathSync(dir)) {
    // Only the link itself is removed, never what it points at.
    try { fs.unlinkSync(current) } catch { try { fs.rmdirSync(current) } catch {} }
    fs.symlinkSync(dir, current, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return serviceBinary()
}

/** macOS: the signed app cannot be made here, so it is downloaded once per release and checked against the pinned sha256. */
async function ensureMacService(service) {
  const binary = serviceBinary()
  const marker = path.join(ROOT, 'runtime', 'service.sha256')
  const target = service?.targets?.[`darwin-${runtimeArch()}`]
  let have = ''
  try { have = fs.existsSync(binary) ? fs.readFileSync(marker, 'utf8').trim() : '' } catch {}
  if (!target) return fs.existsSync(binary) ? binary : ''
  if (have === target.sha256) return binary
  note(L('→ Downloading OpenTandem Service (one time, about 40 MB)…', '→ 正在下载 OpenTandem Service（只需一次，约 40 MB）…'))
  fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true })
  const stage = fs.mkdtempSync(path.join(ROOT, 'runtime', '.stage-'))
  try {
    const archive = path.join(stage, 'service.zip')
    await download(target.url, archive, 600_000)
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    if (digest !== target.sha256) throw new Error('OpenTandem Service checksum mismatch')
    // ditto keeps the code signature intact; the zip holds the app and the Node.js license next to it.
    const out = path.join(stage, 'out')
    const result = spawnSync('/usr/bin/ditto', ['-x', '-k', archive, out], { stdio: 'ignore' })
    if (result.status !== 0 || !fs.existsSync(path.join(out, 'OpenTandem Service.app', 'Contents', 'MacOS', 'OpenTandem Service'))) throw new Error('Cannot extract OpenTandem Service')
    // A service still running from the old copy keeps going; launchd starts the new one next time.
    fs.rmSync(SERVICE_APP, { recursive: true, force: true })
    fs.renameSync(path.join(out, 'OpenTandem Service.app'), SERVICE_APP)
    try { fs.renameSync(path.join(out, 'LICENSE-Node.js.txt'), path.join(ROOT, 'runtime', 'LICENSE-Node.js.txt')) } catch {}
    fs.writeFileSync(marker, target.sha256)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return binary
}

/** CLI files of one version; the switch is a rename, so a half-finished download never runs. */
async function ensureCli(version, node) {
  const dir = path.join(CLI_DIR, version)
  if (!fs.existsSync(path.join(dir, 'opentandem.cjs'))) {
    note(L(`→ Updating OpenTandem CLI to ${version}…`, `→ 正在把 OpenTandem 命令行更新到 ${version}…`))
    fs.mkdirSync(CLI_DIR, { recursive: true })
    const stage = fs.mkdtempSync(path.join(CLI_DIR, '.stage-'))
    try {
      for (const name of CLI_FILES) {
        await download(`${SERVER}/api/cli-script?file=${encodeURIComponent(name)}`, path.join(stage, name), 60_000)
        if (/\.(?:c|m)?js$/.test(name) && spawnSync(node, ['--check', path.join(stage, name)], { stdio: 'ignore' }).status !== 0) throw new Error(`Downloaded ${name} is invalid`)
      }
      if (!fs.readFileSync(path.join(stage, 'opentandem.cjs'), 'utf8').includes(`const CLI_VERSION = '${version}'`)) throw new Error('Downloaded CLI version mismatch')
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(stage, dir)
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true })
      throw error
    }
  }
  const previous = currentCli()
  fs.writeFileSync(path.join(CLI_DIR, 'current'), version)
  // The background service always starts the installed launcher, so keep it in step with the CLI.
  fs.copyFileSync(path.join(dir, 'launcher.mjs'), path.join(HOME, 'launcher.mjs'))
  for (const name of fs.readdirSync(CLI_DIR)) {
    if (/^\d+\.\d+\.\d+$/.test(name) && name !== version && name !== previous) fs.rmSync(path.join(CLI_DIR, name), { recursive: true, force: true })
  }
  return dir
}

function currentCli() {
  try {
    const version = fs.readFileSync(path.join(CLI_DIR, 'current'), 'utf8').trim()
    return fs.existsSync(path.join(CLI_DIR, version, 'opentandem.cjs')) ? version : ''
  } catch { return '' }
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  let versions = null
  const installedVersion = currentCli()
  try {
    // The first install has nothing to fall back to, so it waits longer.
    versions = await getJson(`${SERVER}/api/cli-script?versions`, installedVersion ? 3000 : 20_000)
  } catch (error) {
    if (!installedVersion) {
      console.error(L(`✗ Cannot reach ${SERVER} (${error.message}). Check your network and try again.`, `✗ 连不上 ${SERVER}（${error.message}），请检查网络后重试。`))
      process.exit(1)
    }
    note(L(`! ${SERVER} is not reachable; using the installed CLI ${installedVersion}.`, `! 连不上 ${SERVER}，继续使用已安装的命令行 ${installedVersion}。`))
  }
  let node, cliDir
  try {
    node = await ensureRuntime(versions?.node)
    cliDir = versions?.cli ? await ensureCli(versions.cli, node) : path.join(CLI_DIR, installedVersion)
  } catch (error) {
    if (!installedVersion) { console.error(`✗ ${error.message}`); process.exit(1) }
    note(L(`! Update failed (${error.message}); using the installed CLI ${installedVersion}.`, `! 更新失败（${error.message}），继续使用已安装的命令行 ${installedVersion}。`))
    node = node || await ensureRuntime(null)
    cliDir = path.join(CLI_DIR, installedVersion)
  }
  let program = ''
  try { program = await ensureService(node, versions ? versions.service : undefined) } catch (error) { note(L(`! OpenTandem Service is not available (${error.message}); using Node.js.`, `! 取不到 OpenTandem Service（${error.message}），改用 Node.js 运行。`)) }
  if (!program || !fs.existsSync(program)) program = node
  const child = spawn(program, [path.join(cliDir, 'opentandem.cjs'), ...args], {
    stdio: 'inherit',
    // OPENTANDEM_NODE_DIR: the pinned Node.js folder (npm and `node`), which the Runner needs when the program is the macOS app.
    env: { ...process.env, OPENTANDEM_SERVER: SERVER, OPENTANDEM_ROOT: ROOT, OPENTANDEM_HOME: HOME, OPENTANDEM_NODE: program, OPENTANDEM_NODE_DIR: path.dirname(node),
      OPENTANDEM_LAUNCHER: path.join(HOME, 'launcher.mjs'), OPENTANDEM_RUNNER_VERSION: versions?.runner || '' },
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal) } catch {} })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

main().catch(error => { console.error(`✗ ${error.message}`); process.exit(1) })
