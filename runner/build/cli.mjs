#!/usr/bin/env node
// Build the single-file Runner:
//   node build/cli.mjs [output file]   writes the bundle (default dist/runner.mjs)
//   node build/cli.mjs --self-test     writes it, then runs its self-test the way self-update checks a
//                                      candidate (placeholder credentials, a throwaway HOME, no server)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunnerBundle } from './bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const selfTest = process.argv.includes('--self-test')
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || resolve(root, 'dist', 'runner.mjs'))
const bundle = await buildRunnerBundle(resolve(root, 'core', 'machine-daemon.mjs'), root)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bundle, { mode: 0o755 })
console.log(`Runner bundle written to ${output} (${bundle.length} bytes)`)

if (selfTest) {
  const home = mkdtempSync(join(tmpdir(), 'ot-runner-self-test-'))
  try {
    const result = spawnSync(process.execPath, [output, 'self-test', '--server', 'http://127.0.0.1:9', '--id', 'self-test-machine', '--key', 'ot_self.test.key'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'inherit', timeout: 60_000,
    })
    process.exitCode = result.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
}
