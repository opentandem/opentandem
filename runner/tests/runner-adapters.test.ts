// Adapters (runner/adapters/) are code intended to be made public: English only, no internal terms or internal interfaces.
// User-facing and model-facing text always goes through ctx.t('English template'), which runner/core/messages.mjs maps to the existing Chinese text.
// This uses syntax analysis rather than text matching to check where t(...) comes from: when a local variable is named t, t('...') fails
// at runtime, and the golden-output comparison tests do not necessarily reach that path (Antigravity's model resolution hit this during the 2026-10-25 split).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as espree from 'espree'
import * as eslintScope from 'eslint-scope'
import { ADAPTER_MESSAGES_ZH } from '../core/messages.mjs'
import { RUNNER_ROOT, adapterFiles } from './fixtures/runner-sources.mjs'

// Paths relative to runner/, e.g. adapters/codex/index.mjs and core/agent-kit/kit.mjs.
const FILES = adapterFiles().map(file => path.relative(RUNNER_ROOT, file))
const source = (name: string) => fs.readFileSync(path.join(RUNNER_ROOT, name), 'utf8')

type Node = { type: string; [key: string]: unknown }
type Scope = { type: string; block: Node; through: Array<{ identifier: Node }>; references: Array<{ identifier: Node; resolved: { defs: Array<{ type: string; node: Node; name: Node }> } | null }>; childScopes: Scope[] }

function analyze(code: string) {
  const ast = espree.parse(code, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true }) as unknown as Node
  const manager = eslintScope.analyze(ast as never, { ecmaVersion: 2022, sourceType: 'module' }) as unknown as { globalScope: Scope }
  return { ast, scopes: manager.globalScope }
}

function walk(node: unknown, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, parent); return }
  const current = node as Node
  if (typeof current.type !== 'string') return
  visit(current, parent)
  for (const [key, value] of Object.entries(current)) {
    if (key !== 'parent' && value && typeof value === 'object') walk(value, visit, current)
  }
}

function allReferences(scope: Scope): Scope['references'] {
  return [...scope.references, ...scope.childScopes.flatMap(allReferences)]
}

// Runner capabilities that only the adapter context (not a run handler's ctx) provides.
const ADAPTER_ONLY_CTX = new Set([
  'config', 'configKey', 't', 'runnerVersion', 'runnerCommand', 'modelProbeCwd', 'sessionImport', 'toolServerSpec',
  'toolCommandDir', 'cachedModelProbe', 'maybeProbeModels', 'lastGoodStatus', 'hasLastGood', 'refreshShellPath',
  'titleTimeoutMs', 'titlePrompt', 'cleanTitle', 'windowsCommand', 'resolveExecutable', 'addPathDirs',
  'mimeFor', 'killProcessTree', 'processIdentity', 'runtimeStops', 'artifactSpoolPath', 'probeTui', 'probeCliOutput',
  'commandExists', 'systemHttpProxy', 'killCompactChild', 'SqliteDatabaseSync', 'VERSION_PROBE_MS', 'cliProbe',
  'execFileNow', 'systemExec', 'persistOverlay',
])

function allScopes(scope: Scope): Scope[] {
  return [scope, ...scope.childScopes.flatMap(allScopes)]
}

describe('Runner adapters are publishable as they are', () => {
  it('finds every adapter and shared agent module (an empty list would pass every check below)', () => {
    expect(FILES.filter(name => name.startsWith('adapters/') && name.endsWith('/index.mjs')).length).toBeGreaterThanOrEqual(25)
    expect(FILES).toContain('core/agent-kit/kit.mjs')
  })

  it('contain no Chinese text', () => {
    for (const name of FILES) {
      const lines = source(name).split('\n').flatMap((line, i) => (/\p{Script=Han}/u.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : []))
      expect(lines).toEqual([])
    }
  })

  it('contain no internal names or internal API paths', () => {
    // Built from fragments so this published file does not itself contain the private names.
    const banned = new RegExp(['sophon', 'ticket', 'game' + 'geeker', 'zan' + 'ne', 'duo' + 'qunet', String.raw`\/api\/(?:daemon|tasks|channels|machines|schedules|uploads|files|p2p|auth)\b`].join('|'), 'i')
    for (const name of FILES) {
      const lines = source(name).split('\n').flatMap((line, i) => (banned.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : []))
      expect(lines).toEqual([])
    }
  })

  it('translate every t() template, with the same placeholders', () => {
    const missing: string[] = []
    for (const name of FILES) {
      const { ast } = analyze(source(name))
      walk(ast, (node) => {
        if (node.type !== 'CallExpression') return
        const callee = node.callee as Node
        if (callee.type !== 'Identifier' || callee.name !== 't') return
        const [first] = node.arguments as Node[]
        if (first?.type !== 'Literal' || typeof first.value !== 'string') { missing.push(`${name}: t() needs a string literal template`); return }
        const template = first.value
        const zh = (ADAPTER_MESSAGES_ZH as Record<string, string>)[template]
        if (zh === undefined) { missing.push(`${name}: ${template}`); return }
        const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
        if (params(template) !== params(zh)) missing.push(`${name}: placeholders differ for ${template}`)
      })
    }
    expect(missing).toEqual([])
  })

  it('call t() only as the translator from the adapter context', () => {
    const wrong: string[] = []
    for (const name of FILES) {
      const { scopes } = analyze(source(name))
      for (const ref of allReferences(scopes)) {
        if ((ref.identifier as Node).name !== 't') continue
        const def = ref.resolved?.defs[0]
        // From the adapter context, or (inside a create<Name>Files factory) from its io.
        const init = (def?.node as Node | undefined)?.init as Node | undefined
        const fromCtx = def?.type === 'Variable' && init?.type === 'Identifier' && (init.name === 'ctx' || init.name === 'io')
        const fromFactoryParam = def?.type === 'Parameter' && /^create/.test(String(((def.node as Node).id as Node | undefined)?.name || ''))
        if (!fromCtx && !fromFactoryParam) wrong.push(`${name}:${((ref.identifier as Node).loc as { start: { line: number } }).start.line}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('never reach adapter-context members through a run handler ctx', () => {
    const wrong: string[] = []
    for (const name of FILES) {
      const { ast } = analyze(source(name))
      walk(ast, (node) => {
        if (node.type !== 'FunctionDeclaration' && node.type !== 'FunctionExpression' && node.type !== 'ArrowFunctionExpression') return
        const params = node.params as Node[]
        if (params[0]?.type !== 'Identifier' || params[0].name !== 'ctx') return
        if (/^create/.test(String((node.id as Node | null)?.name || ''))) return
        walk(node.body, (inner) => {
          if (inner.type !== 'MemberExpression') return
          const object = inner.object as Node
          const property = inner.property as Node
          if (object.type === 'Identifier' && object.name === 'ctx' && property.type === 'Identifier' && ADAPTER_ONLY_CTX.has(String(property.name))) {
            wrong.push(`${name}:${(inner.loc as { start: { line: number } }).start.line} ctx.${property.name}`)
          }
        })
      })
    }
    expect(wrong).toEqual([])
  })

  // The Runner also builds each create<Name>Files factory on its scan thread from the function's
  // text (ownFiles, docs/runner-adapters.md): there it sees only `io`, its own arguments and JS globals.
  it('keep every files factory self-contained', () => {
    const globals = new Set([...Object.getOwnPropertyNames(globalThis), 'process', 'Buffer', 'console', 'setTimeout', 'clearTimeout', 'URL'])
    const free: string[] = []
    for (const name of FILES) {
      const { scopes } = analyze(source(name))
      for (const scope of allScopes(scopes)) {
        const id = String(((scope.block as Node).id as Node | null)?.name || '')
        if (scope.type !== 'function' || !/^create\w+Files$/.test(id)) continue
        for (const ref of scope.through) {
          const variable = String((ref.identifier as Node).name)
          if (!globals.has(variable)) free.push(`${name}:${((ref.identifier as Node).loc as { start: { line: number } }).start.line} ${id} uses ${variable}`)
        }
      }
    }
    expect(free).toEqual([])
  })
})
