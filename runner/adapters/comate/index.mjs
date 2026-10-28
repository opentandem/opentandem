// Comate CLI (`comatecli`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
export function createComateAdapter(ctx) {
  const { cliProbe } = ctx
  const COMATE_BIN = ctx.config('COMATE_BIN') || 'comatecli'

  async function collectComate() {
    const version = await cliProbe(COMATE_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'comate',
    executes: false,
    bin: () => COMATE_BIN,
    detect: collectComate,
  }
}
