// MCode CLI (`mcode`): detected and reported in the machine panel; it has no
// task execution support yet, so it is never offered as a runtime.
import fs from 'node:fs'
import path from 'node:path'

export function createMcodeAdapter(ctx) {
  const { cliProbe } = ctx
  const MCODE_BIN = ctx.config('MCODE_BIN') || 'mcode'
  const MCODE_ENTRY = (() => {
    const candidates = path.isAbsolute(MCODE_BIN)
      ? [MCODE_BIN]
      : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, MCODE_BIN))
    const executable = candidates.find(file => fs.existsSync(file)) || MCODE_BIN
    try { return fs.realpathSync(executable) } catch { return executable }
  })()

  async function collectMcode() {
    // Like DSH, mcode's env-node shim may select Homebrew Node 23 even though
    // this package supports Node 22/24/25/26. Run its JS entry with Runner Node.
    const version = await cliProbe(process.execPath, [MCODE_ENTRY, '--version'])
    if (!version.ok) return { installed: false, login: false, version: null }
    return { installed: true, login: true, version: version.stdout.trim().split('\n')[0] }
  }

  return {
    id: 'mcode',
    executes: false,
    bin: () => MCODE_BIN,
    detect: collectMcode,
  }
}
