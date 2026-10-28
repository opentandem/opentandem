// DeepSeek Harness (`dsh`): headless profile runs through the Runner's own Node, with an isolated DSH_HOME.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configOverlay, plainTextHandler } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createDshFiles(io) {
  const { fs, os, path } = io

  /** dsh keeps all user data under $DSH_HOME (default ~/.dsh); a blank value counts as unset. */
  function dshHome() {
    const configured = String(process.env.DSH_HOME || '').trim()
    if (!configured) return path.join(os.homedir(), '.dsh')
    if (configured === '~') return os.homedir()
    if (configured.startsWith('~/') || configured.startsWith('~\\')) return path.join(os.homedir(), configured.slice(2))
    return path.resolve(configured)
  }

  /** dsh's own project directory key (dsh-session-persistence-jsonl `projectKey`): path and
   *  drive separators collapse into one `-`, unsafe code units become `~XXXX`. */
  function projectKey(cwd) {
    let readable = ''
    let separatorRun = false
    for (let i = 0; i < cwd.length; i++) {
      const code = cwd.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-'
        separatorRun = true
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch
        separatorRun = false
      } else {
        readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
        separatorRun = false
      }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
  }

  /** dsh's session directory segment (`encodeSegment`). */
  function encodeSegment(raw) {
    if (raw === '.') return '~002E'
    if (raw === '..') return '~002E~002E'
    let out = ''
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      const ch = String.fromCharCode(code)
      out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
    return out
  }

  /** dsh records the directory its process runs in, which on macOS is the resolved path
   *  (/tmp becomes /private/tmp). Try the spellings the workdir can take. */
  function cwdCandidates(workdir) {
    const base = workdir || process.cwd()
    const list = [base, path.resolve(base)]
    try { list.push(fs.realpathSync(base)) } catch { /* missing directory */ }
    try { list.push(fs.realpathSync.native(base)) } catch { /* missing directory */ }
    return [...new Set(list.filter(Boolean))]
  }

  /** The session's newest log generation (`session.jsonl`, `session.v4.jsonl.zstd`, ...).
   *  Empty when this dsh cannot resume, the id is unsafe or no log exists: the run then
   *  rebuilds its context, which is always safe. */
  function dshSessionPath(sessionId, workdir) {
    if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return ''
    if (!io.state?.()?.resume) return ''
    const root = path.join(dshHome(), 'sessions')
    for (const cwd of cwdCandidates(workdir)) {
      const dir = path.join(root, projectKey(cwd), encodeSegment(sessionId))
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      const logs = names
        .map(name => ({ name, m: /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name) }))
        .filter(item => item.m)
        .sort((a, b) => Number(b.m[1] || 0) - Number(a.m[1] || 0))
      if (logs.length) return path.join(dir, logs[0].name)
    }
    return ''
  }

  return {
    session: { path: (id, workdir) => dshSessionPath(id, workdir), exists: (id, workdir) => !!dshSessionPath(id, workdir) },
    // Title side calls run in a temporary `ot-title-*` workdir; only that project's
    // directory and the cache entries naming it are removed, never task sessions.
    purgeSide: ({ rmNamed, rmMentioning }) => {
        rmNamed('.dsh', 'sessions')
        rmMentioning('.dsh', 'storages', 'session_projcache', 'sessions')
      },
  }
}

export function createDshAdapter(ctx) {
  const { execFile, VERSION_PROBE_MS, runtimeInstructions, toolServerSpec, windowsCommand, t, persistOverlay } = ctx
  const DSH_BIN = ctx.config('DSH_BIN') || 'dsh'

  const DSH_ENTRY = (() => {
    // On Windows the dsh on PATH is an npm-generated sh script that Node cannot run; read the .cmd shim for the real JS entry
    if (process.platform === 'win32') return windowsCommand(DSH_BIN)?.prefix?.[0] || DSH_BIN
    const candidates = path.isAbsolute(DSH_BIN)
      ? [DSH_BIN]
      : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, DSH_BIN))
    const executable = candidates.find(file => fs.existsSync(file)) || DSH_BIN
    try { return fs.realpathSync(executable) } catch { return executable }
  })()

  /** `--session-id`, `--json` and a task on stdin arrived together in dsh 0.1.6
   *  (every published 0.1.6-* and 0.1.7-* build has them; 0.1.5-* has none). */
  function supportsResume(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''))
    if (!m) return false
    const [major, minor, patch] = m.slice(1).map(Number)
    return major > 0 || minor > 1 || (minor === 1 && patch >= 6)
  }

  // Read once at startup and refreshed by every detect, so a dsh upgrade takes effect
  // without restarting the Runner.
  let dshResume = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(DSH_ENTRY), '..', 'package.json'), 'utf8'))
      return pkg.name === '@deepseek-ai/dsh' && supportsResume(pkg.version)
    } catch { return false }
  })()
  const files = createDshFiles({ fs, os, path, state: () => ({ resume: dshResume }) })
  // Whether each run (including title side calls) was started in JSON mode; the handler follows it.
  const jsonRuns = new WeakMap()

  function collectDsh() {
    return new Promise((resolve) => {
      // Invoke the JS entry with the Runner's own Node. The dsh shim uses
      // `#!/usr/bin/env node`; on this Mac, PATH selects Homebrew Node 23 before
      // the Node 22 installation that owns dsh, and dsh 0.1.5 then exits 0 with
      // no stdout/stderr before its headless plugin mounts.
      execFile(process.execPath, [DSH_ENTRY, '--profile', 'headless', '--help'], { timeout: VERSION_PROBE_MS, maxBuffer: 4 * 1024 * 1024 }, (err) => {
        if (err) { resolve({ installed: false, login: false, version: null }); return }
        let version = null
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(DSH_ENTRY), '..', 'package.json'), 'utf8'))
          if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') version = pkg.version
        } catch { /* Unreadable package metadata remains unknown. */ }
        dshResume = supportsResume(version)
        resolve({ installed: true, login: true, version })
      })
    })
  }

  /** dsh's model is whatever the provider in the yml configures: the harness runs a single
   *  model, so the catalog follows the config rather than a built-in list. Without a readable
   *  config it falls back to GLM 5.2. */
  function dshConfiguredModel() {
    try {
      const yml = fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', 'headless', 'cordis.patch.yml'), 'utf8')
      const model = yml.match(/^model:\s*["']?([A-Za-z0-9._/-]+)["']?\s*(?:#.*)?$/m)?.[1]
      if (model) return model
    } catch { /* no config file */ }
    return 'glm-5.2'
  }

  async function dshGroup() {
    const status = await collectDsh().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    const model = dshConfiguredModel()
    const short = model.includes('/') ? model.split('/').pop() : model
    return {
      runtime: 'dsh',
      models: [{ slug: `dsh/${short}`, display_name: short, description: t('Model configured in the current DeepSeek Harness profile (cordis.patch.yml)'), reasoning_levels: [] }],
      default_model: `dsh/${short}`,
      default_effort: null,
    }
  }

  function dshScheduleMcpHome(run) {
    const realDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const patch = path.join('profiles', 'headless', 'cordis.patch.yml')
    let original = ''
    try { original = fs.readFileSync(path.join(realDir, patch), 'utf8').trimEnd() } catch {}
    const spec = toolServerSpec(run)
    const block = [
      // dsh's own title request costs one more model call per new session; the Runner
      // names tasks itself, and dsh then keeps its deterministic fallback title.
      '- id: session-title-llm',
      '  disabled: true',
      '',
      '- insert:',
      '    - id: mcp-opentandem',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: opentandem',
      '        transport: stdio',
      `        command: ${JSON.stringify(spec.command)}`,
      `        args: ${JSON.stringify(spec.args)}`,
      `        env: ${JSON.stringify(spec.env)}`,
      '        failOnStartupError: true',
    ].join('\n')
    let existingInstructions = ''
    try { existingInstructions = fs.readFileSync(path.join(realDir, 'AGENTS.md'), 'utf8').trimEnd() } catch {}
    return configOverlay(realDir, 'opentandem-dsh-home-', {
      [patch]: `${original}${original ? '\n\n' : ''}${block}\n`,
      'AGENTS.md': `${existingInstructions}${existingInstructions ? '\n\n' : ''}${runtimeInstructions(run)}\n`,
    }, persistOverlay)
  }

  /** dsh 0.1.6+ headless: `--json` prints NDJSON run events, `--session-id` adopts the
   *  persisted session, and the task arrives on stdin (so text starting with `-` is never
   *  read as an option). Older builds are one-shot: plain final text, no session id, and
   *  OpenTandem supplies the full context every turn. */
  function dshArgs(run, localImages, instruction) {
    const prompt = localImages.length
      ? `${instruction}\n\n[Image files attached to this message]\n${localImages.join('\n')}`
      : instruction
    const json = dshResume
    jsonRuns.set(run, json)
    if (!json) return { argv: [DSH_ENTRY, '--profile', 'headless', prompt], stdinText: '', cwd: run.workdir || undefined }
    const argv = [DSH_ENTRY, '--profile', 'headless', '--json']
    if (run.resume_thread_id) argv.push('--session-id', run.resume_thread_id)
    return { argv, stdinText: prompt, cwd: run.workdir || undefined }
  }

  /** Projects `--json` events: `session` names the native session, committed `text` /
   *  `thinking` arrive per step, `step_end` carries that step's usage, `turn_end` the
   *  outcome and `final` the lossless answer. Old builds keep the plain-text handler. */
  function dshHandler(ctx) {
    if (!ctx.dshJson) return plainTextHandler(ctx)
    let buffer = ''
    let narration = ''
    let finalText = null
    const toolById = new Map()
    const labelFor = (name, input) => {
      const arg = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    // Text committed before a tool call is narration, not the answer.
    const flushNarration = () => {
      if (!narration) return
      ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: narration })
      ctx.pump.push({ type: 'reasoning_delta', data: { text: narration } })
      narration = ''
    }
    const onEvent = (event) => {
      if (!event || typeof event !== 'object') return
      switch (event.type) {
        case 'session':
          if (typeof event.sessionId === 'string' && event.sessionId) ctx.setSession(event.sessionId)
          return
        case 'thinking':
          if (typeof event.text === 'string' && event.text) {
            ctx.reasoningParts.push({ kind: 'reasoning', label: event.text })
            ctx.pump.push({ type: 'reasoning_delta', data: { text: event.text } })
          }
          return
        case 'text':
          if (typeof event.text === 'string' && event.text) {
            flushNarration()
            narration = event.text
          }
          return
        case 'tool_call': {
          flushNarration()
          const label = labelFor(event.tool || 'tool', event.input && typeof event.input === 'object' ? event.input : {})
          const rec = { kind: 'command', label, status: 'running', output: '' }
          ctx.reasoningParts.push(rec)
          if (event.callId) toolById.set(event.callId, rec)
          ctx.pump.push({ type: 'tool_event', data: { id: event.callId, kind: 'command', label, status: 'running' } })
          return
        }
        case 'tool_result': {
          const rec = event.callId ? toolById.get(event.callId) : undefined
          const output = typeof event.result === 'string' ? event.result.slice(0, 2000) : ''
          if (rec) { rec.status = 'done'; rec.output = output }
          ctx.pump.push({ type: 'tool_event', data: { id: event.callId, kind: 'command', label: rec?.label || event.tool || 'tool', status: 'done', output } })
          return
        }
        case 'status': {
          const usage = event.phase === 'step_end' ? event.usage : undefined
          if (usage && typeof usage === 'object') {
            // dsh reports uncached input and cache reads/writes as disjoint counts.
            const prompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
            ctx.tokens.input += prompt
            ctx.tokens.output += usage.outputTokens || 0
            if (prompt) ctx.contextUsage.tokens = prompt
          }
          if (event.phase === 'turn_end' && event.reason && event.reason.kind !== 'completed') {
            const err = event.reason.error
            ctx.setErrorText(err?.message
              ? `${err.code ? `${err.code}: ` : ''}${err.message}`
              : t('DeepSeek Harness turn ended without completing ({reason})', { reason: String(event.reason.kind || 'unknown') }))
          }
          return
        }
        case 'final':
          if (typeof event.text === 'string') finalText = event.text
          return
        case 'error':
          if (event.message) ctx.setErrorText(String(event.message))
          return
      }
    }
    const consume = (text, end) => {
      buffer += text
      const lines = buffer.split('\n')
      buffer = end ? '' : (lines.pop() || '')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }
        onEvent(event)
      }
    }
    return {
      raw(text) { consume(text, false) },
      line() { /* stdout arrives through raw so old builds can stay plain text */ },
      flush() {
        consume('', true)
        const answer = (finalText ?? narration).trim()
        narration = ''
        if (!answer) return
        ctx.setFullText(answer)
        ctx.pump.push({ type: 'content_delta', data: { text: answer } })
      },
    }
  }

  return {
    id: 'dsh',
    label: 'DeepSeek Harness',
    executes: true,
    bin: () => process.execPath,
    detect: collectDsh,
    models: () => dshGroup(),
    nativeInstructions: true,
    toolSetup: dshScheduleMcpHome,
    command: dshArgs,
    handler: dshHandler,
    stream: { raw: true },
    emptyOutputDetail: t('No final answer was output (stdout and stderr were both empty)'),
    processEnv: (env, { run, setup }) => {
      if (setup) env.DSH_HOME = setup.home
      env.DSH_PERMISSION_MODE = run.exec_mode === 'readonly' ? 'read-only' : 'danger-full-access'
      const dshJson = jsonRuns.get(run) === true
      return () => ({ dshJson })
    },
    session: files.session,
    filesState: () => ({ resume: dshResume }),
    purgeSide: files.purgeSide,
    ownFiles: createDshFiles,
  }
}
