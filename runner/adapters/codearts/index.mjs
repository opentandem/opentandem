// CodeArts Doer CLI (`codearts`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
import os from 'node:os'
import path from 'node:path'

export function createCodeArtsAdapter(ctx) {
  const { cliProbe } = ctx
  const CODEARTS_BIN = ctx.config('CODEARTS_BIN') || path.join(os.homedir(), '.codeartsdoer', 'installers', 'bin', 'codearts')

  async function collectCodeArts() {
    const version = await cliProbe(CODEARTS_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'codearts',
    executes: false,
    bin: () => CODEARTS_BIN,
    detect: collectCodeArts,
    install: {
      native: (real, home) => real.startsWith(`${home}/.codeartsdoer/installers/`),
      // Native installers ship one archive per OS and CPU.
      releasePlatform: true,
    },
  }
}
