// Read installed Codex, Claude Code and OpenCode plugin metadata locally.
// Never start a CLI, import extension code, or fetch a remote catalog.
// Aliased built-ins keep this module safe to inline in the standalone Runner.
import pluginFs from 'node:fs'
import pluginPath from 'node:path'
import pluginOs from 'node:os'
import pluginCrypto from 'node:crypto'
import { fileURLToPath as pluginFileURLToPath } from 'node:url'

function pluginReadJson(file) {
  try { return JSON.parse(pluginFs.readFileSync(file, 'utf8')) } catch { return null }
}

function pluginDirectories(dir) {
  try {
    return pluginFs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map(entry => entry.name)
  } catch { return [] }
}

/** The supported [plugins."name@marketplace"] sections contain the user override.
 * Remote installs have a separate installation marker and default to enabled. */
function pluginEnabledOverrides(codexHome) {
  let config = ''
  try { config = pluginFs.readFileSync(pluginPath.join(codexHome, 'config.toml'), 'utf8') } catch {}
  const enabled = new Map()
  let id = null
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      id = line.match(/^\s*\[plugins\.(["'])(.+?)\1\]\s*(?:#.*)?$/)?.[2] || null
    } else if (id) {
      const match = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/)
      if (match) enabled.set(id, match[1] === 'true')
    }
  }
  return enabled
}

function pluginScanCodexEntries(codexHome = process.env.CODEX_HOME || pluginPath.join(pluginOs.homedir(), '.codex')) {
  const cache = pluginPath.join(codexHome, 'plugins', 'cache')
  const enabled = pluginEnabledOverrides(codexHome)
  const skills = []
  for (const marketplace of pluginDirectories(cache)) {
    for (const plugin of pluginDirectories(pluginPath.join(cache, marketplace))) {
      const installed = pluginPath.join(cache, marketplace, plugin)
      const id = `${plugin}@${marketplace}`
      if (enabled.get(id) === false) continue
      // An uninstalled plugin can leave cached bundles. Only explicit local installs
      // or Codex's remote installation marker make a bundle eligible.
      if (enabled.get(id) !== true && !pluginReadJson(pluginPath.join(installed, '.codex-remote-plugin-install.json'))) continue
      const versions = pluginDirectories(installed).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      const root = versions.map(version => pluginPath.join(installed, version)).find(dir =>
        pluginFs.existsSync(pluginPath.join(dir, 'plugin.json')) ||
        pluginFs.existsSync(pluginPath.join(dir, '.codex-plugin', 'plugin.json')))
      if (!root) continue
      const portable = pluginReadJson(pluginPath.join(root, 'plugin.json'))
      const manifest = portable || pluginReadJson(pluginPath.join(root, '.codex-plugin', 'plugin.json'))
      if (!manifest || typeof manifest.name !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(manifest.name)) continue
      const manifestFile = portable ? pluginPath.join(root, 'plugin.json') : pluginPath.join(root, '.codex-plugin', 'plugin.json')
      skills.push({ name: `codex.${manifest.name}`, displayName: manifest.displayName || manifest.name, description: manifest.description || '', source: 'plugin', kind: 'plugin', runtime: 'codex', dir: root, manifest: manifestFile, selectable: true, real: pluginFs.realpathSync(root), hash: manifestFile })
      const paths = portable ? ['./skills'] : typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : []
      const seen = new Set()
      for (const subdir of paths) {
        if (typeof subdir !== 'string' || !subdir.startsWith('./')) continue
        const dir = pluginPath.resolve(root, subdir)
        if (!dir.startsWith(root + pluginPath.sep)) continue
        for (const folder of pluginDirectories(dir)) {
          const skillDir = pluginPath.join(dir, folder)
          try {
            if (!pluginInside(root, pluginPath.join(skillDir, 'SKILL.md'))) continue
            const content = pluginFs.readFileSync(pluginPath.join(skillDir, 'SKILL.md'), 'utf8')
            const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
            const name = fm?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
            if (!name || !/^[\p{L}\p{N}_:.-]+$/u.test(name) || seen.has(name)) continue
            let description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
            if (/^[|>][-+]?$/.test(description)) {
              description = fm.match(/^description:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1]?.trim().replace(/\s+/g, ' ') || ''
            } else description = description.replace(/^(["'])(.*)\1$/, '$2')
            seen.add(name)
            skills.push({
              name: `${manifest.name}:${name}`, description, source: 'plugin', dir: skillDir,
              kind: 'skill', runtime: 'codex', pluginName: `codex.${manifest.name}`, file: pluginPath.join(skillDir, 'SKILL.md'),
              real: pluginFs.realpathSync(skillDir),
              hash: pluginCrypto.createHash('sha1').update(content).digest('hex'),
            })
          } catch { /* unreadable or incomplete bundle: omit it */ }
        }
      }
    }
  }
  return skills
}

// Keep the existing Codex skill scanner's contract; the installed catalog also
// contains selectable plugin roots and separately labelled command files.
export function scanCodexPluginSkills(codexHome) {
  return pluginScanCodexEntries(codexHome).filter(entry => entry.kind === 'skill')
}

function pluginFrontmatter(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const value = key => {
    let text = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() || ''
    if (/^[|>][-+]?$/.test(text)) text = fm.match(new RegExp(`^${key}:[^\\n]*\\n((?:[ \\t]+[^\\n]*\\n?)*)`, 'm'))?.[1]?.trim().replace(/\s+/g, ' ') || ''
    return text.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { name: value('name'), description: value('description') }
}

// JSONC comments and trailing commas are accepted without evaluating config.
function pluginReadConfig(file) {
  try {
    const input = pluginFs.readFileSync(file, 'utf8')
    let output = '', quoted = false, escaped = false
    for (let i = 0; i < input.length; i++) {
      const c = input[i]
      if (quoted) { output += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
      if (c === '"') { quoted = true; output += c; continue }
      if (c === '/' && input[i + 1] === '/') { while (i + 1 < input.length && input[i + 1] !== '\n') i++; output += ' '; continue }
      if (c === '/' && input[i + 1] === '*') { i += 2; while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++; i++; output += ' '; continue }
      output += c
    }
    let clean = ''; quoted = false; escaped = false
    for (let i = 0; i < output.length; i++) {
      const c = output[i]
      if (quoted) { clean += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
      if (c === '"') quoted = true
      if (c === ',' && /^\s*[}\]]/.test(output.slice(i + 1))) continue
      clean += c
    }
    return JSON.parse(clean)
  } catch { return null }
}

function pluginInside(root, file) {
  try {
    const base = pluginFs.realpathSync(root), real = pluginFs.realpathSync(file)
    return real === base || real.startsWith(base + pluginPath.sep)
  } catch { return false }
}

function pluginInstructionEntries(root, manifest, name, runtime) {
  const out = [], seen = new Set()
  for (const [kind, field, fallback] of [['skill', 'skills', './skills'], ['command', 'commands', './commands']]) {
    const configured = manifest[field]
    const paths = typeof configured === 'string' ? [configured] : Array.isArray(configured) ? configured : [fallback]
    // Claude's custom paths supplement the standard directories.
    for (const relative of new Set([fallback, ...paths])) {
      if (typeof relative !== 'string' || pluginPath.isAbsolute(relative)) continue
      const dir = pluginPath.resolve(root, relative)
      if (!pluginInside(root, dir)) continue
      let files = []
      try {
        if (pluginFs.statSync(dir).isFile()) files = [dir]
        else if (kind === 'skill') {
          if (pluginFs.existsSync(pluginPath.join(dir, 'SKILL.md'))) files.push(pluginPath.join(dir, 'SKILL.md'))
          files.push(...pluginDirectories(dir).map(folder => pluginPath.join(dir, folder, 'SKILL.md')))
        } else files = pluginFs.readdirSync(dir).filter(file => file.endsWith('.md')).map(file => pluginPath.join(dir, file))
      } catch { continue }
      for (const file of files) {
        try {
          if (!pluginInside(root, file)) continue
          const content = pluginFs.readFileSync(file, 'utf8'), fm = pluginFrontmatter(content)
          const child = fm.name || (kind === 'command' ? pluginPath.basename(file, '.md') : '')
          if (!/^[\p{L}\p{N}_.-]+$/u.test(child)) continue
          const id = kind === 'command' ? `${name}:command.${child}` : `${name}:${child}`
          if (seen.has(id)) continue
          seen.add(id)
          out.push({ name: id, displayName: child, description: fm.description, source: 'plugin', kind, runtime, pluginName: name, pluginRoot: root, dir: pluginPath.dirname(file), file, real: pluginFs.realpathSync(file), hash: pluginCrypto.createHash('sha1').update(content).digest('hex') })
        } catch { /* malformed or unreadable instruction */ }
      }
    }
  }
  return out
}

function pluginScanClaude(home, workdirs) {
  const configHome = process.env.CLAUDE_CONFIG_DIR || pluginPath.join(home, '.claude')
  const registry = pluginReadJson(pluginPath.join(configHome, 'plugins', 'installed_plugins.json'))
  const settings = pluginReadJson(pluginPath.join(configHome, 'settings.json')) || {}
  const out = []
  for (const [id, installs] of Object.entries(registry?.plugins || {})) {
    if (!Array.isArray(installs)) continue
    for (const install of installs) {
      if (!install || typeof install.installPath !== 'string') continue
      const project = install.projectPath
      if (project && !workdirs.some(w => w === project || w.startsWith(project + pluginPath.sep))) continue
      const contexts = project ? [project] : workdirs.length ? workdirs : [null]
      const enabled = contexts.some(w => {
        const overrides = w ? { ...settings.enabledPlugins, ...pluginReadJson(pluginPath.join(w, '.claude/settings.json'))?.enabledPlugins, ...pluginReadJson(pluginPath.join(w, '.claude/settings.local.json'))?.enabledPlugins } : settings.enabledPlugins
        return overrides?.[id] === true
      })
      if (!enabled) continue
      const root = pluginPath.resolve(install.installPath), manifestFile = pluginPath.join(root, '.claude-plugin/plugin.json')
      const manifest = pluginReadJson(manifestFile)
      if (!manifest || !/^[\p{L}\p{N}_.-]+$/u.test(manifest.name)) continue
      const name = `claude-code.${manifest.name}${project ? '.' + pluginCrypto.createHash('sha1').update(project).digest('hex').slice(0, 8) : ''}`
      const children = pluginInstructionEntries(root, manifest, name, 'claude')
      out.push({ name, displayName: manifest.name, description: manifest.description || '', source: 'plugin', kind: 'plugin', runtime: 'claude', dir: root, manifest: manifestFile, selectable: true, real: manifestFile, hash: id, ...(project ? { workdir: project } : {}) }, ...children.map(child => ({ ...child, ...(project ? { workdir: project } : {}) })))
    }
  }
  return out
}

function pluginScanOpenCode(home, workdirs) {
  const configDir = process.env.OPENCODE_CONFIG_DIR || pluginPath.join(process.env.XDG_CONFIG_HOME || pluginPath.join(home, '.config'), 'opencode')
  const cacheDir = pluginPath.join(process.env.XDG_CACHE_HOME || pluginPath.join(home, '.cache'), 'opencode', 'node_modules')
  const dirs = [configDir, ...workdirs.flatMap(w => [w, pluginPath.join(w, '.opencode')])]
  const out = [], seen = new Set()
  const add = (root, file, label, workdir) => {
    if (!pluginFs.existsSync(root) || !pluginFs.existsSync(file)) return
    const real = pluginFs.realpathSync(file)
    if (seen.has(real)) return
    seen.add(real)
    const manifestFile = pluginPath.join(root, 'package.json'), manifest = pluginReadJson(manifestFile) || {}
    const slug = label.replace(/[^\p{L}\p{N}_.-]+/gu, '.')
    const name = `opencode.${slug}.${pluginCrypto.createHash('sha1').update(real).digest('hex').slice(0, 8)}`
    const children = pluginInstructionEntries(root, manifest, name, 'opencode')
    // Code extensions run at CLI startup. Listing one must never pretend that
    // sending a path loads its hooks or installs its npm package.
    out.push({ name, displayName: label, description: manifest.description || '', source: 'plugin', kind: 'plugin', runtime: 'opencode', dir: root, ...(pluginFs.existsSync(manifestFile) ? { manifest: manifestFile } : {}), file, selectable: children.length > 0, real, hash: real, ...(workdir ? { workdir } : {}) }, ...children.map(child => ({ ...child, ...(workdir ? { workdir } : {}) })))
  }
  for (const dir of dirs) {
    const workdir = workdirs.find(w => dir === w || dir === pluginPath.join(w, '.opencode'))
    const local = pluginPath.join(dir, 'plugins')
    try {
      for (const file of (dir === workdir ? [] : pluginFs.readdirSync(local)).filter(f => /\.(?:[cm]?js|ts)$/.test(f))) {
        // Keep each local extension isolated; unrelated skills beside the
        // plugins directory do not become children of every extension.
        add(local, pluginPath.join(local, file), pluginPath.basename(file).replace(/\.[^.]+$/, ''), workdir)
      }
    } catch {}
    const files = ['opencode.json', 'opencode.jsonc'].map(f => pluginPath.join(dir, f))
    if (dir === configDir && process.env.OPENCODE_CONFIG) files.push(process.env.OPENCODE_CONFIG)
    for (const configFile of files) {
      const plugins = pluginReadConfig(configFile)?.plugin
      if (!Array.isArray(plugins)) continue
      for (const spec of plugins) {
        if (typeof spec !== 'string') continue
        if (spec.startsWith('file://') || spec.startsWith('./') || pluginPath.isAbsolute(spec)) {
          let file
          try {
            file = spec.startsWith('file://') ? pluginFileURLToPath(spec) : pluginPath.resolve(dir, spec)
            if (pluginFs.statSync(file).isDirectory()) add(file, pluginPath.join(file, 'package.json'), pluginPath.basename(file), workdir)
            else add(pluginPath.dirname(file), file, pluginPath.basename(file).replace(/\.[^.]+$/, ''), workdir)
          } catch {}
          continue
        }
        const pkg = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/)?.[1]
        if (!pkg || pkg.includes('..') || (!pkg.startsWith('@') && /[/\\]/.test(pkg))) continue
        const root = [pluginPath.join(dir, 'node_modules', pkg), pluginPath.join(cacheDir, pkg)].find(p => pluginFs.existsSync(pluginPath.join(p, 'package.json')))
        if (root) add(root, pluginPath.join(root, 'package.json'), pkg, workdir)
      }
    }
  }
  return out
}

/** @param {{home?: string, workdirs?: string[], codexHome?: string}} [options] */
export function scanInstalledPluginEntries({ home = pluginOs.homedir(), workdirs = [], codexHome = process.env.CODEX_HOME || pluginPath.join(home, '.codex') } = {}) {
  return [...pluginScanCodexEntries(codexHome), ...pluginScanClaude(home, workdirs), ...pluginScanOpenCode(home, workdirs)]
}

/** Function text of the installed-plugin scan for the Runner's scan thread: an
 *  eval worker has no module scope, so it gets the module's own helpers verbatim. */
export function pluginScanWorkerSource() {
  return [
    "const pluginFs = require('node:fs'), pluginPath = require('node:path'), pluginOs = require('node:os'), pluginCrypto = require('node:crypto');",
    "const { fileURLToPath: pluginFileURLToPath } = require('node:url');",
    ...[pluginReadJson, pluginDirectories, pluginEnabledOverrides, pluginScanCodexEntries, pluginFrontmatter, pluginReadConfig,
      pluginInside, pluginInstructionEntries, pluginScanClaude, pluginScanOpenCode, scanInstalledPluginEntries, pluginEntryPrompt].map(fn => fn.toString()),
  ].join('\n')
}

/** Paths come exclusively from a fresh machine-local installed catalog. */
export function pluginEntryPrompt(entry) {
  if (entry.kind !== 'plugin') {
    const file = entry.file || pluginPath.join(entry.dir, 'SKILL.md')
    return `[Using ${entry.kind === 'command' ? 'plugin command' : 'skill'}: ${entry.name}]\nSkill file: ${file}\nSkill directory: ${entry.dir}\nResolve file references from the referring file's directory.\n${pluginFs.readFileSync(file, 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', entry.pluginRoot || entry.dir)}`
  }
  if (entry.selectable === false) throw new Error('This code extension is loaded by its native CLI, not selected as a skill')
  return `[Selected plugin: ${entry.displayName || entry.name}]\nPlugin directory: ${entry.dir}\n${entry.manifest ? `Manifest: ${entry.manifest}\n` : ''}\nUse the relevant capabilities of this plugin for the current request.\nRead its manifest, if present, and entry instructions, then read only the skill or command instructions relevant to the task. Resolve plugin paths from the plugin directory and file references from the referring file's directory.\nReading plugin files does not activate tools, hooks, or code extensions; use only capabilities available in the current runtime.`
}
