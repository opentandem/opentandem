// MetaCode CLI (`metacode`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
import os from 'node:os'
import path from 'node:path'

export function createMetaCodeAdapter(ctx) {
  const { cliProbe } = ctx
  const METACODE_BIN = ctx.config('METACODE_BIN') || path.join(os.homedir(), '.local', 'bin', 'metacode')

  async function collectMetaCode() {
    const version = await cliProbe(METACODE_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'metacode',
    executes: false,
    bin: () => METACODE_BIN,
    detect: collectMetaCode,
    install: {
      native: (real, home) => real === `${home}/.local/bin/metacode`,
    },
  }
}
