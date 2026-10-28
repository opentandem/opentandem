// Derived preview bytes only: callers MUST authorize the original file before
// using this helper. Downloads always read the unchanged source file.
const ahPath = process.getBuiltinModule('node:path')
const ahFs = process.getBuiltinModule('node:fs')
const ahCrypto = process.getBuiltinModule('node:crypto')
const ahCache = new Map()
const AH_CACHE_BYTES = 256 * 1024 * 1024
const AH_SOURCE_BYTES = 200 * 1024 * 1024

/** Resolve local references, including file URLs, without reading any file. */
export function artifactLocalReference(value, filename) {
  let ref = value.trim().replace(/&amp;/g, '&')
  const paths = /^[a-z]:[\\/]/i.test(filename) ? ahPath.win32 : ahPath.posix
  if (!ref || ref.startsWith('#') || ref.startsWith('//')) return null
  if (/^file:/i.test(ref)) {
    try {
      const url = new URL(ref)
      if (url.hostname && url.hostname !== 'localhost') return null
      ref = decodeURIComponent(url.pathname)
      if (paths === ahPath.win32) ref = ref.replace(/^\/([a-z]:)/i, '$1')
    } catch { return null }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) return null
    try { ref = decodeURIComponent(ref.split(/[?#]/)[0]) } catch { return null }
  }
  return paths.resolve(paths.dirname(filename), ref)
}

/** Rewrite only local URL attributes and CSS URLs. Remote/data URLs stay intact. */
export function rewriteArtifactReferences(html, filename, urlFor) {
  const rewrite = value => {
    const abs = artifactLocalReference(value, filename)
    if (!abs) return value
    const suffix = value.search(/[?#]/)
    return urlFor(abs) + (suffix < 0 ? '' : value.slice(suffix).replace(/&amp;/g, '&'))
  }
  // Skip comments and script bodies: neither is a resource attribute.
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<[^>]+>|url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+["'][^"']+["']/gi, (part) => {
    if (/^<!--|^<script\b/i.test(part)) return part
    return part
      .replace(/(@import\s+)(["'])([^"']+)\2/gi, (_m, prefix, quote, value) => prefix + quote + rewrite(value).replaceAll(quote, '%22') + quote)
      .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, prefix, quote, value) => prefix + quote + rewrite(value).replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;').replaceAll(quote, quote === '"' ? '&quot;' : '&#39;') + quote)
      .replace(/(\s(?:src|href|poster)\s*=\s*)(?!["'])([^\s>]+)/gi, (_m, prefix, value) => prefix + '"' + rewrite(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"')
      .replace(/(\ssrcset\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, prefix, quote, value) => {
        // Data URL commas belong to the URL; descriptors delimit candidates.
        const rewritten = value.replace(/(^|,\s*)([^\s,][^\s]*)(\s+[^,]+)?/g, (_s, sep, url, descriptor = '') => {
          const trailing = url.endsWith(',') ? ',' : ''
          return sep + rewrite(trailing ? url.slice(0, -1) : url) + trailing + descriptor
        })
        return prefix + quote + rewritten.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;').replaceAll(quote, quote === '"' ? '&quot;' : '&#39;') + quote
      })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (original, quote, value) => {
        const next = rewrite(value)
        return next === value ? original : `url(${quote}${next.replace(/[\s"'()]/g, c => '%' + c.charCodeAt(0).toString(16))}${quote})`
      })
  })
}

/** Pure transformation, also used by the OSS preview. */
export function prepareArtifactHtml(html, filename, imageUrl, localUrl) {
  const images = new Map()
  // Every transformation below touches markup only. Script bodies stay byte for
  // byte: rewriting a JS string (a data URL, an "<img" literal) breaks pages that
  // render through scripts in the isolated srcdoc frame.
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/i)
  const markup = fn => { for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]) }
  // Externalize data URLs in img/srcset/poster and CSS backgrounds alike.
  markup(text => text.replace(/data:(image\/(?:png|jpe?g|gif|webp|avif|svg\+xml));base64,([a-z0-9+/=\r\n]+)/gi, (original, type, encoded) => {
    if (encoded.length < 64 * 1024 * 4 / 3) return original
    const bytes = Buffer.from(encoded.replace(/\s/g, ''), 'base64')
    if (bytes.length < 64 * 1024) return original
    const id = ahCrypto.createHash('sha256').update(bytes).digest('hex')
    if (!images.has(id)) images.set(id, { bytes, mime: type.toLowerCase().replace('image/jpg', 'image/jpeg') })
    return imageUrl(id, type.toLowerCase().replace('image/jpg', 'image/jpeg'))
  }))
  // Native decoding and placeholders need no script permission. Do not add lazy
  // loading: script-disabled documents cannot reliably defer image requests.
  markup(text => text.replace(/<img\b[^>]*>/gi, tag => {
    const decode = /\sdecoding\s*=/i.test(tag) ? '' : ' decoding="async"'
    return tag.replace(/^<img\b/i, '<img' + decode)
  }))
  const style = '<style>img{background-color:#f1f3f5;background-image:linear-gradient(110deg,transparent,rgba(255,255,255,.6),transparent);min-height:24px}img[width="1"],img[height="1"]{min-height:0}</style>'
  if (!/\.css$/i.test(filename)) {
    const inject = re => {
      for (let i = 0; i < parts.length; i += 2) if (re.test(parts[i])) { parts[i] = parts[i].replace(re, match => match + style); return true }
      return false
    }
    if (!inject(/<head\b[^>]*>/i) && !inject(/<body\b[^>]*>/i)) parts.push(style)
  }
  let body = parts.join('')
  if (localUrl) body = rewriteArtifactReferences(body, filename, localUrl)
  return { html: body, images }
}

/** Small bounded cache, keyed by source identity. Never stores the original HTML.
 *  Async since Runner 0.87.0: the source read must not hold the Runner's main thread. */
export async function readArtifactPreview(filename, stat, view) {
  if (!view) return null
  if (!/\.(?:html?|css)$/i.test(filename)) return null
  if (view !== 'document' && !/^image:[a-f0-9]{64}$/.test(view)) throw new Error('invalid preview resource')
  if (stat.size > AH_SOURCE_BYTES) throw new Error('preview source too large')
  const key = filename + '\0' + stat.size + '\0' + stat.mtimeMs + '\0' + stat.ctimeMs
  const now = Date.now()
  for (const [k, entry] of ahCache) if (now - entry.at > 60_000) ahCache.delete(k)
  let entry = ahCache.get(key)
  if (!entry) {
    const paths = /^[a-z]:[\\/]/i.test(filename) ? ahPath.win32 : ahPath.posix
    const relUrl = abs => {
      const rel = paths.relative(paths.dirname(filename), abs).replace(/\\/g, '/')
      return rel.split('/').map(encodeURIComponent).join('/')
    }
    const self = encodeURIComponent(paths.basename(filename))
    const source = await ahFs.promises.readFile(filename, 'utf8')
    const css = /\.css$/i.test(filename)
    const prepared = prepareArtifactHtml(source, filename, id => `${self}?ot-inline=${id}`, relUrl)
    const html = prepared.html
    const document = { bytes: Buffer.from(html), mime: css ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' }
    const size = document.bytes.length + [...prepared.images.values()].reduce((n, image) => n + image.bytes.length, 0)
    entry = { document, images: prepared.images, size, at: now }
    let retained = [...ahCache.values()].reduce((n, item) => n + item.size, 0)
    for (const [k, item] of ahCache) {
      if (retained + size <= AH_CACHE_BYTES && ahCache.size < 4) break
      ahCache.delete(k); retained -= item.size
    }
    if (size <= AH_CACHE_BYTES) ahCache.set(key, entry)
  }
  entry.at = now
  const resource = view === 'document' ? entry.document : entry.images.get(view.slice(6))
  if (!resource) throw new Error('preview image not found')
  return resource
}
