// Google Antigravity (`agy`): headless runs with an isolated HOME carrying the tool server config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configOverlay, mainSessionEventGuard, mergedMcpJson } from '../../core/agent-kit/kit.mjs'
import { createGeminiApi, geminiApiKey } from '../../core/agent-kit/gemini-api.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createAntigravityFiles(io) {
  const { fs, os, path, SqliteDatabaseSync } = io

  function antigravitySessionPath(sessionId) {
    const file = sessionId ? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`) : ''
    return file && fs.existsSync(file) ? file : ''
  }

  function antigravitySessionExists(sessionId) {
    return !!antigravitySessionPath(sessionId)
  }

  return {
    session: { path: id => antigravitySessionPath(id), exists: id => antigravitySessionExists(id) },
    purgeSide: ({ home, base, sid, rm }) => {
        if (!sid) return
        const root = path.join(home, '.gemini', 'antigravity-cli')
        for (const ext of ['.db', '.db-wal', '.db-shm']) rm(path.join(root, 'conversations', sid + ext))
        rm(path.join(root, 'brain', sid))
        const dbPath = path.join(root, 'conversation_summaries.db')
        if (SqliteDatabaseSync && fs.existsSync(dbPath)) {
          const db = new SqliteDatabaseSync(dbPath)
          try {
            db.exec('PRAGMA busy_timeout = 5000')
            db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(sid)
          } finally { db.close() }
        }
        // The conversation summary cache is protobuf: the top level is a run of length-delimited
        // field-1 summaries. Drop only those mentioning this temp dir and keep the rest byte for
        // byte; leave the file alone if the structure does not match.
        try {
          const pb = path.join(root, 'jetbox_summaries_proto.pb')
          const buf = fs.readFileSync(pb)
          const varint = (i) => { let r = 0, sh = 0, c; do { c = buf[i++]; r += (c & 0x7f) * 2 ** sh; sh += 7 } while (c >= 0x80); return [r, i] }
          const keep = []
          let i = 0, dropped = 0, ok = true
          while (i < buf.length) {
            const start = i
            let key, len
            ;[key, i] = varint(i)
            if ((key & 7) !== 2) { ok = false; break }
            ;[len, i] = varint(i)
            if (i + len > buf.length) { ok = false; break }
            const entry = buf.subarray(start, i + len)
            if (buf.subarray(i, i + len).includes(base)) dropped++
            else keep.push(entry)
            i += len
          }
          if (ok && dropped) {
            fs.writeFileSync(pb + '.ot-tmp', Buffer.concat(keep))
            fs.renameSync(pb + '.ot-tmp', pb)
          }
        } catch { /* no cache */ }
        // The "recent conversations" cache is keyed by workdir: drop this temp dir's entry
        const cache = path.join(root, 'cache', 'last_conversations.json')
        try {
          const data = JSON.parse(fs.readFileSync(cache, 'utf8'))
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const keys = Object.keys(data).filter(k => k.includes(base))
            if (keys.length) {
              for (const k of keys) delete data[k]
              fs.writeFileSync(cache + '.ot-tmp', JSON.stringify(data))
              fs.renameSync(cache + '.ot-tmp', cache)
            }
          }
        } catch { /* no cache */ }
      },
  }
}

export function createAntigravityAdapter(ctx) {
  const { execFile, VERSION_PROBE_MS, cachedModelProbe, probeCliOutput, runtimeInstructions, toolServerSpec, SqliteDatabaseSync, t, persistOverlay } = ctx
  const files = createAntigravityFiles({ fs, os, path, SqliteDatabaseSync })
  const geminiApi = createGeminiApi(ctx)
  // The official Windows installer puts it in %LOCALAPPDATA%\agy\bin and adds that to the user PATH; find it by name
  const ANTIGRAVITY_BIN = ctx.config('ANTIGRAVITY_BIN') || (process.platform === 'win32' ? 'agy' : path.join(os.homedir(), '.local', 'bin', 'agy'))

  function collectAntigravity() {
    const run = (args, timeout) => new Promise((resolve) => {
      execFile(ANTIGRAVITY_BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : String(stdout)))
    })
    return (async () => {
      const version = await run(['--version'], VERSION_PROBE_MS)
      if (version === null) return { installed: false, login: false, version: null }
      return { installed: true, login: true, version: version.trim().split('\n')[0] }
    })()
  }

  const ANTIGRAVITY_MODELS = [
    { slug: 'gemini-3.8-flash-low', display_name: 'Gemini 3.8 Flash (Low)', reasoning_levels: [] },
    { slug: 'gemini-3.7-flash-low', display_name: 'Gemini 3.7 Flash (Low)', reasoning_levels: [] },
    { slug: 'gemini-3.6-flash-low', display_name: 'Gemini 3.6 Flash (Low)', description: t('Verified with the local API key'), reasoning_levels: [] },
    { slug: 'gemini-3.1-pro-low', display_name: 'Gemini 3.1 Pro (Low)', description: t('A free API key may have no quota'), reasoning_levels: [] },
  ]

  async function antigravityGroup() {
    const status = await collectAntigravity().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    // The list probed from `agy models`; without a cached probe fall back to the built-in table
    const probed = cachedModelProbe('antigravity')?.models
    const models = probed?.length ? probed : ANTIGRAVITY_MODELS
    return {
      runtime: 'antigravity',
      models,
      default_model: models.some(m => m.slug === 'gemini-3.6-flash-low') ? 'gemini-3.6-flash-low' : models[0].slug,
      default_effort: null,
    }
  }

  function parseAntigravityModelsText(stdout) {
    const out = []
    const seen = new Set()
    for (const line of String(stdout).split('\n')) {
      const entry = line.trim()
      if (!entry) continue
      const m = entry.match(/^(gemini-[a-z0-9.-]+)(?:\s{1,4}(.+))?$/)
      if (!m || seen.has(m[1])) continue
      seen.add(m[1])
      const display = m[2]?.trim() || m[1]
      out.push({ slug: m[1], display_name: display, description: t('Probed from the local agy models'), reasoning_levels: [] })
    }
    return out
  }

  function antigravityScheduleMcpHome(run) {
    const realHome = os.homedir()
    const config = path.join('.gemini', 'config', 'mcp_config.json')
    return configOverlay(realHome, 'opentandem-antigravity-home-', {
      [config]: mergedMcpJson(path.join(realHome, config), toolServerSpec(run)),
      [path.join('.gemini', 'config', 'plugins', 'opentandem-runtime', 'plugin.json')]: JSON.stringify({ name: 'opentandem-runtime' }),
      [path.join('.gemini', 'config', 'plugins', 'opentandem-runtime', 'rules', 'AGENTS.md')]: `${runtimeInstructions(run)}\n`,
    }, persistOverlay)
  }

  function antigravityArgs(run, localImages, instruction) {
    const prompt = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with the view_file tool)]\n${localImages.join('\n')}`
      : instruction
    const argv = ['-p', prompt, '--output-format', 'stream-json']
    argv.push(run.exec_mode === 'readonly' ? '--mode' : '--dangerously-skip-permissions')
    if (run.exec_mode === 'readonly') argv.push('plan')
    if (run.model) argv.push('--model', run.model)
    if (run.resume_thread_id) argv.push('--conversation', run.resume_thread_id)
    for (const image of localImages) argv.push('--add-dir', path.dirname(image))
    return { argv, stdinText: '', cwd: run.workdir || undefined }
  }

  function antigravityHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    let answer = ''
    return {
      line(event) {
        if (!isMainSession(event.conversation_id || event.result?.conversation_id)) return
        if (event.event === 'init' && typeof event.conversation_id === 'string') {
          ctx.setSession(event.conversation_id)
          return
        }
        if (event.event === 'step_update') {
          const step = event.step_update || {}
          if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
            answer += step.text_delta
            ctx.pump.push({ type: 'content_delta', data: { text: step.text_delta } })
          }
          return
        }
        if (event.event === 'result') {
          const result = event.result || {}
          if (typeof result.conversation_id === 'string') ctx.setSession(result.conversation_id)
          if (result.usage) {
            ctx.tokens.input = result.usage.input_tokens || 0
            ctx.tokens.output = result.usage.output_tokens || 0
          }
          if (result.status !== 'SUCCESS') ctx.setErrorText(String(result.error?.message || result.status || 'Antigravity error'))
          if (!answer && typeof result.response === 'string') {
            answer = result.response
            ctx.pump.push({ type: 'content_delta', data: { text: answer } })
          }
        }
      },
      flush() { if (answer) ctx.setFullText(answer) },
    }
  }

  async function probeModels() {
    const key = geminiApiKey()
    const res = await probeCliOutput(ANTIGRAVITY_BIN, ['models'], 15_000, key ? { GEMINI_API_KEY: key } : {})
    if (!res.ok) return res
    const models = parseAntigravityModelsText(`${res.stdout}\n${res.stderr}`)
    return models.length ? { ok: true, models } : { ok: false, error: t('agy models output could not be parsed: {output}', { output: (`${res.stdout}\n${res.stderr}`).slice(0, 120) || t('(empty)') }) }
  }

  return {
    id: 'antigravity',
    label: 'Google Antigravity',
    executes: true,
    bin: () => ANTIGRAVITY_BIN,
    detect: collectAntigravity,
    models: () => antigravityGroup(),
    probe: { key: 'antigravity', label: 'agy models', run: probeModels },
    nativeInstructions: true,
    install: {
      native: (real, home) => real === `${home}/.local/bin/agy` || real.startsWith(`${home}/AppData/Local/agy/bin/`),
      releasePlatform: true,
    },
    session: files.session,
    ownFiles: createAntigravityFiles,
    toolSetup: antigravityScheduleMcpHome,
    command: antigravityArgs,
    handler: antigravityHandler,
    systemProxy: true,
    processEnv: (env, { setup }) => {
      if (setup) env.HOME = setup.home
      geminiApi.keyEnv(env)
    },
    purgeSide: files.purgeSide,
  }
}
