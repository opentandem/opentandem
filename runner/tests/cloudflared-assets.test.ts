import { describe, expect, it } from 'vitest'
import { CLOUDFLARED_ASSETS, cloudflaredAsset } from '../core/local-preview-runner.mjs'

describe('pinned preview connector distribution', () => {
  it.each([
    ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'],
    ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'],
  ] as const)('resolves %s/%s exclusively to our CDN with archive and binary integrity', (platform, arch) => {
    const asset = cloudflaredAsset(platform, arch)
    expect(new URL(asset.url).origin).toBe('https://ps4freetest.jiongtoutiao.com')
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(asset.binarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(asset.size).toBeGreaterThan(0)
    expect(asset.url).not.toContain('latest')
  })
  it('maps Windows ARM64 to the official x64 executable', () => {
    expect(cloudflaredAsset('win32', 'arm64')).toEqual(cloudflaredAsset('win32', 'x64'))
  })
  it('rejects unsupported targets before any download', () => {
    expect(() => cloudflaredAsset('linux', 'mips')).toThrow('unsupported architecture')
  })
  it('requires a separate extracted binary digest for each Mac archive', () => {
    for (const target of ['darwin-arm64', 'darwin-x64'] as const) {
      expect(CLOUDFLARED_ASSETS[target].sha256).not.toBe(CLOUDFLARED_ASSETS[target].binarySha256)
    }
  })
})
