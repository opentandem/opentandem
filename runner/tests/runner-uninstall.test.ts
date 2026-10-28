import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNNER_ROOT } from './fixtures/runner-sources.mjs'

const daemon = readFileSync(resolve(RUNNER_ROOT, 'core/machine-daemon.mjs'), 'utf8')

describe('Runner self-cleanup handoff', () => {
  it('creates an independent, instance-scoped cleaner on all supported systems', () => {
    expect(daemon).toContain('function scheduleMacCleanup()')
    expect(daemon).toContain('com.opentandem.runner.cleanup.${RUNNER_INSTANCE}')
    expect(daemon).toContain("['bootstrap', domain, cleanupPlist]")
    expect(daemon).toContain('function scheduleLinuxCleanup()')
    expect(daemon).toContain("['--user', '--unit', unit, '--collect', '/bin/sh', '-c', command]")
    expect(daemon).toContain('function scheduleWindowsCleanup()')
    const windows = daemon.slice(daemon.indexOf('function scheduleWindowsCleanup()'), daemon.indexOf('function scheduleSelfCleanup()'))
    expect(windows).toContain("path.join(RUNNER_APP_DIR, 'opentandem-runner.ps1')")
    expect(windows).toContain('if (!fs.existsSync(manager)) return false')
    expect(windows).toContain("spawn('powershell.exe'")
    expect(windows).toContain('Start-Sleep -Seconds 2; & ${quotePowerShell(manager)} uninstall')
    expect(windows).toContain("{ detached: true, stdio: 'ignore', windowsHide: true }")
    expect(windows).toContain('child.unref()')
    const mac = daemon.slice(daemon.indexOf('function scheduleMacCleanup()'), daemon.indexOf('function scheduleLinuxCleanup()'))
    expect(mac.indexOf('/bin/rm -f ${quoteSh(cleanupPlist)}')).toBeLessThan(mac.indexOf('/bin/launchctl bootout ${quoteSh(domain + \'/\' + cleanupLabel)}'))
  })

  it('uses only locally-derived state and app paths for deletion', () => {
    const cleanup = daemon.slice(daemon.indexOf('function safeManagedRunner'), daemon.indexOf('async function beginSelfUninstall'))
    expect(cleanup).toContain('safeManagedRunner()')
    expect(cleanup).toContain('RUNNER_APP_DIR')
    expect(cleanup).not.toContain('directive.path')
    expect(cleanup).not.toContain('control.path')
    expect(cleanup).not.toContain('data.path')
  })
})
