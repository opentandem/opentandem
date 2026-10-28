// TraeCode CLI (`trae-cli`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
import os from 'node:os'
import path from 'node:path'

export function createTraeCodeAdapter(ctx) {
  const { cliProbe } = ctx
  const TRAECODE_BIN = ctx.config('TRAECODE_BIN') || path.join(os.homedir(), '.local', 'bin', 'trae-cli')

  async function collectTraeCode() {
    const version = await cliProbe(TRAECODE_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'traecode',
    executes: false,
    bin: () => TRAECODE_BIN,
    detect: collectTraeCode,
    install: {
      native: (real, home) => real === `${home}/.local/bin/trae-cli` || real.startsWith(`${home}/.local/share/traecli/releases/`),
    },
  }
}
