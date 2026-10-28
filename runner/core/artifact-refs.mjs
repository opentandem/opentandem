// One parser for every artifact boundary: daemon upload, server fallback sync,
// and browser rendering. Keep this file dependency-free: /api/daemon-script
// inlines it into the downloaded zero-dependency daemon.
export const UPLOAD_TEXT_EXTS = [
  '.txt', '.md', '.json', '.csv', '.log',
  // Code
  '.py', '.js', '.ts', '.tsx', '.java', '.go', '.rs', '.c', '.h', '.cpp',
  '.php', '.rb', '.kt', '.swift', '.sh', '.sql', '.html', '.htm', '.css', '.vue',
  // Configuration
  '.yml', '.yaml', '.toml', '.ini', '.xml', '.conf', '.properties', '.example',
  // Data / notes
  '.ipynb', '.srt', '.vtt', '.eml', '.ics', '.rtf',
]

/**
 * Binary document attachments (up to MAX_UPLOAD_DOC_BYTES): they travel through the OSS binary relay
 * like images. The Runner writes them into the task workdir and puts the file path in the instruction,
 * so the runtime opens them with its file tools (Office / PDF / archives / databases / e-books).
 */
export const UPLOAD_BINARY_DOC_EXTS = [
  '.xlsx', '.xls', '.pdf', '.doc', '.docx', '.ppt', '.pptx',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  // OpenDocument / WPS
  '.odt', '.ods', '.odp', '.wps', '.et', '.dps',
  // Data files
  '.sqlite', '.db', '.parquet',
  // Certificates / keys: when the user attaches one on purpose, it is only relayed to the machine as a binary file; its contents are never injected into the prompt.
  '.pem',
  // E-books
  '.epub',
]

/** Content type stored on the OSS object (drives preview/download behavior).
 *  Text types default to text/plain — only listed ones carry their own. */
const DOC_MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/octet-stream',
  '.parquet': 'application/vnd.apache.parquet',
  '.pem': 'application/x-pem-file',
  '.epub': 'application/epub+zip',
}

/** OSS content type for a composer attachment of this extension. */
export function uploadDocMimeFor(ext) {
  return DOC_MIME_BY_EXT[ext]
  || (UPLOAD_TEXT_EXTS.includes(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
}

export const ARTIFACT_FILE_EXT_GROUP = 'png|jpe?g|gif|webp|svg|bmp|mp4|webm|mov|mp3|wav|m4a|ogg|oga|flac|aac|opus|wma|aiff?|amr|html?|md|txt|json|csv|log|pdf|' + [...UPLOAD_TEXT_EXTS, ...UPLOAD_BINARY_DOC_EXTS].map(ext => ext.slice(1)).join('|')
export const ARTIFACT_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']
export const ARTIFACT_AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus', 'wma', 'aif', 'aiff', 'amr']

export function artifactMaxBytes(filePath, defaultBytes = 20 * 1024 * 1024, documentBytes = 10 * 1024 * 1024) {
  const ext = '.' + (filePath.split('.').pop() || '').toLowerCase()
  return UPLOAD_BINARY_DOC_EXTS.includes(ext) ? documentBytes : defaultBytes
}

export function normalizeArtifactPath(value) {
  let result = value.trim()
  try { result = decodeURIComponent(result) } catch { /* literal percent in a filename */ }
  return result.replace(/^file:\/\//i, '')
}

const ARTIFACT_END_RE = new RegExp(`\\.(?:${ARTIFACT_FILE_EXT_GROUP})$`, 'i')
export function isArtifactPath(value) {
  const p = normalizeArtifactPath(value)
  if (/[\\/]/.test(p) && !/^(?:\/|[A-Z]:[\\/]|[^\s\\/]+[\\/])/i.test(p)) return false
  return !!p && !/[\r\n<>`]/.test(p) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(p.replace(/^[A-Z]:[\\/]/i, '/')) && ARTIFACT_END_RE.test(p)
}

const FILE_URL_RE = new RegExp(
  `\\bfile://(/(?:[\\w.\\-\\u4e00-\\u9fa5]+/)*[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${ARTIFACT_FILE_EXT_GROUP}))(?![\\w/])`,
  'gi',
)
const OSS_IMAGE_RE = /(?<![\w./\-\u4e00-\u9fa5])(oss:\/\/attachments\/(?:[\w.\-\u4e00-\u9fa5]+\/)*[\w.\-\u4e00-\u9fa5]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?![\w/])/gi
const WIN_FILE_RE = new RegExp(
  `(?<![\\w./\\-\\u4e00-\\u9fa5])[A-Z]:[\\\\/](?:[\\w.\\-\\u4e00-\\u9fa5]+[\\\\/])*[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${ARTIFACT_FILE_EXT_GROUP})(?![\\w/])`,
  'gi',
)
// A whole `~/…` counts as one path (a Chinese character may sit right in front of the `~`); the `/…` after `~` must not be split off on its own, otherwise it would point at a same-named path under the filesystem root.
const ABS_FILE_RE = new RegExp(
  `(?:(?<![\\w./\\-~])~|(?<![\\w./\\-\\u4e00-\\u9fa5~]))/(?:[\\w.\\-\\u4e00-\\u9fa5]+/)*[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${ARTIFACT_FILE_EXT_GROUP})(?![\\w/])`,
  'gi',
)
const REL_FILE_RE = new RegExp(
  `(?<![\\w/.:@%#?=-])(?:[\\w.\\-\\u4e00-\\u9fa5]+/)+[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${ARTIFACT_FILE_EXT_GROUP})(?![\\w/])`,
  'gi',
)
const BARE_FILE_RE = new RegExp(
  `(?<![\\w/.:@%#?=-])[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${ARTIFACT_FILE_EXT_GROUP})(?![\\w/])`,
  'gi',
)

/**
 * Return non-overlapping refs in source order. `path` always omits file://;
 * `raw` and source offsets preserve the original text for fail-closed UI.
 */
export function findArtifactRefs(text, options = {}) {
  const includeOss = options.includeOss !== false
  const includeBare = options.includeBare !== false
  const hits = []
  // Delimiters make spaces unambiguous; prefer these full refs over word scans.
  const delimited = /`([^`\r\n]+)`|\]\(<?([^\r\n]*?)>?\)|<([^<>\r\n]+)>/g
  for (const match of text.matchAll(delimited)) {
    const value = match[1] ?? match[2] ?? match[3]
    const normalized = normalizeArtifactPath(value)
    if (!isArtifactPath(value) || (!includeBare && !/[\\/]/.test(normalized))) continue
    const offset = match[0].indexOf(value)
    hits.push({ start: match.index + offset, end: match.index + offset + value.length, raw: value, path: normalized, kind: 'local' })
  }
  const explicit = [...hits]
  const specs = [
    [FILE_URL_RE, (m) => m[1], 'local'],
    ...(includeOss ? [[OSS_IMAGE_RE, (m) => m[1], 'oss']] : []),
    [WIN_FILE_RE, (m) => m[0], 'local'],
    [ABS_FILE_RE, (m) => m[0], 'local'],
    [REL_FILE_RE, (m) => m[0], 'local'],
    ...(includeBare ? [[BARE_FILE_RE, (m) => m[0], 'local']] : []),
  ]
  for (const [re, pathOf, kind] of specs) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) {
      if (explicit.some(hit => match.index < hit.end && match.index + match[0].length > hit.start)) continue
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        path: pathOf(match),
        kind,
      })
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const picked = []
  let end = -1
  for (const hit of hits) {
    if (hit.start >= end) {
      picked.push(hit)
      end = hit.end
    }
  }
  return picked
}

/**
 * When Chinese characters are glued to a path in the text (e.g. a sentence ending right before "tmp/a/b.png"
 * or "images/" followed by "00-cover.jpg"), the scan above takes those characters as the start of the path.
 * Lexically there is no way to tell whether they belong to the preceding sentence or to a directory/file name
 * (a file really named "cover01.png" exists), so the scan result is left alone. The caller tries the variants in
 * order against the disk / attachment records and the first one that exists wins: the original path first,
 * then the variants with 1, 2 … n leading Chinese characters removed from the first/last segment (fewer removed
 * comes first, so real names win). Only Chinese characters directly followed by an ASCII letter or digit are removed
 * (a name like "cover.png" is not touched).
 */
export function artifactPathVariants(filePath) {
  const lastAt = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1
  const firstAt = /^(?:[\\/]|~|[A-Za-z]:)/.test(filePath) ? -1 : 0
  // The run of Chinese characters at the start of each segment (directly followed by an ASCII letter or digit): anywhere from 0 to n of them may be part of a sentence; the longest (fewest removed) comes first.
  const runs = []
  for (const at of new Set([firstAt, lastAt])) {
    if (at < 0) continue
    const glued = /^[\u4e00-\u9fa5]+(?=\w)/.exec(filePath.slice(at))
    if (glued) runs.push({ at, length: Math.min(glued[0].length, 16) })
  }
  let combos = [[]]
  for (const run of runs) combos = combos.flatMap(done => Array.from({ length: run.length + 1 }, (_, drop) => [...done, { at: run.at, drop }]))
  const total = combo => combo.reduce((sum, cut) => sum + cut.drop, 0)
  return combos
    .sort((a, b) => total(a) - total(b))
    .map(combo => combo.reduceRight((value, cut) => value.slice(0, cut.at) + value.slice(cut.at + cut.drop), filePath))
}

/**
 * Never copy a credential file to OSS just because a message named its path.
 * `json` is on the whitelist and there is no directory boundary, so one line
 * like "credentials are in config/secrets.json" would otherwise ship the cloud AK/SK and
 * every LLM key into the bucket, silently.
 */
const SENSITIVE_RE = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|auth\.json$|\.netrc$|\.npmrc$|\.pypirc$|kubeconfig|[\w.\-]*(?:credential|secret|sysconfig|password|token)[\w.\-]*\.(?:[a-z0-9]+)$|[\w.\-]+\.(?:pem|key|p12|pfx|keystore)$)/i
const SENSITIVE_DIR_RE = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|config\/private)\//i

export function isSensitiveArtifact(filePath) {
  // Windows paths arrive with backslashes; the patterns are written for `/`.
  const p = String(filePath || '').replace(/\\/g, '/')
  return SENSITIVE_RE.test(p) || SENSITIVE_DIR_RE.test(p)
}

/**
 * How many files named in one agent reply are uploaded without a click when the
 * viewer is not at the machine. Files past this count are still listed (as
 * click-to-upload placeholders); sub-resources an HTML artifact pulls in are not
 * counted — they are parts of one preview, and dropping them would leave the
 * shell uploaded with a blank body.
 */
export const AUTO_UPLOAD_REFS_PER_MESSAGE = 20

export function isArtifactImage(filePath) {
  const ext = portableBasename(filePath).split('.').pop()?.toLowerCase() || ''
  return ARTIFACT_IMAGE_EXTS.includes(ext)
}

export function isPortableAbsolutePath(filePath) {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)
}

export function portableBasename(filePath) {
  return filePath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || filePath
}

export function portableDirname(filePath) {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return '.'
  if (index === 0) return trimmed[0]
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3)
  return trimmed.slice(0, index)
}

/** Resolve on the executing machine's path dialect, not the web server's OS. */
export function portableResolve(base, child = '') {
  const windows = /^[A-Za-z]:[\\/]/.test(child) || /^[A-Za-z]:[\\/]/.test(base)
  if (isPortableAbsolutePath(child)) base = ''
  const separator = windows ? '\\' : '/'
  const combined = `${base}${base && child ? separator : ''}${child}`.replace(windows ? /\//g : /\\/g, separator)
  const drive = windows ? (/^[A-Za-z]:/.exec(combined)?.[0] || '') : ''
  const rooted = windows ? !!drive : combined.startsWith('/')
  const rest = windows ? combined.slice(drive.length) : combined
  const parts = []
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') { if (parts.length) parts.pop(); continue }
    parts.push(part)
  }
  return `${drive}${rooted ? separator : ''}${parts.join(separator)}` || (rooted ? separator : '.')
}

const HOME_PREFIX_RE = /^(?:\/users\/[^/]+|\/home\/[^/]+|\/root|[a-z]:\/users\/[^/]+)\//

/** Full paths identify files; a relative suffix is usable only when unique. */
export function hasArtifactPath(filePath, available) {
  const candidates = [...available].map(value => portableResolve('', normalizeArtifactPath(value)).replace(/\\/g, '/').toLowerCase())
  // When Chinese characters are glued to a path, the scan returns the path with extra leading characters, while a registered attachment uses the real path: compare every variant, original path first.
  for (const variant of artifactPathVariants(normalizeArtifactPath(filePath))) {
    const key = portableResolve('', variant).replace(/\\/g, '/').toLowerCase()
    // `~/x` only matches x under the Runner machine's home (the page does not know which directory that is, so it accepts common home shapes); it is not treated as a suffix of an arbitrary directory.
    if (key.startsWith('~/')) {
      if (candidates.some(candidate => HOME_PREFIX_RE.test(candidate) && candidate.replace(HOME_PREFIX_RE, '') === key.slice(2))) return true
      continue
    }
    const absolute = isPortableAbsolutePath(key)
    let matches = 0
    for (const candidate of candidates) {
      if (candidate === key) return true
      if (!absolute && candidate.endsWith('/' + key)) matches++
    }
    if (matches === 1) return true
  }
  return false
}
