// Qwen Code (`qwen`): headless stream-json runs (Claude Code protocol); `/compress` for native compaction.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMPACT_TIMEOUT_MS, providerErrorText, scriptInstall } from '../../core/agent-kit/kit.mjs'
import { createGeminiApi, geminiApiKey } from '../../core/agent-kit/gemini-api.mjs'
import { createClaudeStreamHandler } from '../../core/agent-kit/claude-stream.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createQwenFiles(io) {
  const { fs, os, path } = io

  function qwenSessionPath(sessionId) {
    if (!sessionId) return false
    const root = path.join(os.homedir(), '.qwen', 'projects')
    try {
      for (const project of fs.readdirSync(root)) {
        const file = path.join(root, project, 'chats', `${sessionId}.jsonl`)
        if (fs.existsSync(file)) return file
      }
    } catch { /* no ~/.qwen/projects */ }
    return ''
  }

  function qwenSessionExists(sessionId) {
    return !!qwenSessionPath(sessionId)
  }

  return {
    session: { path: id => qwenSessionPath(id), exists: id => qwenSessionExists(id) },
    purgeSide: ({ rmNamed, dropLines }) => {
        rmNamed('.qwen', 'projects')
        dropLines('.qwen', 'usage_record.jsonl')
      },
    transcriptDiagnostics: { file: id => qwenSessionPath(id) },
  }
}

export function createQwenAdapter(ctx) {
  const { execFile, spawn, VERSION_PROBE_MS, killCompactChild, runtimeInstructions, toolServerSpec, t } = ctx
  const files = createQwenFiles({ fs, os, path })
  const geminiApi = createGeminiApi(ctx)
  const claudeHandler = createClaudeStreamHandler(ctx)
  const QWEN_BIN = ctx.config('QWEN_BIN') || 'qwen'

  function collectQwen() {
    return new Promise((resolve) => {
      execFile(QWEN_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => resolve({
        installed: !err,
        login: !err,
        version: err ? null : String(stdout).trim().split('\n')[0],
      }))
    })
  }

  async function qwenGroup() {
    const status = await collectQwen().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    const own = qwenOwnModel()
    if (own) return { runtime: 'qwen', models: [{ slug: `qwen/${own}`, display_name: own, reasoning_levels: [] }], default_model: `qwen/${own}`, default_effort: null }
    const picked = geminiApi.geminiBackedModels('qwen', 'gemini-3.5-flash')
    return { runtime: 'qwen', ...picked, default_effort: null }
  }

  /** Without a Gemini key on this machine, Qwen Code / Pi run the provider the user set in the
   *  CLI's own config (e.g. GLM) instead of forcing --auth-type gemini / --provider google.
   *  Machines with a Gemini key behave as before. Returns the CLI's own auth, null = not set. */
  function qwenOwnAuth() {
    if (geminiApiKey()) return null
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.qwen', 'settings.json'), 'utf8'))
      const auth = settings?.security?.auth
      if (auth?.selectedType !== 'openai' || !auth.apiKey || typeof settings?.model?.name !== 'string') return null
      return { model: settings.model.name, apiKey: auth.apiKey, baseUrl: auth.baseUrl || '' }
    } catch { return null }
  }

  function qwenOwnModel() { return qwenOwnAuth()?.model || '' }

  function qwenArgs(run, localImages, instruction) {
    const argv = [
      // --bare skips settings.json: with a self-configured openai provider the Runner injects the credentials into the child env (see processEnv)
      '--bare', '--auth-type', qwenOwnModel() ? 'openai' : 'gemini', '--output-format', 'stream-json',
      '--approval-mode', run.exec_mode === 'readonly' ? 'plan' : 'yolo',
    ]
    if (run.model) argv.push('--model', run.model.replace(/^qwen\//, ''))
    if (runtimeInstructions(run)) argv.push('--append-system-prompt', runtimeInstructions(run))
    // As with claude: no --allowed-mcp-server-names, which would switch off the user's own MCP servers.
    argv.push('--mcp-config', JSON.stringify({ mcpServers: { opentandem: toolServerSpec(run) } }))
    if (run.resume_thread_id) argv.push('--resume', run.resume_thread_id)
    for (const image of localImages) argv.push('--include-directories', path.dirname(image))
    argv.push('-p', localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with the read_file tool)]\n${localImages.join('\n')}`
      : instruction)
    return { argv, stdinText: '', cwd: run.workdir || undefined }
  }

  function qwenDiagnosticFromEvent(event) {
    const ui = event?.type === 'system' && event?.subtype === 'ui_telemetry'
      ? event.systemPayload?.uiEvent
      : null
    if (ui?.['event.name'] !== 'qwen-code.api_error') return ''
    return providerErrorText(ui.error_message || ui.error_type || 'Qwen Code API error')
  }

  // Qwen Code headless compaction: `--resume <id> -p "/compress"`. Unlike Gemini, qwen really
  // treats it as a control command (the whole turn uses 0 tokens) and replies with its own
  // compression subsystem messages:
  //   success:        Chat history compressed from <X> to <Y> tokens.
  //   not beneficial: Compression was not beneficial for this history size.
  //   failure:        Failed to compress chat history... / ...did not reduce size
  // There is no structured field, so these texts are scanned; a 0-token turn cannot be a model answer.
  async function compactQwen(sessionId, workdir, model) {
    const own = qwenOwnAuth()
    const argv = ['--bare', '--auth-type', own ? 'openai' : 'gemini', '--output-format', 'stream-json', '--approval-mode', 'yolo']
    if (model) argv.push('--model', String(model).replace(/^qwen\//, ''))
    argv.push('--resume', sessionId, '-p', '/compress')
    const ownEnv = own ? { OPENAI_API_KEY: own.apiKey, ...(own.baseUrl ? { OPENAI_BASE_URL: own.baseUrl } : {}) } : {}
    return await new Promise(resolve => {
      const child = spawn(QWEN_BIN, argv, {
        stdio: ['ignore', 'pipe', 'pipe'], cwd: workdir || undefined,
        env: { ...process.env, ...ownEnv, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
        detached: process.platform !== 'win32',
      })
      let settled = false
      let stderrTail = ''
      const seen = { compressed: false, notBeneficial: false, failed: null, resultText: '' }
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killCompactChild(child)
        resolve(payload)
      }
      const settleFromSeen = () => {
        if (seen.notBeneficial) return finish({ error: t('Qwen Code says this session needs no compaction (it would not help)') })
        if (seen.failed) return finish({ error: t('Qwen Code compaction failed: {detail}', { detail: seen.failed }) })
        if (seen.compressed) return finish({ ok: true, detail: t('Qwen Code finished one native context compaction'), tokens_before: seen.before, tokens_after: seen.after })
        return false
      }
      const timer = setTimeout(() => finish({ error: t('Qwen Code did not finish compaction within {seconds}s', { seconds: COMPACT_TIMEOUT_MS / 1000 }) }), COMPACT_TIMEOUT_MS)
      child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-500) })
      let buf = ''
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const compactMatch = line.match(/Chat history compressed from (\d+) to (\d+) tokens/)
          if (compactMatch) {
            seen.compressed = true
            seen.before = Number(compactMatch[1]); seen.after = Number(compactMatch[2])
          }
          if (line.includes('Compression was not beneficial')) seen.notBeneficial = true
          const failMatch = line.match(/Failed to compress chat history[^"]*/)
          if (failMatch) seen.failed = failMatch[0]
          if (line.includes('did not reduce size')) seen.failed = seen.failed || t('compaction did not reduce the size')
          const text = (() => { try { return JSON.parse(line) } catch { return null } })()
          if (text?.type === 'result') seen.resultText = String(text.result || text.error?.message || '')
        }
        settleFromSeen()
      })
      child.on('error', e => finish({ error: t('Could not start qwen: {detail}', { detail: e.message }) }))
      child.on('exit', code => {
        if (settleFromSeen() === false) {
          // No known text matched: return the raw result (usually the reason), not just "failed".
          const detail = seen.resultText || stderrTail.trim().slice(-200)
          finish({ error: t('Qwen Code did not confirm compaction (code={code}){tail}', { code, tail: detail ? t(': {detail}', { detail }) : '' }) })
        }
      })
    })
  }

  return {
    id: 'qwen',
    label: 'Qwen Code',
    executes: true,
    bin: () => QWEN_BIN,
    detect: collectQwen,
    models: () => qwenGroup(),
    probe: geminiApi.upstreamProbe,
    nativeInstructions: true,
    install: {
      oneClick: scriptInstall('https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh', [path.join(os.homedir(), '.local', 'bin')]),
      npmPackage: () => '@qwen-code/qwen-code',
    },
    session: files.session,
    ownFiles: createQwenFiles,
    command: qwenArgs,
    handler: claudeHandler,
    systemProxy: true,
    processEnv: (env) => {
      env.QWEN_CODE_DISABLE_CRON = '1'
      geminiApi.keyEnv(env)
      const own = qwenOwnAuth()
      if (own) { env.OPENAI_API_KEY = own.apiKey; if (own.baseUrl) env.OPENAI_BASE_URL = own.baseUrl }
    },
    diagnose: (line) => {
      const wait = line.match(/\[qwen-code\]\s*Waiting for API capacity\.\.\.\s*attempt\s+(\d+),\s*retry in\s+(\d+)s/i)
      return wait ? t('Qwen Code: API rate-limited or busy, waiting to retry (attempt {attempt}, in about {seconds}s)', { attempt: wait[1], seconds: wait[2] }) : ''
    },
    transcriptDiagnostics: { file: files.transcriptDiagnostics.file, parse: qwenDiagnosticFromEvent },
    compact: (id, workdir, model) => compactQwen(id, workdir, model),
    purgeSide: files.purgeSide,
  }
}
