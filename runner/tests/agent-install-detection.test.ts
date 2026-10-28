import { describe, expect, it, vi } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { stubAdapters } from './fixtures/adapter-context'

// Each agent's native install location, update channel and Homebrew formula are declared by its adapter
// (install.native and so on). Adapter modules use the real process.env and os.homedir(), so point HOME
// and CLAUDE_CONFIG_DIR at a temp directory.
const ADAPTERS = stubAdapters()

describe('Runner infers how an agent was installed, read-only', () => {
  it('follows the actual PATH binary, tells npm, Homebrew, native and unknown apart, and reads only the Claude channel', () => {
    const source = readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('function inferRuntimeInstallInfo(')
    expect(start, '缺少安装方式探测').toBeGreaterThan(-1)
    const end = source.indexOf('\n// The heartbeat ticks every 15s', start)
    const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'ot-agent-install-')))
    try {
      const home = path.join(root, 'home')
      const bin = path.join(root, 'bin')
      mkdirSync(bin, { recursive: true })
      mkdirSync(path.join(home, '.claude'), { recursive: true })
      writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable', account: 'never-return' }))
      vi.stubEnv('HOME', home)
      vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
      const targets = [
        ['codex', 'node_modules/@openai/codex/bin/codex.js'],
        ['claude', 'home/.local/share/claude/versions/2.1.1'],
        ['gemini', 'Cellar/gemini-cli/0.60.0/bin/gemini'],
        ['opencode', 'home/.opencode/bin/opencode'],
        ['custom', 'custom/bin/custom'],
      ]
      for (const [name, relative] of targets) {
        const target = path.join(root, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, '', { mode: 0o755 })
        symlinkSync(target, path.join(bin, name))
      }
      const context = vm.createContext({ fs, path, os: { homedir: () => home }, IS_WIN: false, process: { env: { PATH: bin } }, ADAPTERS })
      const infer = vm.runInContext(`${source.slice(start, end)}; inferRuntimeInstallInfo`, context)
      expect(infer('codex', 'codex', true, 'codex-cli 0.153.4')).toEqual({ install_method: 'npm', release_channel: 'latest' })
      expect(infer('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'stable' })
      expect(infer('gemini', 'gemini', true, '0.60.0')).toEqual({ install_method: 'homebrew', release_channel: 'latest' })
      expect(infer('opencode', 'opencode', true, '1.18.32')).toEqual({ install_method: 'native', release_channel: 'latest' })
      expect(infer('custom', 'codex', true, '1.0.0')).toEqual({ install_method: 'unknown' })
      expect(infer('codex', 'codex', false, null)).toEqual({ install_method: 'unknown' })
      const windowsNative = path.join(home, '.local', 'bin', 'claude.exe')
      mkdirSync(path.dirname(windowsNative), { recursive: true })
      writeFileSync(windowsNative, '')
      const winContext = vm.createContext({ fs, path, os: { homedir: () => home }, IS_WIN: true,
        process: { env: {} }, ADAPTERS, winResolveCommand: () => ({ file: windowsNative, prefix: [] }) })
      const inferWindows = vm.runInContext(`${source.slice(start, end)}; inferRuntimeInstallInfo`, winContext)
      expect(inferWindows('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'stable' })
      const extensionlessEntry = path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode')
      mkdirSync(path.dirname(extensionlessEntry), { recursive: true })
      writeFileSync(extensionlessEntry, '')
      Object.assign(winContext, { winResolveCommand: () => ({ file: '/node.exe', prefix: [extensionlessEntry] }) })
      expect(inferWindows('opencode', 'opencode', true, '1.18.32')).toEqual({ install_method: 'npm', release_channel: 'latest' })

      const customConfig = path.join(root, 'custom-config')
      mkdirSync(customConfig)
      writeFileSync(path.join(customConfig, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'latest' }))
      const configEnv = { PATH: bin, CLAUDE_CONFIG_DIR: customConfig }
      vi.stubEnv('CLAUDE_CONFIG_DIR', customConfig)
      const customContext = vm.createContext({ fs, path, os: { homedir: () => home }, IS_WIN: false, process: { env: configEnv }, ADAPTERS })
      const inferCustom = vm.runInContext(`${source.slice(start, end)}; inferRuntimeInstallInfo`, customContext)
      expect(inferCustom('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'latest' })
      for (const text of ['{}', '{"permissions":{"allow":[]}}']) {
        writeFileSync(path.join(customConfig, 'settings.json'), text)
        expect(inferCustom('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'latest' })
      }
      for (const text of ['{', 'null', '[]', '"latest"', '{"autoUpdatesChannel":"invalid"}', '{"autoUpdatesChannel":null}']) {
        writeFileSync(path.join(customConfig, 'settings.json'), text)
        expect(inferCustom('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'unknown' })
      }
      configEnv.CLAUDE_CONFIG_DIR = path.join(root, 'missing-config')
      vi.stubEnv('CLAUDE_CONFIG_DIR', configEnv.CLAUDE_CONFIG_DIR)
      expect(inferCustom('claude', 'claude', true, '2.1.1')).toEqual({ install_method: 'native', release_channel: 'unknown' })

      const cellar = path.join(root, 'Cellar', 'opencode', '1.18.32')
      const brewEntry = path.join(cellar, 'bin', 'opencode')
      mkdirSync(path.dirname(brewEntry), { recursive: true })
      writeFileSync(brewEntry, '', { mode: 0o755 })
      for (const tap of ['anomalyco/tap', 'homebrew/core']) {
        writeFileSync(path.join(cellar, 'INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap } }))
        expect(infer(brewEntry, 'opencode', true, '1.18.32')).toEqual({ install_method: 'homebrew', release_channel: 'latest', homebrew_formula: `${tap}/opencode` })
      }
      writeFileSync(path.join(cellar, 'INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'custom/tap' } }))
      expect(infer(brewEntry, 'opencode', true, '1.18.32')).toEqual({ install_method: 'homebrew', release_channel: 'latest' })
      rmSync(path.join(cellar, 'INSTALL_RECEIPT.json'))
      expect(infer(brewEntry, 'opencode', true, '1.18.32')).toEqual({ install_method: 'homebrew', release_channel: 'latest' })
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
  })
})
