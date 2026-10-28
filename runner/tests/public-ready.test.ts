// runner/ is published on its own. These checks keep it that way: it must build and test from a
// copy of this directory alone, its source is English, and it carries no private names.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNNER_ROOT } from './fixtures/runner-sources.mjs'

const SELF = path.relative(RUNNER_ROOT, __filename)
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite'])
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path.join(dir, entry.name))
    return [path.join(dir, entry.name)]
  })
}
const files = walk(RUNNER_ROOT).map(file => path.relative(RUNNER_ROOT, file).split(path.sep).join('/')).sort()
const read = (file: string) => fs.readFileSync(path.join(RUNNER_ROOT, file), 'utf8')
const isCode = (file: string) => /\.(mjs|ts)$/.test(file)

const CJK = /[　-〿一-鿿＀-￯]/
// Chinese that has to stay in source, each with the reason.
const CHINESE_ALLOWED: { file: string, line?: string, why: string }[] = [
  { file: 'core/opentandem-help.mjs', why: 'the help reference names the button labels of both UI languages so the agent can match what the user sees' },
  { file: 'core/machine-daemon.mjs', line: "'【本次指令】', '【近期对话结束】'", why: 'prompt markers written by older servers; they are parsed, not shown' },
  { file: 'core/machine-daemon.mjs', line: '|秒|分钟)', why: 'matches durations inside Chinese CLI error text' },
  { file: 'core/machine-daemon.mjs', line: '(?:title|标题)', why: 'strips a title label from model output in either language' },
  { file: 'core/machine-daemon.mjs', line: "[\"'“”‘’「」《》", why: 'strips Chinese quotation marks around a model-written title' },
]

describe('runner/ is publishable on its own', () => {
  it('keeps source English: Chinese lives only in core/locales', () => {
    const offending: string[] = []
    for (const file of files.filter(f => /^(core|adapters|build)\//.test(f) && !f.startsWith('core/locales/') && isCode(f))) {
      read(file).split('\n').forEach((line, index) => {
        if (!CJK.test(line)) return
        const allowed = CHINESE_ALLOWED.some(rule => rule.file === file && (!rule.line || line.includes(rule.line)))
        if (!allowed) offending.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offending).toEqual([])
  })

  it('names no private account, host or repository', () => {
    const banned = new RegExp(['duo' + 'qunet', 'zan' + 'ne', 'game' + 'geeker', 'mpweixin' + 'auto', '3654' + '15275'].join('|'), 'i')
    const offending: string[] = []
    for (const file of files.filter(f => f !== SELF && !/\.(png|jpe?g|gif|webp|ico|node|zip|gz)$/.test(f))) {
      read(file).split('\n').forEach((line, index) => {
        if (banned.test(line)) offending.push(`${file}:${index + 1}`)
      })
    }
    expect(offending).toEqual([])
  })

  it('imports nothing outside runner/, and only node: built-ins or declared dev dependencies', () => {
    const pkg = JSON.parse(read('package.json'))
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
    // Real import statements only (test data often contains import text inside strings).
    const specifier = /^\s*(?:import\s+|(?:import|export)\b[^'"\n]*?\bfrom\s*|\}\s*from\s*)(['"])([^'"\n]+)\1|\bawait import\(\s*(['"])([^'"\n]+)\3|new URL\(\s*(['"])(\.[^'"\n]*)\5\s*,\s*import\.meta\.url/gm
    const offending: string[] = []
    for (const file of files.filter(isCode)) {
      for (const match of read(file).matchAll(specifier)) {
        const spec = match[2] || match[4] || match[6]
        if (spec.startsWith('.')) {
          const target = path.resolve(RUNNER_ROOT, path.dirname(file), spec)
          if (path.relative(RUNNER_ROOT, target).startsWith('..')) offending.push(`${file}: ${spec}`)
        } else if (!spec.startsWith('node:') && /^(core|adapters|build)\//.test(file)) {
          offending.push(`${file}: ${spec} (the Runner itself uses node: built-ins only)`)
        } else if (!spec.startsWith('node:') && !declared.has(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')) && /^[@a-z]/.test(spec)) {
          offending.push(`${file}: ${spec} (not in package.json)`)
        }
      }
    }
    expect(offending).toEqual([])
  })

  it('reads no files above runner/', () => {
    // Paths built from __dirname or import.meta.url must stay inside the package.
    const climbing = /(?:__dirname|import\.meta\.dirname|RUNNER_ROOT)\s*,\s*(['"])\.\.\1\s*,\s*\1\.\.\1/
    const offending = files.filter(isCode).filter(file => {
      const depth = file.split('/').length - 1
      return read(file).split('\n').some(line => climbing.test(line) && depth < 2)
    })
    expect(offending).toEqual([])
  })
})
