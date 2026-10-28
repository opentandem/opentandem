// Qoder CLI (`qodercli`): detected and reported in the machine panel; it has no task
// execution support yet, so it is never offered as a runtime.
export function createQoderAdapter(ctx) {
  const { cliProbe } = ctx
  const QODER_BIN = ctx.config('QODER_BIN') || 'qodercli'

  async function collectQoder() {
    const version = await cliProbe(QODER_BIN, ['--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'qoder',
    executes: false,
    bin: () => QODER_BIN,
    detect: collectQoder,
    install: {
      native: (real, home) => real.startsWith(`${home}/.qoder/bin/`),
    },
  }
}
