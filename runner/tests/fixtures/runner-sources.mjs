// Where the Runner's source files live, for tests that inspect source text.
// Layout: core/ (the Runner itself and helpers shared by agents) and
// adapters/<name>/ (one directory per agent CLI).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CORE_DIR = path.join(RUNNER_ROOT, 'core')
export const AGENT_KIT_DIR = path.join(CORE_DIR, 'agent-kit')
export const ADAPTERS_DIR = path.join(RUNNER_ROOT, 'adapters')
export const DAEMON_FILE = path.join(CORE_DIR, 'machine-daemon.mjs')

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.mjs') ? [full] : []
  })
}

/** Every agent-side module: adapters plus the helpers they share. Sorted, absolute paths. */
export function adapterFiles() {
  return [...walk(ADAPTERS_DIR), ...walk(AGENT_KIT_DIR)].sort()
}

/** Every Runner module (core, agent kit and adapters). Sorted, absolute paths. */
export function runnerFiles() {
  return walk(RUNNER_ROOT).filter(file => !file.startsWith(path.join(RUNNER_ROOT, 'tests') + path.sep)
    && !file.startsWith(path.join(RUNNER_ROOT, 'node_modules') + path.sep)).sort()
}

/**
 * Absolute path of an agent-side module by its short name: an adapter directory
 * ('codex', 'trae-agent'), a shared helper ('kit', 'claude-stream') or a module
 * inside an adapter ('opencode/native-run'). A trailing '.mjs' is accepted.
 */
export function adapterPath(name) {
  const short = name.replace(/\.mjs$/, '')
  const candidates = [
    path.join(ADAPTERS_DIR, short, 'index.mjs'),
    path.join(ADAPTERS_DIR, `${short}.mjs`),
    path.join(AGENT_KIT_DIR, `${short}.mjs`),
  ]
  const found = candidates.find(file => fs.existsSync(file))
  if (!found) throw new Error(`No Runner agent module named ${name}`)
  return found
}

export const readAdapter = name => fs.readFileSync(adapterPath(name), 'utf8')
export const readDaemon = () => fs.readFileSync(DAEMON_FILE, 'utf8')
/** Core daemon followed by every agent-side module, the way older tests saw "the Runner source". */
export const readRunnerSource = () => [readDaemon(), ...adapterFiles().map(file => fs.readFileSync(file, 'utf8'))].join('\n')

/** The single-file Runner exactly as build/bundle.mjs produces it. */
export async function buildBundle() {
  const { buildRunnerBundle } = await import('../../build/bundle.mjs')
  return buildRunnerBundle(DAEMON_FILE, RUNNER_ROOT)
}
