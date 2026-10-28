// MiMo Code (`mimo`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
import os from 'node:os'
import path from 'node:path'

export function createMimoAdapter(ctx) {
  const { cliProbe } = ctx
  const MIMO_BIN = ctx.config('MIMO_BIN') || path.join(os.homedir(), '.mimocode', 'bin', 'mimo')

  async function collectMimo() {
    const version = await cliProbe(MIMO_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'mimo',
    executes: false,
    bin: () => MIMO_BIN,
    detect: collectMimo,
    install: {
      native: (real, home) => real.startsWith(`${home}/.mimocode/bin/`),
    },
  }
}
