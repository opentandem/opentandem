import { describe, expect, it } from 'vitest'
import {
  artifactPathVariants,
  hasArtifactPath,
  findArtifactRefs,
  isPortableAbsolutePath,
  isSensitiveArtifact,
  AUTO_UPLOAD_REFS_PER_MESSAGE,
  portableBasename,
  portableResolve,
} from '../core/artifact-refs.mjs'

describe('shared artifact ref parser', () => {
  it('normalizes file:// and keeps the source span', () => {
    const source = '验收 file:///Users/alex/tmp/demo.html。'
    expect(findArtifactRefs(source, { includeOss: false })).toEqual([{
      start: 3,
      end: 35,
      raw: 'file:///Users/alex/tmp/demo.html',
      path: '/Users/alex/tmp/demo.html',
      kind: 'local',
    }])
  })

  it('collects absolute, relative and bare refs once without inner overlaps', () => {
    const refs = findArtifactRefs('/tmp/out/a.png tmp/out/b.html cover.jpg', { includeOss: false })
    expect(refs.map((r) => r.path)).toEqual(['/tmp/out/a.png', 'tmp/out/b.html', 'cover.jpg'])
  })

  it('recognizes audio artifacts', () => {
    const refs = findArtifactRefs('试听 /tmp/out/pain-emotion.mp3 和 tmp/out/voice.wav', { includeOss: false })
    expect(refs.map((r) => r.path)).toEqual(['/tmp/out/pain-emotion.mp3', 'tmp/out/voice.wav'])
  })

  it('can include OSS images and exclude bare filenames for UI cards', () => {
    const refs = findArtifactRefs('oss://attachments/t/a.png cover.png /tmp/b.pdf', { includeBare: false })
    expect(refs.map((r) => r.path)).toEqual(['oss://attachments/t/a.png', '/tmp/b.pdf'])
  })

  it('recognizes native Windows artifact paths', () => {
    const refs = findArtifactRefs(String.raw`输出 C:\Users\runner\work\report.html 和 D:/tmp/cover.png`, { includeOss: false })
    expect(refs.map((r) => r.path)).toEqual([
      String.raw`C:\Users\runner\work\report.html`,
      'D:/tmp/cover.png',
    ])
  })

  it('handles POSIX and Windows paths without depending on the server OS', () => {
    expect(isPortableAbsolutePath('/tmp/report.html')).toBe(true)
    expect(isPortableAbsolutePath(String.raw`C:\Users\runner\report.html`)).toBe(true)
    expect(portableBasename(String.raw`C:\Users\runner\report.html`)).toBe('report.html')
    expect(portableResolve(String.raw`C:\Users\runner\work`, String.raw`out\report.html`))
      .toBe(String.raw`C:\Users\runner\work\out\report.html`)
    expect(portableResolve('/srv/project', 'out/report.html')).toBe('/srv/project/out/report.html')
  })
})

// Per-message artifact guards (2026-09-17). `json` is on the extension
// whitelist and uploads have no directory boundary, so a single sentence
// naming a credentials file used to copy it into the OSS bucket silently.
describe('isSensitiveArtifact', () => {
  const blocked = [
    '/Users/alex/code/myrepo/config/sysconfig.json',
    '/Users/alex/code/myrepo/team-agent/.env.local',
    '/Users/alex/code/myrepo/config/private/vendor_feed.env',
    '/Users/alex/code/myrepo/team-agent/keys/hk.pem',
    '/Users/alex/.ssh/id_rsa',
    '/tmp/aliyun-credentials.json',
    '/tmp/reports/api-token.txt',
  ]
  const allowed = [
    '/Users/alex/code/myrepo/team-agent/tmp/sidebar-type-demo.html',
    '/tmp/out/report.md',
    '/tmp/out/cover.png',
    '/tmp/reports/ggsel-feed-backfill-latest.json',
    '/Users/alex/code/myrepo/team-agent/CLAUDE.md',
  ]
  for (const p of blocked) it(`refuses ${p}`, () => expect(isSensitiveArtifact(p)).toBe(true))
  for (const p of allowed) it(`allows ${p}`, () => expect(isSensitiveArtifact(p)).toBe(false))
})

describe('AUTO_UPLOAD_REFS_PER_MESSAGE', () => {
  it('is how many named files auto-upload per reply', () => {
    expect(AUTO_UPLOAD_REFS_PER_MESSAGE).toBe(20)
  })
})

describe('Han characters stuck to a path (artifactPathVariants)', () => {
  it('the original path comes first, followed by variants with the Han-character prefix stripped, fewer stripped first', () => {
    expect(artifactPathVariants('也交付本地tmp/a.png')).toEqual([
      '也交付本地tmp/a.png', '交付本地tmp/a.png', '付本地tmp/a.png', '本地tmp/a.png', '地tmp/a.png', 'tmp/a.png',
    ])
    expect(artifactPathVariants('images/含00-cover.jpg')).toEqual(['images/含00-cover.jpg', 'images/00-cover.jpg'])
  })
  it('no variants are generated when the Han characters are not followed by a letter or digit (a Han-character name + .png) or when the whole segment is a Han-character directory', () => {
    expect(artifactPathVariants('封面.png')).toEqual(['封面.png'])
    expect(artifactPathVariants('方案设计/a.md')).toEqual(['方案设计/a.md'])
    expect(artifactPathVariants('tmp/a.png')).toEqual(['tmp/a.png'])
  })
  it('hasArtifactPath: when the attachment is registered with the real path, a scan result with a Han-character prefix also counts as registered; unrelated files do not', () => {
    const registered = ['/work/tmp/codex/x/login-qrcode.png']
    expect(hasArtifactPath('也交付本地tmp/codex/x/login-qrcode.png', registered)).toBe(true)
    expect(hasArtifactPath('也交付本地tmp/codex/x/other.png', registered)).toBe(false)
    expect(hasArtifactPath('/work/封面01.png', ['/work/封面01.png'])).toBe(true)
  })
})

describe('three real cases (original text of scheduled-task prompts)', () => {
  const prompt = '二维码已发企微，也交付本地tmp/codex/switch-top100-04/login-qrcode.png；13:47仍有等待扫码进程。'
    + '现有5图已完整同步~/tmp/wxmp_switch_top100_04/，images/含00-cover.jpg、031-032.jpg；'
    + '没有则python3 ~/tmp/wxmp_switch_top100_04/send-wx-preview.py create；'
  const paths = findArtifactRefs(prompt, { includeBare: false }).map(ref => ref.path)
  it('a path starting with ~/ is recognized as a whole and not cut into one starting with /', () => {
    expect(paths).toContain('~/tmp/wxmp_switch_top100_04/send-wx-preview.py')
    expect(paths).not.toContain('/tmp/wxmp_switch_top100_04/send-wx-preview.py')
  })
  it('a path with Han characters stuck to it is still recognized as is, and the runner machine finds the real file from the candidates', () => {
    expect(paths).toContain('也交付本地tmp/codex/switch-top100-04/login-qrcode.png')
  })
  it('a ~/ path only matches the same path under home, not as a suffix of an arbitrary directory', () => {
    expect(hasArtifactPath('~/tmp/a/b.py', ['/Users/alex/tmp/a/b.py'])).toBe(true)
    expect(hasArtifactPath('~/tmp/a/b.py', ['/Users/alex/code/proj/tmp/a/b.py'])).toBe(false)
    expect(hasArtifactPath('~/tmp/a/b.py', ['C:\\Users\\alex\\tmp\\a\\b.py'])).toBe(true)
  })
  it('ordinary absolute paths and a leading / at line start are recognized as before', () => {
    expect(findArtifactRefs('见 /Users/alex/a/b.png 和\n/tmp/c.png').map(ref => ref.path)).toEqual(['/Users/alex/a/b.png', '/tmp/c.png'])
  })
})
