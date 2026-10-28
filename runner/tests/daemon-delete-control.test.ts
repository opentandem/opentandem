import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNNER_ROOT } from './fixtures/runner-sources.mjs'

const daemon = readFileSync(resolve(RUNNER_ROOT, 'core/machine-daemon.mjs'), 'utf8')

describe('Runner deletion control state machine', () => {
  it('only enters deletion from a pinned-key directive and makes ordinary auth failures reconnect', () => {
    expect(daemon).toContain('function verifiedUninstallDirective(control, nonce)')
    expect(daemon).toContain('return verifyUninstallDirective(control, RUNNER_CONTROL_PUBLIC_KEY')
    expect(daemon).toContain('const uninstall = verifiedUninstallDirective(data?.control, controlNonce)')
    const authFailureHandler = daemon.slice(daemon.indexOf('function rejectManagedKey'), daemon.indexOf('const authHeaders = '))
    expect(authFailureHandler).toContain("writeManagedStatus('reconnecting'")
    expect(authFailureHandler).not.toContain('process.exit')
  })

  it('persists a marker before stopping local work and blocks every new daemon loop', () => {
    const uninstall = daemon.slice(daemon.indexOf('async function beginSelfUninstall'), daemon.indexOf('async function browseLoop'))
    expect(uninstall.indexOf('persistDeletionMarker(directive)')).toBeLessThan(uninstall.indexOf('runtimeStops()'))
    expect(uninstall).toContain('await localPreviewManager.closeAll()')
    expect(uninstall).toContain('scheduleSelfCleanup()')
    expect(daemon).toContain('if (runnerDeleting) return false')
    expect(daemon).toContain('if (globalThis.__sophonRunnerDeleting === true || outboxBusy) return')
    expect(daemon).toContain('if (runnerDeleting) return')
  })
})
