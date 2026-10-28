import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createP2PRunner } from '../core/runner-p2p.mjs'
import { isSensitiveArtifact } from '../core/artifact-refs.mjs'
import { p2pPackChunk, P2P_MAX_FILE_BYTES, P2P_MAX_DOWNLOAD_BYTES } from '../core/file-transport-protocol.mjs'

class Channel {
  messages: { t?: string; code?: string; id?: number; path: string; size?: number }[] = []
  binary: Uint8Array[] = []
  open = true
  receive: (data: string | Uint8Array) => Promise<void> = async () => {}
  closed = () => {}
  getLabel() { return 'ot-file' }
  setBufferedAmountLowThreshold() {}
  onBufferedAmountLow() {}
  onOpen(cb: () => void) { cb() }
  onClosed(cb: () => void) { this.closed = cb }
  onMessage(cb: typeof this.receive) { this.receive = cb }
  isOpen() { return this.open }
  bufferedAmount() { return 0 }
  sendMessage(data: string) { this.messages.push(JSON.parse(data)) }
  sendMessageBinary(data: Uint8Array) { this.binary.push(data) }
  close() { if (this.open) { this.open = false; this.closed() } }
  async send(data: object) { await this.receive(JSON.stringify(data)); return this.messages.at(-1)! }
}
const channels: Channel[] = []
class PeerConnection {
  channel = new Channel()
  attach: (channel: Channel) => void = () => {}
  gathered: (state: string) => void = () => {}
  constructor() { channels.push(this.channel) }
  onStateChange() {}
  onDataChannel(cb: typeof this.attach) { this.attach = cb }
  onGatheringStateChange(cb: typeof this.gathered) { this.gathered = cb }
  setRemoteDescription() { this.attach(this.channel); this.gathered('complete') }
  localDescription() { return { sdp: 'local test transport' } }
  gatheringState() { return 'complete' }
  close() { this.channel.close() }
}

// This table stands in for the server's artifact records (attachments + artifact_offers).
const serverRecords = new Map<string, string[]>()
function recordArtifacts(instance: ReturnType<typeof createP2PRunner>, task: string, paths: string[]) {
  serverRecords.set(task, [...(serverRecords.get(task) || []), ...paths])
  instance.forgetTaskArtifacts(task)
}
let root: string
let wd: string
let runner: ReturnType<typeof createP2PRunner>
const runners: ReturnType<typeof createP2PRunner>[] = []
let serial = 0
function makeRunner() {
  const instance = createP2PRunner({
    machineId: 'machine', daemonVersion: 'test', verifyTicket: JSON.parse,
    // Production resolution searches ancestors up to the Git root.
    artifactRoots: () => [wd, root],
    resolveArtifactAbs: (ref: string, roots: string[]) => path.isAbsolute(ref) ? ref : roots.map(p => path.resolve(p, ref)).find(p => fs.existsSync(p)),
    isSensitive: isSensitiveArtifact,
    mimeFor: () => 'application/octet-stream',
    taskArtifacts: async (task: string) => [...(serverRecords.get(task) || [])],
  })
  instance.configure({ enabled: true, max_peers: 16 })
  runners.push(instance)
  return instance
}
async function connect(instance = runner, task = 'task', extra = {}) {
  const sid = (++serial).toString(16).padStart(18, '0')
  await instance.handleOffer({ session_id: sid, sdp: 'test', ice_servers: [] })
  const dc = channels.at(-1)!
  await dc.send({ t: 'hello', ticket: JSON.stringify({ use: 'p2p', mid: 'machine', sid, task, wd, up: true, down: true, exp: Date.now() + 60_000, ...extra }) })
  return dc
}
function file(relative: string, contents = 'local fixture') {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}
async function flush() { await new Promise(resolve => setTimeout(resolve, 15)) }
const uploads = () => path.join(wd, '.sophon', 'uploads', 'task')

beforeEach(() => {
  // Outside the package: other suites walk runner/ in parallel and must not see these files.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-security-')))
  wd = path.join(root, 'project')
  fs.mkdirSync(wd)
  vi.stubEnv('OPENTANDEM_P2P_NATIVE', '/local-unit-test-native')
  vi.spyOn(process, 'dlopen').mockImplementation(mod => { (mod as { exports: unknown }).exports = { PeerConnection } })
  serverRecords.clear()
  runner = makeRunner()
})
afterEach(async () => {
  for (const instance of runners.splice(0)) instance.close()
  await flush()
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('transferBusy (self-update waits for it)', () => {
  it('ignores keepalive pings on an open page and counts real file requests and chunks', async () => {
    const dc = await connect()
    for (let n = 1; n <= 3; n++) expect((await dc.send({ t: 'ping', n })).t).toBe('pong')
    expect(runner.transferBusy(60_000)).toBe(false)
    file('project/shown.txt', 'shown')
    expect((await dc.send({ t: 'stat', id: 1, task: 'task', path: 'shown.txt' })).t).toBe('stat_ok')
    expect(runner.transferBusy(60_000)).toBe(true)
    expect(runner.transferBusy(0)).toBe(false)
  })

  it('counts an incoming chunk, even on a channel that has only pinged so far', async () => {
    const dc = await connect()
    await dc.send({ t: 'ping', n: 1 })
    expect(runner.transferBusy(60_000)).toBe(false)
    await dc.receive(p2pPackChunk(99, new Uint8Array([1, 2, 3])))
    expect(runner.transferBusy(60_000)).toBe(true)
  })
})

describe('P2P read authorization independent of path resolution', () => {
  it('authorizes files outside the workdir from server records, also after a Runner restart', async () => {
    const outside = file('elsewhere/shot.png', 'png bytes')
    const stranger = file('elsewhere/other.png', 'png bytes')
    recordArtifacts(runner, 'task', [outside])
    expect((await (await connect()).send({ t: 'stat', id: 1, path: outside })).t).toBe('stat_ok')
    const restarted = makeRunner()
    const dc = await connect(restarted)
    expect((await dc.send({ t: 'stat', id: 2, path: outside })).t).toBe('stat_ok')
    expect(await dc.send({ t: 'stat', id: 3, path: stranger })).toMatchObject({ t: 'err', code: 'forbidden' })
  })
  it('separates preview and raw bytes, with the same task authorization for inline images', async () => {
    const bytes = Buffer.alloc(70 * 1024, 3)
    const source = `<h1>Book</h1><img src="data:image/png;base64,${bytes.toString('base64')}">`
    const report = file('reports/book.html', source)
    recordArtifacts(runner, 'task', [report])
    const dc = await connect()
    const raw = await dc.send({ t: 'stat', id: 1, path: report })
    expect(raw.size).toBe(Buffer.byteLength(source))
    const preview = await dc.send({ t: 'stat', id: 2, path: report, view: 'document' })
    expect(preview.size).toBeLessThan(1500)
    const id = crypto.createHash('sha256').update(bytes).digest('hex')
    expect(await dc.send({ t: 'stat', id: 3, path: report, view: `image:${id}` })).toMatchObject({ t: 'stat_ok', size: bytes.length })
    expect(await dc.send({ t: 'get', id: 4, path: report, view: `image:${id}`, offset: 0, length: bytes.length })).toMatchObject({ t: 'end' })
    const other = await connect(runner, 'other')
    expect(await other.send({ t: 'stat', id: 5, path: report, view: `image:${id}` })).toMatchObject({ t: 'err', code: 'forbidden' })
    expect(await dc.send({ t: 'stat', id: 6, path: report, view: 'image:' + '0'.repeat(64) })).toMatchObject({ t: 'err', code: 'not_found' })
  })
  it('allows absolute and file-URL references only within the reported HTML directory', async () => {
    const picture = file('reports/one.png')
    const outside = file('private-project/outside.png')
    const report = file('reports/book.html', `<img src="file://${picture}"><img src="${outside}">`)
    recordArtifacts(runner, 'task', [report])
    const dc = await connect()
    expect(await dc.send({ t: 'stat', id: 1, path: picture })).toMatchObject({ t: 'stat_ok' })
    expect(await dc.send({ t: 'stat', id: 2, path: outside })).toMatchObject({ t: 'err', code: 'forbidden' })
  })
  it('allows working files but rejects absolute and repo-relative sibling files', async () => {
    const own = file('project/readme.md')
    const sibling = file('private-project/business.txt')
    const dc = await connect()
    expect(await dc.send({ t: 'stat', id: 1, path: own })).toMatchObject({ t: 'stat_ok' })
    for (const ref of [sibling, 'private-project/business.txt', '../private-project/business.txt']) {
      expect(await dc.send({ t: 'stat', id: 2, path: ref })).toMatchObject({ t: 'err', code: 'forbidden' })
      expect(await dc.send({ t: 'get', id: 3, path: ref })).toMatchObject({ t: 'err', code: 'forbidden' })
    }
  })
  it('permits reported artifacts only for their task and HTML static resources without broadening to ordinary files', async () => {
    const report = file('reports/index.html', '<iframe src="article.html"></iframe><iframe src="embedded.pdf"></iframe>')
    const article = file('reports/article.html', '<img src="assets/image.png">')
    const asset = file('reports/assets/image.png')
    const pdf = file('reports/embedded.pdf')
    const secret = file('reports/ordinary.txt')
    const offered = file('elsewhere/report.pdf')
    recordArtifacts(runner, 'task', [report, offered])
    const dc = await connect()
    for (const ref of [report, article, asset, pdf, offered]) expect(await dc.send({ t: 'stat', id: 1, path: ref })).toMatchObject({ t: 'stat_ok' })
    expect(await dc.send({ t: 'stat', id: 2, path: secret })).toMatchObject({ code: 'forbidden' })
    const other = await connect(runner, 'other-task')
    expect(await other.send({ t: 'stat', id: 1, path: offered })).toMatchObject({ code: 'forbidden' })
    await dc.send({ t: 'get', id: 3, path: offered, offset: 1, length: 4 })
    expect(dc.messages.at(-1)).toMatchObject({ t: 'end' })
    expect(Buffer.from(dc.binary[0].slice(4)).toString()).toBe('ocal')
  })
  it('only grants the bounded HTML/CSS reference closure, not unreferenced sibling project assets', async () => {
    const report = file('preview.html', '<iframe src="render/article.html"></iframe>')
    const article = file('render/article.html', '<link href="style.css"><img src="picture%20one.png">')
    const css = file('render/style.css', '@import "theme.css"; body { background: url(../images/background.png); }')
    const theme = file('render/theme.css', '@font-face { src: url(font.woff2); }')
    const picture = file('render/picture one.png')
    const background = file('images/background.png')
    const font = file('render/font.woff2')
    const privatePng = file('private-project/screenshot.png')
    const privateCss = file('private-project/internal.css')
    recordArtifacts(runner, 'task', [report])
    const dc = await connect()
    for (const ref of [report, article, css, theme, picture, background, font]) {
      expect(await dc.send({ t: 'stat', id: 1, path: ref })).toMatchObject({ t: 'stat_ok' })
    }
    for (const ref of [privatePng, privateCss]) {
      expect(await dc.send({ t: 'stat', id: 2, path: ref })).toMatchObject({ code: 'forbidden' })
    }
  })
  it('retains references after a large inline image and across scanner chunk boundaries', async () => {
    const padding = 'A'.repeat(5 * 1024 * 1024)
    const report = file('large/preview.html', `<img src="data:image/png;base64,${padding}"><iframe src="article.html"></iframe>`)
    const article = file('large/article.html', `${' '.repeat(64 * 1024 - 10)}<link href="style.css">`)
    const css = file('large/style.css', 'body { background: url(image.png) }')
    const image = file('large/image.png')
    recordArtifacts(runner, 'task', [report])
    const dc = await connect()
    for (const ref of [article, css, image]) {
      expect(await dc.send({ t: 'stat', id: 1, path: ref })).toMatchObject({ t: 'stat_ok' })
    }
  })
  it('authorizes srcset candidates but not data payloads or unrelated assets', async () => {
    const report = file('responsive/preview.html', '<img srcset="small.png 1x, big.png 2x"><source srcset="wide.webp 640w, wider.webp 1280w"><img srcset="data:image/svg+xml,payload.png 1x">')
    const assets = ['small.png', 'big.png', 'wide.webp', 'wider.webp'].map(name => file(`responsive/${name}`))
    const payload = file('responsive/payload.png')
    const unrelated = file('responsive/unrelated.png')
    recordArtifacts(runner, 'task', [report])
    const dc = await connect()
    for (const ref of assets) expect(await dc.send({ t: 'stat', id: 1, path: ref })).toMatchObject({ t: 'stat_ok' })
    for (const ref of [payload, unrelated]) expect(await dc.send({ t: 'stat', id: 2, path: ref })).toMatchObject({ code: 'forbidden' })
  })
  it('normalizes Windows separators before the production credential filter', async () => {
    // On POSIX this is a literal filename; on Windows the same separators
    // delimit directories. The production filter must normalize either form.
    const windowsSecret = file(String.raw`project/C:\project\.env.local`)
    const dc = await connect()
    expect(await dc.send({ t: 'stat', id: 1, path: windowsSecret })).toMatchObject({ code: 'forbidden' })
  })
  it('accepts a trusted symlink ancestor of the working directory but still rejects child links', async () => {
    const own = file('project/normal.txt')
    const alias = path.join(root, 'configured-root')
    fs.symlinkSync(wd, alias)
    const dc = await connect(runner, 'task', { wd: alias })
    expect(await dc.send({ t: 'stat', id: 1, path: path.join(alias, 'normal.txt') })).toMatchObject({ t: 'stat_ok' })
    fs.symlinkSync(own, path.join(wd, 'child.txt'))
    expect(await dc.send({ t: 'stat', id: 2, path: path.join(alias, 'child.txt') })).toMatchObject({ code: 'forbidden' })
    await dc.send({ t: 'put', id: 3, size: 0 })
    expect(await dc.send({ t: 'put_end', id: 3 })).toMatchObject({ t: 'put_ok' })
  })
  it('rejects credentials and symlinks even when explicitly offered', async () => {
    const credential = file('project/.env.local')
    const own = file('project/normal.txt')
    const link = path.join(wd, 'alias.txt')
    fs.symlinkSync(own, link)
    const dirLink = path.join(wd, 'alias-directory')
    fs.symlinkSync(path.dirname(own), dirLink)
    recordArtifacts(runner, 'task', [credential, link])
    const dc = await connect()
    for (const ref of [credential, link, path.join(dirLink, 'normal.txt')]) expect(await dc.send({ t: 'stat', id: 1, path: ref })).toMatchObject({ code: 'forbidden' })
  })
})

describe('P2P actual disk upload enforcement', () => {
  it('writes into the per-task directory with no directory cap, keeping older flat uploads', async () => {
    for (let i = 0; i < 1100; i++) file(`project/.sophon/uploads/${i}.png`, '')
    const dc = await connect()
    const bytes = Buffer.from('normal attachment')
    await dc.send({ t: 'put', id: 1, name: '../../photo.png', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    await dc.receive(p2pPackChunk(1, bytes))
    const result = await dc.send({ t: 'put_end', id: 1 })
    expect(result).toMatchObject({ t: 'put_ok', size: bytes.length })
    expect(path.dirname(result.path)).toBe(uploads())
    expect(fs.readFileSync(result.path)).toEqual(bytes)
    expect(fs.readdirSync(path.dirname(uploads())).length).toBe(1101)
  })
  it('applies the single-file limit', async () => {
    const dc = await connect()
    expect(await dc.send({ t: 'put', id: 2, size: P2P_MAX_FILE_BYTES + 1 })).toMatchObject({ code: 'too_large' })
  })
  it('refuses to send files over the download limit, which only the Runner computer itself can open', async () => {
    const big = file('project/huge.mp4')
    fs.truncateSync(big, P2P_MAX_DOWNLOAD_BYTES + 1) // sparse file, does not really occupy disk
    const dc = await connect()
    expect(await dc.send({ t: 'get', id: 1, path: big, offset: 0, length: 16 })).toMatchObject({ t: 'err', code: 'too_large' })
    fs.truncateSync(big, P2P_MAX_DOWNLOAD_BYTES)
    await dc.send({ t: 'get', id: 2, path: big, offset: 0, length: 16 })
    expect(dc.messages.at(-1)).toMatchObject({ t: 'end' })
  })
  it('rejects symlinked upload directories without writing to the target', async () => {
    const target = path.join(root, 'other')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(wd, '.sophon'))
    const dc = await connect()
    expect(await dc.send({ t: 'put', id: 1, size: 1 })).toMatchObject({ code: 'forbidden' })
    expect(fs.readdirSync(target)).toEqual([])
  })
  it('revokes file uploads without closing preview channels', async () => {
    const dc = await connect(runner, 'task', { preview: true })
    await dc.send({ t: 'put', id: 1, size: 8 })
    await dc.receive(p2pPackChunk(1, Buffer.alloc(8)))
    const finishing = dc.send({ t: 'put_end', id: 1 })
    runner.configure({ enabled: true, file_enabled: false })
    await finishing
    await flush()
    expect(dc.isOpen()).toBe(true)
    expect(dc.messages.some(message => message.id === 1 && message.t === 'put_ok')).toBe(false)
    await vi.waitFor(() => expect(fs.readdirSync(uploads())).toEqual([]))
    expect(await dc.send({ t: 'put', id: 2, size: 0 })).toMatchObject({ code: 'forbidden' })
    runner.configure({ enabled: true, file_enabled: true })
    await dc.send({ t: 'put', id: 3, size: 10 })
    await dc.receive(p2pPackChunk(3, Buffer.alloc(10)))
    expect(await dc.send({ t: 'put_end', id: 3 })).toMatchObject({ t: 'put_ok' })
    expect(fs.readdirSync(uploads()).some(name => name.endsWith('.part'))).toBe(false)
  })
  it('rejects completion after ticket expiry and reclaims the partial file', async () => {
    const expiry = Date.now() + 1000
    const dc = await connect(runner, 'task', { exp: expiry })
    await dc.send({ t: 'put', id: 1, size: 0 })
    vi.spyOn(Date, 'now').mockReturnValue(expiry + 1)
    expect(await dc.send({ t: 'put_end', id: 1 })).toMatchObject({ code: 'auth' })
    await flush()
    await vi.waitFor(() => expect(fs.readdirSync(uploads())).toEqual([]))
  })
  it('reclaims stalled uploads even if the connection is kept alive', async () => {
    vi.useFakeTimers()
    try {
      const dc = await connect(runner, 'task', { exp: Date.now() + 600_000 })
      await dc.send({ t: 'put', id: 1, size: 10 })
      for (let i = 0; i < 4; i++) {
        await dc.send({ t: 'ping', n: i })
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(dc.isOpen()).toBe(true)
      expect(await dc.send({ t: 'put_end', id: 1 })).toMatchObject({ code: 'bad_request' })
    } finally { vi.useRealTimers() }
    await flush()
    await vi.waitFor(() => expect(fs.readdirSync(uploads())).toEqual([]))
  })
  it('cleans checksum, size, overflow and disconnect failures and rejects duplicate ids', async () => {
    const dc = await connect()
    await dc.send({ t: 'put', id: 1, size: 1, sha256: '0'.repeat(64) })
    expect(await dc.send({ t: 'put', id: 1, size: 1 })).toMatchObject({ code: 'busy' })
    await dc.receive(p2pPackChunk(1, Buffer.from('a')))
    expect(await dc.send({ t: 'put_end', id: 1 })).toMatchObject({ code: 'hash_mismatch' })
    await dc.send({ t: 'put', id: 2, size: 2 })
    expect(await dc.send({ t: 'put_end', id: 2 })).toMatchObject({ code: 'bad_request' })
    await dc.send({ t: 'put', id: 3, size: 1 })
    await dc.receive(p2pPackChunk(3, Buffer.from('ab')))
    expect(dc.messages.at(-1)).toMatchObject({ code: 'too_large' })
    await dc.send({ t: 'put', id: 4, size: 1 })
    dc.close()
    await flush()
    await vi.waitFor(() => expect(fs.readdirSync(uploads())).toEqual([]))
  })
})
