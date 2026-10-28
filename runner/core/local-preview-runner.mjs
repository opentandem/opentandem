import { readArtifactPreview } from './artifact-html-preview.mjs'
import { publicKeyFromBase64, verifyPreviewTicket } from './preview-ticket-verify.mjs'
import { resolveLocale } from './locale-core.mjs'
import runnerEnglish from './locales/runner.en.json' with { type: 'json' }
import runnerChinese from './locales/runner.zh.json' with { type: 'json' }
import { createAdapterTranslator } from './messages.mjs'

const t = createAdapterTranslator()

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export const PREVIEW_COOKIE = 'lp'
export const ENTER_PATH = '/__enter'

export function buildPublicPreviewUrl(publicBase, targetUrl) {
  const target = new URL(targetUrl)
  const publicUrl = new URL(publicBase)
  publicUrl.pathname = target.pathname
  publicUrl.search = target.search
  publicUrl.hash = target.hash
  return publicUrl.toString()
}

function hostnameOf(header) {
  try {
    return new URL(`http://${String(header || '').trim()}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function iframeSafeCsp(value) {
  if (!value) return value
  return String(value).split(';')
    .map(part => part.trim())
    .filter(part => part && !part.toLowerCase().startsWith('frame-ancestors'))
    .join('; ')
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return ''
}

/** Keep the gateway credential private; application cookies belong to this host. */
export function applicationCookieHeader(header) {
  return String(header || '').split(';').map(part => part.trim())
    .filter(part => part.includes('=') && part.slice(0, part.indexOf('=')).trim() !== PREVIEW_COOKIE)
    .join('; ')
}

/** Never let a previewed app set a parent-domain cookie or overwrite the ticket.
 * Partitioning keeps each embedding site's login independent. Preserve expiry,
 * HttpOnly and Path so login, logout and path-scoped sessions keep working. */
export function applicationSetCookie(value) {
  const parts = String(value).split(';').map(part => part.trim())
  const pair = parts.shift() || ''
  const index = pair.indexOf('=')
  if (index <= 0 || pair.slice(0, index).trim() === PREVIEW_COOKIE) return null
  const attributes = parts.filter(part => !['domain', 'samesite', 'secure', 'partitioned'].includes(part.split('=', 1)[0].trim().toLowerCase()))
  return [pair, ...attributes, 'Secure', 'SameSite=None', 'Partitioned'].join('; ')
}

/**
 * Who may pass, given the browser's own account of where the request came from.
 *
 *   same-origin                  → yes   (sub-resources inside the preview page: ~99% of traffic)
 *   none + document              → yes   (the user opened the URL in a tab themselves)
 *   cross-site + iframe/frame    → yes   (OpenTandem framing the preview)
 *   cross-site + document, /__enter only → yes (the "remote preview" tab redirecting in;
 *                                  the one-shot signed ticket is the credential)
 *   cross-site, anything else    → NO    (a fetch/form fired by some other site)
 *   header absent                → yes   (old browsers; the cookie is still the real credential)
 *
 * The cookie is SameSite=None (it has to be — the iframe is cross-site), so
 * SameSite no longer blocks cross-site requests. This check is what replaces it.
 *
 * Framed navigation cannot be narrowed to just /__enter, which is what this
 * used to do. The handshake answers 302 → entryPath, and Sec-Fetch-Site is
 * computed across the whole redirect chain, so the *next* hop is still
 * `cross-site` + `iframe` while no longer being /__enter — it got 403 and the
 * frame never loaded a single byte of the app. Cross-site framing is not the
 * hole it looks like: the `lp` cookie is Partitioned, so another site's frame
 * is a different partition key, carries no cookie, and stops at the 401 below.
 * That is the lock; this check is the second one.
 *
 * A top-level tab does not have that redirect-chain problem only because
 * /__enter answers a document with a bounce page instead of a 302: the next
 * hop is started by the preview page itself and arrives as same-origin.
 *
 * @param {{ site?: string, dest?: string, enter?: boolean }} params
 */
export function allowBySecFetch({ site, dest, enter = false }) {
  if (!site) return true
  if (site === 'same-origin' || site === 'same-site') return true
  if (site === 'none') return dest === 'document' || !dest
  if (dest === 'iframe' || dest === 'frame') return true
  return enter && dest === 'document'
}

function bounceHtml(path) {
  const attr = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const js = JSON.stringify(path).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${attr}">` +
    `<script>location.replace(${js})</script>`
}

function unsupportedCookieHtml(locale) {
  const text = (locale === 'zh' ? runnerChinese : runnerEnglish).Preview
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8">
<title>${text.title}</title>
<body style="font:14px/1.5 system-ui,-apple-system,'PingFang SC',sans-serif;padding:32px;color:#111">
<h1 style="font-size:20px;font-weight:600;margin:0 0 12px">${text.blockedTitle}</h1>
<p style="margin:0 0 8px">${text.blockedCookie}</p>
<p style="margin:0 0 8px">${text.upgradeBrowser}</p>
<p style="margin:0">${text.openTab}</p>
</body></html>`
}

/**
 * One gateway per Runner, fronting every local port.
 *
 *            cloudflared ──▶ 127.0.0.1:<this port>
 *                                  │
 *                        ┌─────────┴──────────┐
 *                        │ Host header lookup │
 *                        └───┬────────────┬───┘
 *          tunnel-aaa….dev ──┘            └── tunnel-bbb….dev
 *                 │                                │
 *            127.0.0.1:4010                  127.0.0.1:4021
 *
 * Authenticate before proxying. Only the gateway cookie is stripped upstream;
 * application Set-Cookie is confined to this preview host and partition.
 */
export async function createPreviewGateway() {
  const http = (await import('node:http')).default

  /** hostname → { port, targetUrl } */
  const routes = new Map()
  /** enter-ticket jti values already redeemed; entries expire with the ticket. */
  const usedTickets = new Map()
  const upgradedSockets = new Set()
  let publicKey = null

  const sweepTickets = now => {
    for (const [jti, exp] of usedTickets) if (exp <= now) usedTickets.delete(jti)
  }

  const deny = (res, status, wantsHtml, locale) => {
    if (wantsHtml) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(unsupportedCookieHtml(locale))
      return
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end((locale === 'zh' ? runnerChinese : runnerEnglish).Preview.invalidCredential)
  }

  const server = http.createServer((req, res) => {
    const host = hostnameOf(req.headers.host)
    const route = routes.get(host)
    const incoming = new URL(req.url || '/', 'http://preview.local')
    const isEnter = incoming.pathname === ENTER_PATH
    // A credential-free HEAD checks browser → edge → gateway without consuming
    // the one-shot ticket or exposing routes, credentials, or application data.
    // Uniform for every host: this is only a transport liveness response.
    if (isEnter && req.method === 'HEAD') {
      res.writeHead(204, {
        'access-control-allow-origin': '*', 'cache-control': 'no-store', 'cdn-cache-control': 'no-store',
      })
      res.end()
      return
    }
    const wantsHtml = String(req.headers.accept || '').includes('text/html')
    const cookie = readCookie(req.headers.cookie, PREVIEW_COOKIE)
    const session = publicKey ? verifyPreviewTicket(cookie, publicKey, { use: 'session', host }) : null
    // A signed session carries the language chosen in OpenTandem. Without a
    // credential, use this browser request rather than a machine-wide default.
    const locale = resolveLocale({ account: session?.locale, acceptLanguage: String(req.headers['accept-language'] || '') })
    const previewText = (locale === 'zh' ? runnerChinese : runnerEnglish).Preview

    // Unknown host and expired host answer identically on purpose: probing must
    // not reveal which hostnames exist.
    if (!route || !publicKey) return deny(res, 401, false, locale)

    if (!allowBySecFetch({
      site: String(req.headers['sec-fetch-site'] || ''),
      dest: String(req.headers['sec-fetch-dest'] || ''),
      enter: isEnter,
    })) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(previewText.crossSiteDenied)
      return
    }

    if (isEnter) {
      const now = Date.now()
      sweepTickets(now)
      const ticket = verifyPreviewTicket(incoming.searchParams.get('t'), publicKey, { use: 'enter', host, now })
      if (!ticket || usedTickets.has(ticket.jti)) return deny(res, 401, false, locale)
      // Each enter ticket selects its own signed session, so simultaneous
      // browsers using one preview host do not inherit the last bind locale.
      const sessionTicket = ticket.session || route.sessionTicket
      const selectedSession = verifyPreviewTicket(sessionTicket, publicKey, { use: 'session', host, now })
      if (!selectedSession) return deny(res, 401, false, locale)
      usedTickets.set(ticket.jti, ticket.exp)
      const maxAge = Math.max(1, Math.floor((Math.min(route.sessionExpiresAt, selectedSession.exp) - now) / 1000))
      const setCookie = `${PREVIEW_COOKIE}=${sessionTicket}; Path=/; Max-Age=${maxAge}; ` +
        'Secure; HttpOnly; SameSite=None; Partitioned'
      const entryPath = route.entryPath || '/'
      // A top-level tab arrives cross-site; a 302 would keep that label on the
      // next hop and get it refused. Bounce from this page so it is same-origin.
      if (req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(200, { 'set-cookie': setCookie, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(bounceHtml(entryPath))
        return
      }
      res.writeHead(302, { 'set-cookie': setCookie, location: entryPath, 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (!session) {
      // No cookie on a top-level/iframe document right after the handshake is
      // the signature of a browser that dropped the partitioned cookie, so say
      // so instead of showing a blank frame.
      return deny(res, 401, wantsHtml && !cookie, locale)
    }

    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(name) || name === 'host' || name === 'cookie' || value === undefined) continue
      headers[name] = value
    }
    const appCookie = applicationCookieHeader(req.headers.cookie)
    if (appCookie) headers.cookie = appCookie
    headers.host = `127.0.0.1:${route.port}`
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: route.port,
      method: req.method,
      path: `${incoming.pathname}${incoming.search}`,
      headers,
    }, upstreamRes => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_HEADERS.has(name) || name === 'x-frame-options' || name === 'set-cookie' || value === undefined) continue
        responseHeaders[name] = value
      }
      const appCookies = (upstreamRes.headers['set-cookie'] || []).map(applicationSetCookie).filter(Boolean)
      if (appCookies.length) responseHeaders['set-cookie'] = appCookies
      const csp = iframeSafeCsp(responseHeaders['content-security-policy'])
      if (csp) responseHeaders['content-security-policy'] = csp
      else delete responseHeaders['content-security-policy']
      responseHeaders['referrer-policy'] = 'no-referrer'
      // A previewed app is a dev server: its assets are unversioned, so whatever
      // CDN sits in front of the tunnel must never cache them or the browser
      // loads a stale bundle forever. `cache-control` is left to the app; this
      // edge-only header is the one Cloudflare obeys without touching the browser cache.
      responseHeaders['cdn-cache-control'] = 'no-store'
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(previewText.serviceUnavailable)
    })
    // A preview page reloads and its EventSource reconnects constantly, so the
    // browser hangs up on in-flight requests all the time. Without this the
    // upstream socket to the dev server is never released — a single preview
    // left ~2000 ESTABLISHED connections behind and the dev server stopped
    // answering, which is what turned "reload once" into a reload loop. `close`
    // fires both when the response finishes and when the client aborts.
    res.on('close', () => { if (!upstream.destroyed) upstream.destroy() })
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const host = hostnameOf(req.headers.host)
    const route = routes.get(host)
    const denyUpgrade = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    if (!route || !publicKey || !verifyPreviewTicket(readCookie(req.headers.cookie, PREVIEW_COOKIE), publicKey, { use: 'session', host })) {
      return denyUpgrade('401 Unauthorized')
    }
    // WebSockets have no browser CORS preflight. Require the actual preview
    // origin even when a client supplies an otherwise valid session ticket.
    let origin
    try { origin = new URL(String(req.headers.origin || '')) } catch { return denyUpgrade('403 Forbidden') }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.hostname !== host) return denyUpgrade('403 Forbidden')
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket') return denyUpgrade('400 Bad Request')
    const headers = { ...req.headers, host: `127.0.0.1:${route.port}` }
    delete headers.cookie
    const appCookie = applicationCookieHeader(req.headers.cookie)
    if (appCookie) headers.cookie = appCookie
    const upstream = http.request({ hostname: '127.0.0.1', port: route.port, path: req.url, method: 'GET', headers })
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    upstream.on('response', response => {
      response.resume()
      denyUpgrade(`${response.statusCode || 502} Upgrade Failed`)
    })
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      if (socket.destroyed) { peer.destroy(); return }
      upgradedSockets.add(socket)
      upgradedSockets.add(peer)
      const close = () => {
        upgradedSockets.delete(socket)
        upgradedSockets.delete(peer)
        socket.destroy()
        peer.destroy()
      }
      socket.on('close', close)
      socket.on('end', close)
      peer.on('close', close)
      peer.on('end', close)
      peer.on('error', close)
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === 'set-cookie' || value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) peer.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      socket.pipe(peer)
      peer.pipe(socket)
    })
    upstream.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(t('The local preview gateway failed to start'))
  let closed = false
  return {
    port: address.port,
    setPublicKey: spkiBase64 => { publicKey = publicKeyFromBase64(spkiBase64) },
    hasPublicKey: () => Boolean(publicKey),
    setRoute: (host, entry) => { routes.set(host, entry) },
    getRoute: host => routes.get(host),
    dropRoute: host => { routes.delete(host) },
    routeCount: () => routes.size,
    close: () => new Promise(resolve => {
      if (closed) return resolve()
      closed = true
      server.close(() => resolve())
      server.closeAllConnections?.()
      for (const socket of upgradedSockets) socket.destroy()
      upgradedSockets.clear()
    }),
  }
}

/** Offline ticket verification in the Runner: the public key is delivered with the heartbeat and replaced wholesale when it changes. Peer-to-peer session tickets (use:'p2p') are verified with it, so there is no second signature-verification implementation. */
export function createTicketVerifier() {
  let key = null
  return {
    setKey: spkiBase64 => { key = publicKeyFromBase64(spkiBase64) },
    verify: (token, options) => (key ? verifyPreviewTicket(token, key, options) : null),
  }
}

export const CLOUDFLARED_VERSION = '2026.8.2'
export const CLOUDFLARED_CDN = 'https://ps4freetest.jiongtoutiao.com/opentandem/cloudflared'
export const CLOUDFLARED_ASSETS = {
  "darwin-x64": {
    "filename": "cloudflared-darwin-amd64.tgz",
    "sha256": "f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4",
    "binarySha256": "b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a",
    "size": 21116242
  },
  "darwin-arm64": {
    "filename": "cloudflared-darwin-arm64.tgz",
    "sha256": "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442",
    "binarySha256": "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d",
    "size": 19214189
  },
  "linux-x64": {
    "filename": "cloudflared-linux-amd64",
    "sha256": "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    "binarySha256": "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    "size": 39799316
  },
  "linux-arm64": {
    "filename": "cloudflared-linux-arm64",
    "sha256": "7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790",
    "binarySha256": "7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790",
    "size": 37404344
  },
  "win32-x64": {
    "filename": "cloudflared-windows-amd64.exe",
    "sha256": "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    "binarySha256": "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    "size": 54893480
  }
}

async function execFilePromise(file, args, options = {}) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

/** Windows ARM64 uses the official x64 executable through Windows emulation.
 * Both downloads and installed bytes are pinned; never fetch code from GitHub
 * on the end user's machine. The same function serves installers and previews. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${platform === 'win32' && arch === 'arm64' ? 'x64' : arch}`
  const asset = CLOUDFLARED_ASSETS[target]
  if (!asset) throw new Error(`cloudflared unsupported architecture: ${platform}/${arch}`)
  return { ...asset, target, url: `${CLOUDFLARED_CDN}/${CLOUDFLARED_VERSION}/${asset.filename}` }
}

let cloudflaredPreparation = null
export function ensureCloudflared() {
  if (!cloudflaredPreparation) {
    cloudflaredPreparation = prepareCloudflared().catch(error => {
      cloudflaredPreparation = null // A failed attempt must remain retryable.
      throw new Error(`cloudflared preparation failed: ${error.message}`, { cause: error })
    })
  }
  return cloudflaredPreparation
}

async function prepareCloudflared() {
  const fs = (await import('node:fs')).default
  const path = (await import('node:path')).default
  const os = (await import('node:os')).default
  const crypto = (await import('node:crypto')).default
  const configured = process.env.SOPHON_CLOUDFLARED_BIN?.trim()
  if (configured) {
    await execFilePromise(configured, ['--version'], { timeout: 10_000, windowsHide: true })
    return configured
  }
  const asset = cloudflaredAsset()
  const binDir = path.join(os.homedir(), '.local', 'share', 'opentandem', 'bin',
    `cloudflared-${CLOUDFLARED_VERSION}-${asset.target}`)
  const managed = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const checksum = async file => {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  }
  const usable = async file => {
    if (await checksum(file).catch(() => '') !== asset.binarySha256) return false
    try {
      const { stdout } = await execFilePromise(file, ['--version'], { timeout: 15_000, windowsHide: true })
      return stdout.includes(`cloudflared version ${CLOUDFLARED_VERSION}`)
    } catch { return false }
  }
  if (await usable(managed)) return managed
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const stage = fs.mkdtempSync(path.join(binDir, '.install-'))
  const archive = path.join(stage, asset.filename)
  try {
    // Retry the CDN once. Never fall back to an external download host.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const totalTimer = setTimeout(() => controller.abort(), 180_000)
      let idleTimer = setTimeout(() => controller.abort(), 15_000)
      let output
      try {
        const response = await fetch(asset.url, { signal: controller.signal, redirect: 'error' })
        if (!response.ok || !response.body) throw new Error(`CDN HTTP ${response.status}`)
        output = await fs.promises.open(archive, 'w', 0o600)
        let size = 0
        for await (const chunk of response.body) {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => controller.abort(), 15_000)
          size += chunk.length
          if (size > asset.size) { controller.abort(); throw new Error('CDN file exceeds pinned size') }
          await output.writeFile(chunk)
        }
        await output.close(); output = null
        if (size !== asset.size || await checksum(archive) !== asset.sha256) {
          throw new Error('CDN file checksum mismatch')
        }
        break
      } catch (error) {
        if (attempt === 1) throw error
      } finally {
        clearTimeout(totalTimer); clearTimeout(idleTimer)
        controller.abort()
        await output?.close()
      }
    }
    let binary = archive
    if (asset.filename.endsWith('.tgz')) {
      await execFilePromise('/usr/bin/tar', ['-xzf', archive, '-C', stage], { timeout: 30_000 })
      binary = path.join(stage, 'cloudflared')
    }
    fs.chmodSync(binary, 0o700)
    if (!await usable(binary)) throw new Error('downloaded connector cannot run or failed verification')
    // Another installer may have finished while this one was downloading.
    if (!await usable(managed)) fs.renameSync(binary, managed)
    return managed
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

export async function preparePreviewComponent(locale) {
  const text = (locale === 'zh' ? runnerChinese : runnerEnglish).Cloudflared
  console.log(text.preparing)
  try {
    await ensureCloudflared()
    console.log(text.ready)
    return true
  } catch (error) {
    console.error(text.failed)
    console.error(error.message)
    return false
  }
}

async function freeLoopbackPort() {
  const net = (await import('node:net')).default
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** A connector token is base64 JSON `{a, t, s}`; `t` is the tunnel id. Lets the
 *  Runner tell the server which tunnel it is actually running, and notice when
 *  the server has rotated to a different one. */
export function tunnelIdOfToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(String(token || ''), 'base64').toString('utf8'))
    return typeof parsed?.t === 'string' ? parsed.t : ''
  } catch {
    return ''
  }
}

async function defaultLaunchNamedTunnel(tunnelToken) {
  const { spawn } = await import('node:child_process')
  const fs = (await import('node:fs')).default
  const path = (await import('node:path')).default
  const os = (await import('node:os')).default
  const bin = await ensureCloudflared()
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-tunnel-'))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, tunnelToken, { mode: 0o600 })
  // cloudflared's own /ready endpoint reports how many edge connections are
  // registered right now. It is the only health signal measured on the path
  // that matters (this machine → Cloudflare); probing from the OpenTandem
  // server measured the server's own route to Cloudflare instead and raised
  // false "disconnected" alarms (~3% of probes from the Shenzhen ECS time out).
  const metricsPort = await freeLoopbackPort()
  // Let cloudflared prefer QUIC and fall back to HTTP/2 when the current
  // network blocks UDP. Pinning HTTP/2 made every preview depend on one
  // transport even when the machine had a healthier QUIC path available.
  const child = spawn(bin, [
    'tunnel', '--no-autoupdate', '--protocol', 'auto', '--metrics', `127.0.0.1:${metricsPort}`,
    'run', '--token-file', tokenFile,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Keep connection lifecycle lines (they carry cloudflared's own timestamps)
  // so a flapping tunnel can be diagnosed after the fact instead of guessed at.
  const logLifecycle = chunk => {
    for (const line of String(chunk).split('\n')) {
      if (/ (ERR|WRN) |Registered tunnel connection|Unregistered tunnel connection|Retrying connection/.test(line)) {
        console.log(`[preview] cloudflared: ${line.trim().slice(0, 300)}`)
      }
    }
  }
  child.stdout.on('data', logLifecycle)
  child.stderr.on('data', logLifecycle)
  let ready = false
  const waitUntilReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('Cloudflare Named Tunnel connection timed out'))), 35_000)
    const inspect = chunk => {
      if (!/registered tunnel connection|connection .* registered/i.test(String(chunk)) || ready) return
      ready = true
      clearTimeout(timer)
      resolve()
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      if (!ready) {
        clearTimeout(timer)
        reject(new Error(t('Cloudflare Named Tunnel failed to start ({code})', { code: code ?? 'unknown' })))
      }
    })
  })
  try {
    await waitUntilReady
  } catch (error) {
    child.kill('SIGTERM')
    try { fs.rmSync(tokenDir, { recursive: true, force: true }) } catch {}
    throw error
  }
  let closing = false
  // A process killed by a signal keeps exitCode === null forever (Node sets
  // signalCode instead), so `exitCode === null` alone reported a SIGKILLed or
  // SIGPIPEd cloudflared as alive and the reconnect supervisor never fired.
  const running = () => child.exitCode === null && child.signalCode === null && !child.killed
  child.once('exit', (code, signal) => {
    if (!closing) console.warn(`[preview] cloudflared exited code=${code ?? 'unknown'} signal=${signal ?? 'none'}`)
  })
  child.once('error', error => console.warn(`[preview] cloudflared process error: ${error.message}`))
  return {
    tunnelId: tunnelIdOfToken(tunnelToken),
    alive: running,
    /** At least one edge connection registered. cloudflared reconnects dropped
     *  connections by itself; this only answers whether traffic can flow now. */
    ready: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: AbortSignal.timeout(1_500) })
        const body = await response.json().catch(() => ({}))
        return response.ok && Number(body.readyConnections) > 0
      } catch {
        return false
      }
    },
    close: async () => {
      closing = true
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      try { fs.rmSync(tokenDir, { recursive: true, force: true }) } catch {}
    },
  }
}

async function assertLocalHttpAvailable(targetUrl) {
  const http = (await import('node:http')).default
  const target = new URL(targetUrl)
  await new Promise((resolve, reject) => {
    const req = http.request(target, { method: 'HEAD', timeout: 3_000 }, res => {
      res.resume()
      if (res.statusCode >= 500) reject(new Error(t('The local service returned HTTP {status}', { status: res.statusCode })))
      else resolve()
    })
    req.once('timeout', () => { reject(new Error(t('The local service did not respond in time'))); req.destroy() })
    req.once('error', () => reject(new Error(t('Cannot reach {origin}; start the local HTTP service first', { origin: target.origin }))))
    req.end()
  })
}

/**
 * Lifecycle, all of it:
 *
 *   gateway   one per Runner, started on the first prepare(), never restarted
 *   tunnel    one per Runner, started on the first bind(), reconnected if the
 *             process dies, restarted when the server hands over a token for a
 *             different (rotated) tunnel, otherwise reused forever
 *   route     one per (hostname, local port); dropped warmMs after its last
 *             viewer leaves, which is what bounds how long a leaked URL could
 *             matter even with a valid cookie
 *   session   one per open preview window; renewed by heartbeat, expires
 *             idleMs after the last one
 *
 * @typedef {{ tunnelId?: string, alive: () => boolean, ready?: () => Promise<boolean>, close?: () => Promise<void> }} PreviewTunnelHandle
 * @param {{ idleMs?: number, warmMs?: number, reconnectMs?: number,
 *   launchNamedTunnel?: (tunnelToken: string) => Promise<PreviewTunnelHandle> }} [options]
 */
export function createLocalPreviewManager({
  idleMs = 90_000,
  warmMs = 8 * 60 * 60_000,
  reconnectMs = 2_000,
  launchNamedTunnel = defaultLaunchNamedTunnel,
} = {}) {
  let gateway = null
  let gatewayPromise = null
  let tunnel = null
  let tunnelToken = null
  let reconnectPromise = null
  let tunnelMaintenanceTimer = null
  let closed = false
  const sessions = new Map()
  /** hostname → { sessionIds:Set, warmTimer } */
  const hosts = new Map()

  // Preview commands run concurrently now (a slow bind must not hold other
  // windows' heartbeats hostage), so two prepares can race here.
  const ensureGateway = async () => {
    if (gateway) return gateway
    gatewayPromise ??= createPreviewGateway().then(created => { gateway = created; return created })
    try {
      return await gatewayPromise
    } finally {
      gatewayPromise = null
    }
  }

  const runningTunnelId = () => (tunnel ? (tunnel.tunnelId ?? tunnelIdOfToken(tunnelToken)) : '')
  /** Alive AND running the tunnel of the latest token. After a rotation the
   *  old tunnel is deleted, so a connector on the old token is useless even
   *  while its process is still up. */
  const tunnelCurrent = () => {
    if (!tunnel?.alive()) return false
    const wanted = tunnelIdOfToken(tunnelToken)
    return !wanted || runningTunnelId() === wanted
  }

  const ensureTunnel = async () => {
    // A launch already in flight may be using an older token (the supervisor
    // relaunches the moment the rotated-away tunnel drops its connector), so
    // wait for it and re-check instead of adopting its result.
    while (reconnectPromise) await reconnectPromise.catch(() => {})
    if (!tunnelToken) throw new Error(t('Missing the Cloudflare tunnel credential'))

    reconnectPromise = (async () => {
      // A live process can have zero edge connections. Check readiness before
      // warm reuse; otherwise bind returns success and the server skips its
      // edge check for a connector that cannot carry the iframe request.
      // Share this check with reconnects so concurrent binds replace it once.
      if (tunnelCurrent()) {
        const current = tunnel
        const ready = current.ready ? await current.ready() : true
        if (ready && tunnelCurrent()) return current
      }
      const staleTunnel = tunnel
      tunnel = null
      await staleTunnel?.close?.().catch(() => {})
      console.log(`[preview] ${new Date().toISOString()} starting Cloudflare tunnel`)
      const nextTunnel = await launchNamedTunnel(tunnelToken)
      if (closed) {
        await nextTunnel.close?.().catch(() => {})
        throw new Error(t('Local preview is closed'))
      }
      tunnel = nextTunnel
      console.log(`[preview] ${new Date().toISOString()} Cloudflare tunnel connected`)
      return tunnel
    })()
    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  const startTunnelMaintenance = () => {
    if (tunnelMaintenanceTimer) return
    tunnelMaintenanceTimer = setInterval(() => {
      if (tunnelCurrent() || !tunnelToken || reconnectPromise) return
      void ensureTunnel().catch(error => console.warn(`[preview] ${new Date().toISOString()} Cloudflare tunnel reconnect failed: ${error.message}`))
    }, reconnectMs)
    tunnelMaintenanceTimer.unref?.()
  }

  const clearWarm = entry => {
    if (entry?.warmTimer) clearTimeout(entry.warmTimer)
    if (entry) entry.warmTimer = null
  }

  const dropHost = host => {
    const entry = hosts.get(host)
    if (!entry) return
    clearWarm(entry)
    for (const id of entry.sessionIds) {
      const session = sessions.get(id)
      if (session?.timer) clearTimeout(session.timer)
      sessions.delete(id)
    }
    hosts.delete(host)
    gateway?.dropRoute(host)
  }

  const scheduleWarm = host => {
    const entry = hosts.get(host)
    if (!entry) return
    clearWarm(entry)
    entry.warmTimer = setTimeout(() => dropHost(host), warmMs)
    entry.warmTimer.unref?.()
  }

  const releaseSession = sessionId => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.timer) clearTimeout(session.timer)
    sessions.delete(sessionId)
    const entry = hosts.get(session.host)
    if (!entry) return
    entry.sessionIds.delete(sessionId)
    if (entry.sessionIds.size === 0) scheduleWarm(session.host)
  }

  const renewSession = session => {
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => releaseSession(session.id), idleMs)
    session.timer.unref?.()
  }

  return {
    /** Step 1: prove the local service is up and hand the server our gateway
     *  port plus the tunnel we are already running, so a warm open costs the
     *  server no Cloudflare API call at all. */
    async prepare(targetUrl) {
      const target = new URL(targetUrl)
      if (target.protocol !== 'http:' || target.username || target.password ||
          !['localhost', '127.0.0.1'].includes(target.hostname)) {
        throw new Error(t('Only HTTP services on localhost or 127.0.0.1 can be previewed'))
      }
      await assertLocalHttpAvailable(target.toString())
      const gw = await ensureGateway()
      const alive = Boolean(tunnel?.alive())
      return { gateway_port: gw.port, tunnel_alive: alive, tunnel_id: alive ? runningTunnelId() : '' }
    },

    /** Step 2: start or reuse the one tunnel, then publish this hostname. */
    async bind({ host, port, target_url: targetUrl, session_ticket: sessionTicket,
                 session_expires_at: sessionExpiresAt, public_key: publicKey, tunnel_token: receivedTunnelToken }) {
      if (!gateway) throw new Error(t('The local preview gateway has not started'))
      const hostname = hostnameOf(host)
      if (!hostname || hostname !== String(host).toLowerCase()) throw new Error(t('Invalid local preview hostname'))
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('Invalid local port'))
      if (!sessionTicket || !publicKey) throw new Error(t('Missing the local preview credential'))

      gateway.setPublicKey(publicKey)
      // A token for a different tunnel means the server rotated it: ensureTunnel
      // replaces the old connector, which would otherwise leave the new tunnel
      // with zero connectors (530).
      if (receivedTunnelToken) tunnelToken = receivedTunnelToken
      if (!tunnelToken) throw new Error(t('Missing the Cloudflare tunnel credential'))
      const before = tunnel
      await ensureTunnel()
      startTunnelMaintenance()

      const target = new URL(targetUrl)
      gateway.setRoute(hostname, {
        port,
        targetUrl: target.toString(),
        entryPath: `${target.pathname}${target.search}`,
        sessionTicket,
        sessionExpiresAt: Number(sessionExpiresAt) || (Date.now() + 8 * 60 * 60_000),
      })
      const entry = hosts.get(hostname) || { sessionIds: new Set(), warmTimer: null }
      clearWarm(entry)
      hosts.set(hostname, entry)

      const crypto = (await import('node:crypto')).default
      const sessionId = `lp_${crypto.randomBytes(12).toString('hex')}`
      const session = { id: sessionId, host: hostname, timer: null }
      sessions.set(sessionId, session)
      entry.sessionIds.add(sessionId)
      renewSession(session)

      return {
        session_id: sessionId,
        public_url: `https://${hostname}${ENTER_PATH}`,
        // The server only needs to wait for the edge when a connector was just
        // (re)started; a warm tunnel is already routable.
        tunnel_started: tunnel !== before,
      }
    },

    /** Health as seen from this machine: process alive AND cloudflared reports
     *  at least one registered edge connection. */
    async heartbeat(sessionId) {
      const session = sessions.get(sessionId)
      const route = session && gateway?.getRoute(session.host)
      if (!session || !tunnel?.alive() || !route) return { ok: false }
      renewSession(session)
      const ready = tunnel.ready ? await tunnel.ready() : true
      if (!ready) return { ok: false, reconnecting: true, host: session.host }
      await assertLocalHttpAvailable(route.targetUrl)
      return { ok: true, host: session.host }
    },

    /** Open preview windows. A self-update restart would wipe every one of them. */
    activeSessionCount() {
      return sessions.size
    },

    async stop(sessionId) {
      releaseSession(sessionId)
      return { ok: true }
    },

    async destroy(host) {
      dropHost(hostnameOf(host))
      return { ok: true }
    },

    async closeAll() {
      closed = true
      if (tunnelMaintenanceTimer) clearInterval(tunnelMaintenanceTimer)
      tunnelMaintenanceTimer = null
      for (const host of [...hosts.keys()]) dropHost(host)
      await Promise.allSettled([
        tunnel?.close?.() ?? Promise.resolve(),
        gateway?.close?.() ?? Promise.resolve(),
      ])
      tunnel = null
      tunnelToken = null
      gateway = null
    },
  }
}

// ---------------------------------------------------------------------------
// Local file server: lets a browser on THIS machine show the Runner's artifacts
// without uploading them first.
//
//   page (https://<server>)                       Runner, 127.0.0.1:<port>
//     <img src="/ot/probe.gif?t=<probe ticket>">  ──▶ verify ticket.mid === me ──▶ 1×1 gif
//     <img|video|iframe src="/ot/f/<file ticket>/<name>">
//                                                 ──▶ verify ticket ──▶ stream file (Range)
//
// 127.0.0.1 only reaches the browser's own machine, so "the probe loaded" means
// "this browser sits next to the Runner that owns the task". Tickets are signed
// by the server (the Runner only holds the public key) and bind the machine id,
// so another Runner on the same computer — or a stale port reused by one —
// refuses them and the page falls back to uploading. A wrong guess can only
// ever show as a failed load, never as another machine's file.
// ---------------------------------------------------------------------------

const PROBE_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * @param {{ machineId: string, serverOrigin: string, mimeFor: (file: string) => string, isSensitive: (file: string) => boolean }} options
 */
export async function createLocalFileServer({ machineId, serverOrigin, mimeFor, isSensitive }) {
  const http = (await import('node:http')).default
  const fs = (await import('node:fs')).default
  const path = (await import('node:path')).default
  let publicKey = null
  let publicKeyText = ''

  const verify = (token, use) => {
    if (!publicKey) return null
    const payload = verifyPreviewTicket(token, publicKey)
    if (!payload || payload.use !== use || payload.mid !== machineId) return null
    return payload
  }

  /** The file a ticket grants. HTML tickets carry a root so relative refs resolve. */
  const resolveTarget = (payload, rel) => {
    if (typeof payload.path !== 'string' || !path.isAbsolute(payload.path)) return null
    if (typeof payload.root !== 'string' || !payload.root) return payload.path
    const root = path.resolve(payload.root)
    const target = path.resolve(root, rel)
    const inside = path.relative(root, target)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
    return target
  }

  const server = http.createServer(async (req, res) => {
    // Only the OpenTandem page itself may read bodies with fetch(); <img>/<video>
    // don't need CORS. Browsers set Origin, so nothing else can claim it.
    const cors = req.headers.origin === serverOrigin
      ? { 'access-control-allow-origin': serverOrigin, vary: 'Origin' }
      : { vary: 'Origin' }
    const end = (status, headers = {}) => { res.writeHead(status, { ...cors, 'cache-control': 'no-store', ...headers }); res.end() }
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405)
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { return end(400) }

    if (url.pathname === '/ot/probe.gif') {
      if (!verify(url.searchParams.get('t'), 'probe')) return end(404)
      res.writeHead(200, { ...cors, 'content-type': 'image/gif', 'cache-control': 'no-store' })
      return res.end(req.method === 'HEAD' ? undefined : PROBE_GIF)
    }
    // fetch() reachability: Chrome/Edge/Firefox allow it, Safari blocks it — the
    // page uses this to decide whether HTML/text previews can be read locally.
    if (url.pathname === '/ot/ping') return end(204)

    const m = url.pathname.match(/^\/ot\/f\/([^/]+)\/(.+)$/)
    if (!m) return end(404)
    const payload = verify(m[1], 'file')
    if (!payload) return end(401)
    let rel
    try { rel = decodeURIComponent(m[2]) } catch { return end(400) }
    const target = resolveTarget(payload, rel)
    if (!target || isSensitive(target)) return end(404)
    let stat
    try {
      const real = await fs.promises.realpath(target)
      const root = await fs.promises.realpath(payload.root || payload.path)
      const relative = path.relative(root, real)
      if (isSensitive(real) || (payload.root ? relative.startsWith('..') || path.isAbsolute(relative) : real !== root)) return end(404)
      stat = await fs.promises.stat(target)
    } catch { return end(404) }
    if (!stat.isFile()) return end(404)

    const raw = url.searchParams.get('download') === '1' || url.searchParams.get('text') === '1'
    const imageId = url.searchParams.get('ot-inline')
    let preview
    try { preview = await readArtifactPreview(target, stat, raw ? undefined : imageId ? `image:${imageId}` : 'document') } catch { return end(404) }
    const size = preview ? preview.bytes.length : stat.size
    const type = preview?.mime || mimeFor(target)
    const headers = {
      ...cors,
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    }
    // Only the loopback server may run HTML directly: an opaque CSP sandbox
    // prevents access to other ticketed pages, cookies, storage and the parent.
    // SVG and raw/download views retain the script prohibition.
    if (type.startsWith('text/html')) headers['content-security-policy'] = raw
      ? "script-src 'none'; object-src 'none'"
      : "sandbox allow-scripts allow-forms; object-src 'none'"
    if (type.startsWith('image/svg')) headers['content-security-policy'] = "script-src 'none'; object-src 'none'"
    if (url.searchParams.get('download') === '1') {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`
    }
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/)
    let start = 0
    let last = size - 1
    let status = 200
    if (range && size > 0) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      last = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > last) return end(416, { 'content-range': `bytes */${size}` })
      status = 206
      headers['content-range'] = `bytes ${start}-${last}/${size}`
    }
    headers['content-length'] = String(size ? last - start + 1 : 0)
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || !size) return res.end()
    if (preview) return res.end(preview.bytes.subarray(start, last + 1))
    const stream = fs.createReadStream(target, { start, end: last })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return {
    port: server.address().port,
    /** SPKI base64 from the heartbeat response; unchanged keys are a no-op. */
    setPublicKey(spkiBase64) {
      const text = String(spkiBase64 || '')
      if (!text || text === publicKeyText) return
      try { publicKey = publicKeyFromBase64(text); publicKeyText = text } catch { /* keep the previous key */ }
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
