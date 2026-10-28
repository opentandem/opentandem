import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

/**
 * Builds the single-file Runner that /api/daemon-script serves.
 *
 * Every Runner install downloads exactly one file, so every relative import
 * reachable from core/machine-daemon.mjs is followed and inlined here. Each
 * inlined module runs inside its own function scope and hands back only its
 * exports, so modules can no longer collide on top-level names. Node built-ins
 * imported by an inlined module come from process.getBuiltinModule (an import
 * statement is not allowed inside a function). The entry file keeps its own
 * top-level statements, including `const DAEMON_VERSION = '…'` at the start of
 * a line, which installers and self-update read.
 *
 * Supported module syntax, enforced with an error instead of a broken bundle:
 * imports only in the leading block of a file (after comments), with default,
 * namespace and named bindings; exports only as `export function`,
 * `export async function`, `export const|let|var|class <name>`. JSON modules
 * need `with { type: 'json' }`.
 */

const IDENT = /^[A-Za-z_$][\w$]*$/

function leadingImports(code, file) {
  const found = []
  let i = 0
  const n = code.length
  const skipTrivia = () => {
    for (;;) {
      while (i < n && /\s/.test(code[i])) i++
      if (i === 0 && code.startsWith('#!')) { const e = code.indexOf('\n'); i = e < 0 ? n : e; continue }
      if (code.startsWith('//', i)) { const e = code.indexOf('\n', i); i = e < 0 ? n : e; continue }
      if (code.startsWith('/*', i)) { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
      return
    }
  }
  for (;;) {
    skipTrivia()
    if (!/^import[\s{*]/.test(code.slice(i, i + 7))) break
    const match = /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2(\s+with\s*\{[^}]*\})?[ \t]*;?/.exec(code.slice(i))
    if (!match) throw new Error(`runner bundle: unsupported import in ${file} near: ${code.slice(i, i + 80)}`)
    found.push({
      start: i,
      end: i + match[0].length,
      clause: match[1].trim(),
      source: match[3],
      json: /type\s*:\s*['"]json['"]/.test(match[4] || ''),
    })
    i += match[0].length
  }
  return found
}

function parseClause(clause, file) {
  const bindings = []
  let rest = clause.trim()
  const braces = /\{([\s\S]*)\}\s*$/.exec(rest)
  if (braces) {
    for (const part of braces[1].split(',').map(p => p.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part)
      if (!m) throw new Error(`runner bundle: unsupported import binding "${part}" in ${file}`)
      bindings.push({ kind: 'named', imported: m[1], local: m[2] || m[1] })
    }
    rest = rest.slice(0, braces.index).replace(/,\s*$/, '').trim()
  }
  if (rest) {
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest)
    if (ns) bindings.push({ kind: 'namespace', local: ns[1] })
    else if (IDENT.test(rest)) bindings.push({ kind: 'default', local: rest })
    else throw new Error(`runner bundle: unsupported import clause "${clause}" in ${file}`)
  }
  return bindings
}

function moduleExports(code, file) {
  if (/^export\s*(?:\{|\*|default\b)/m.test(code)) {
    throw new Error(`runner bundle: ${file} uses an export form the bundle does not support`)
  }
  const names = new Set()
  for (const m of code.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of code.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  return [...names]
}

const isRelative = (source) => source.startsWith('./') || source.startsWith('../')
const isBuiltin = (source) => source.startsWith('node:')

function declare(bindings, source, builtin) {
  const lines = []
  const named = bindings.filter(b => b.kind === 'named')
  for (const b of bindings) {
    if (b.kind === 'default') lines.push(`const ${b.local} = ${builtin ? source : `${source}.default`}`)
    if (b.kind === 'namespace') lines.push(`const ${b.local} = ${source}`)
  }
  if (named.length) {
    lines.push(`const { ${named.map(b => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`)).join(', ')} } = ${source}`)
  }
  return lines.join('\n')
}

export async function buildRunnerBundle(entryFile, projectRoot = resolve(dirname(entryFile), '..')) {
  const records = new Map()
  const order = []
  const visiting = new Set()

  const load = async (file, entry) => {
    const existing = records.get(file)
    if (existing) return existing
    if (visiting.has(file)) throw new Error(`runner bundle: import cycle through ${relative(projectRoot, file)}`)
    visiting.add(file)
    const code = await readFile(file, 'utf-8')
    const json = file.endsWith('.json')
    const imports = json ? [] : leadingImports(code, relative(projectRoot, file))
    const record = {
      file, code, json, imports,
      exports: json || entry ? [] : moduleExports(code, relative(projectRoot, file)),
      name: '',
    }
    for (const statement of imports) {
      if (isRelative(statement.source)) {
        const target = resolve(dirname(file), statement.source)
        if (target.endsWith('.json') !== statement.json) {
          throw new Error(`runner bundle: ${relative(projectRoot, file)} must import JSON with { type: 'json' } and only JSON that way`)
        }
        await load(target, false)
      } else if (!isBuiltin(statement.source)) {
        throw new Error(`runner bundle: ${relative(projectRoot, file)} imports "${statement.source}"; the Runner may only use node: built-ins`)
      }
    }
    visiting.delete(file)
    records.set(file, record)
    if (!entry) {
      record.name = `__otModule${order.length + 1}`
      order.push(record)
    }
    return record
  }

  const entry = await load(resolve(entryFile), true)

  const importsFor = (record, inModule) => record.imports.map((statement) => {
    const bindings = parseClause(statement.clause, relative(projectRoot, record.file))
    if (isBuiltin(statement.source)) {
      return inModule ? declare(bindings, `process.getBuiltinModule(${JSON.stringify(statement.source)})`, true) : null
    }
    const target = records.get(resolve(dirname(record.file), statement.source))
    for (const b of bindings) {
      if (b.kind === 'named' && !target.exports.includes(b.imported)) {
        throw new Error(`runner bundle: ${relative(projectRoot, record.file)} imports "${b.imported}" which ${relative(projectRoot, target.file)} does not export`)
      }
      if (b.kind === 'default' && !target.json) {
        throw new Error(`runner bundle: ${relative(projectRoot, record.file)} default-imports ${relative(projectRoot, target.file)}, which has no default export`)
      }
    }
    return declare(bindings, target.name, false)
  })

  const replaceImports = (record, replacements, prefix = '') => {
    let code = record.code
    for (let index = record.imports.length - 1; index >= 0; index--) {
      const statement = record.imports[index]
      const replacement = replacements[index]
      if (replacement === null) continue
      const isFirstRelative = prefix && index === record.imports.findIndex(s => isRelative(s.source))
      code = code.slice(0, statement.start) + (isFirstRelative ? `${prefix}\n` : '') + replacement + code.slice(statement.end)
    }
    return code
  }

  const definitions = order.map((record) => {
    const label = relative(projectRoot, record.file)
    if (record.json) return `// bundled module: ${label}\nconst ${record.name} = { default: ${JSON.stringify(JSON.parse(record.code))} }`
    const body = replaceImports(record, importsFor(record, true)).replace(/^export\s+/gm, '')
    return `// bundled module: ${label}\nconst ${record.name} = (() => {\n${body}\nreturn { ${record.exports.join(', ')} }\n})()`
  })

  const code = entry.imports.some(statement => isRelative(statement.source))
    ? replaceImports(entry, importsFor(entry, false), definitions.join('\n\n'))
    : entry.code
  return markBundled(code, relative(projectRoot, entry.file))
}

// The entry declares `const RUNNER_BUNDLED = false` so that a source run can tell it is not the
// bundle (it must not self-update). Exactly one such line, or the build fails.
function markBundled(code, label) {
  const marker = /^const RUNNER_BUNDLED = false$/gm
  const count = code.match(marker)?.length || 0
  if (count !== 1) throw new Error(`runner bundle: ${label} must declare \`const RUNNER_BUNDLED = false\` exactly once (found ${count})`)
  return code.replace(marker, 'const RUNNER_BUNDLED = true')
}
