// Kiro CLI (`kiro-cli`): headless `chat --no-interactive` runs with a
// temporary agent that adds the OpenTandem MCP server.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configOverlay, mainSessionEventGuard, mergedMcpJson, scriptInstall } from '../../core/agent-kit/kit.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createKiroFiles(io) {
  const { fs, os, path } = io

  function kiroSessionExists(sessionId) {
    return !!kiroSessionPath(sessionId)
  }

  function kiroSessionPath(sessionId) {
    if (!sessionId) return false
    const root = path.join(os.homedir(), '.kiro', 'sessions', 'cli')
    const json = path.join(root, `${sessionId}.json`)
    if (fs.existsSync(json)) return json
    const jsonl = path.join(root, `${sessionId}.jsonl`)
    return fs.existsSync(jsonl) ? jsonl : ''
  }

  return {
    session: { path: id => kiroSessionPath(id), exists: id => kiroSessionExists(id) },
    purgeSide: ({ home, sid, rm }) => {
        if (!sid) return
        rm(path.join(home, '.kiro', 'sessions', 'cli', `${sid}.json`))
        rm(path.join(home, '.kiro', 'sessions', 'cli', `${sid}.jsonl`))
      },
  }
}

export function createKiroAdapter(ctx) {
  const { execFile, execFileNow, VERSION_PROBE_MS, cachedModelProbe, probeCliOutput, runtimeInstructions, toolServerSpec, t, persistOverlay } = ctx
  const files = createKiroFiles({ fs, os, path })
  const KIRO_BIN = ctx.config('KIRO_BIN') || 'kiro-cli'

  /**
   * Detection only runs `--version` and never a credential command.
   *
   * Every `chat` subcommand (including `--list-models`) falls into the fig_auth
   * portal when credentials are stale and opens a browser at
   * app.kiro.dev/signin (redirect_from=kirocli); `--no-interactive` does not
   * stop it (tested). With a probe every 60 s and Kiro tokens living one hour,
   * that would pop a browser every hour.
   *
   * `whoami` reads the system credential store: the macOS keychain may show a
   * password dialog, and the security process it spawns can outlive the CLI's
   * timeout. Login is judged by the CLI during real runs. The model catalog is
   * not read here; see KIRO_MODELS.
   */
  function collectKiro() {
    const run = (args, timeout) => new Promise((resolve) => {
      execFile(KIRO_BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : String(stdout)))
    })
    return (async () => {
      const version = await run(['--version'], VERSION_PROBE_MS)
      if (version === null) return { installed: false, login: false, version: null }
      return { installed: true, login: true, version: version.trim().split('\n')[0] }
    })()
  }

  /**
   * Kiro's model catalog: the probe cache first (`chat --list-models`, see the
   * probe below), otherwise this built-in table, a snapshot of
   * `kiro-cli chat --list-models --format json --no-interactive` from
   * 2026-09-21.
   *
   * Periodic live listing stays forbidden: that command wants to open the
   * portal when the token has expired (see collectKiro). Probes only happen at
   * two user-visible moments, the manual refresh button and first use, and
   * always run behind the fake `open` and a hard timeout, so nothing can pop up.
   */
  const KIRO_MODELS = [
    { slug: 'auto', display_name: 'Auto', description: t('Kiro picks the model for each task'), reasoning_levels: [] },
    { slug: 'claude-sonnet-4.5', display_name: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5', reasoning_levels: [] },
    { slug: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', description: t('Hybrid reasoning and coding model for everyday use'), reasoning_levels: [] },
    { slug: 'claude-haiku-4.5', display_name: 'Claude Haiku 4.5', description: t('Latest Claude Haiku'), reasoning_levels: [] },
    { slug: 'deepseek-3.2', display_name: 'DeepSeek 3.2', description: t('DeepSeek V3.2 preview'), reasoning_levels: [] },
    { slug: 'minimax-m2.5', display_name: 'MiniMax M2.5', description: 'MiniMax M2.5', reasoning_levels: [] },
    { slug: 'minimax-m2.1', display_name: 'MiniMax M2.1', description: t('MiniMax M2.1 preview'), reasoning_levels: [] },
    { slug: 'glm-5', display_name: 'GLM-5', description: 'GLM-5', reasoning_levels: [] },
    { slug: 'qwen3-coder-next', display_name: 'Qwen3 Coder Next', description: t('Qwen3 Coder Next preview'), reasoning_levels: [] },
  ]

  function kiroGroupSyncModels(models) {
    const hasAuto = models.some(m => m.slug === 'auto')
    return { models, default_model: hasAuto ? 'auto' : models[0].slug }
  }

  async function kiroGroup() {
    const status = await collectKiro().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    // The list probed with `chat --list-models --format json --no-interactive`
    // (only on manual refresh or first use, behind the fake `open` and a hard
    // timeout; see collectKiro), falling back to the built-in table.
    const probed = cachedModelProbe('kiro')?.models
    const picked = probed?.length
      ? kiroGroupSyncModels(probed)
      : { models: KIRO_MODELS, default_model: 'auto' }
    return { runtime: 'kiro', ...picked, default_effort: null }
  }

  /** The JSON shape of `kiro --list-models` is undocumented; parse common field names tolerantly. */
  function parseKiroModelsJson(stdout) {
    let data = null
    try { data = JSON.parse(stdout) } catch { return [] }
    const list = Array.isArray(data) ? data
      : Array.isArray(data?.models) ? data.models
      : Array.isArray(data?.data) ? data.data
      : null
    if (!list) return []
    const out = []
    const seen = new Set()
    for (const item of list) {
      // kiro-cli's actual fields are model_id / model_name (2026-09-23); id,
      // modelId and slug are other CLIs' names, accepted too.
      const slug = typeof item === 'string' ? item
        : typeof item?.model_id === 'string' && item.model_id ? item.model_id
        : typeof item?.id === 'string' && item.id ? item.id
        : typeof item?.modelId === 'string' && item.modelId ? item.modelId
        : typeof item?.slug === 'string' && item.slug ? item.slug
        : typeof item?.model_name === 'string' && item.model_name ? item.model_name
        : null
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      const display = typeof item?.displayName === 'string' && item.displayName ? item.displayName
        : typeof item?.name === 'string' && item.name ? item.name
        : typeof item?.model_name === 'string' && item.model_name ? item.model_name
        : slug
      const description = typeof item?.description === 'string' && item.description ? item.description.slice(0, 120) : undefined
      out.push({ slug, display_name: display, ...(description ? { description } : {}), reasoning_levels: [] })
    }
    return out
  }

  async function kiroScheduleMcpHome(run) {
    const realDir = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro')
    const config = path.join('settings', 'mcp.json')
    const setup = configOverlay(realDir, 'opentandem-kiro-home-', {
      [config]: mergedMcpJson(path.join(realDir, config), toolServerSpec(run)),
    }, persistOverlay)
    // Kiro exposes only a replacement custom-agent prompt, not an append flag.
    // Clone its current built-in default first, then append our rules, so Kiro's
    // own tool guidance survives upgrades instead of being replaced by a stale
    // copy committed in OpenTandem.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-kiro-agent-'))
    try {
      // Asynchronous: the Runner's main thread must not wait on a CLI.
      const created = await execFileNow(KIRO_BIN, ['agent', 'create', 'opentandem-runtime', '--directory', scratch, '--from', 'kiro_default'], {
        env: { ...process.env, KIRO_HOME: realDir, EDITOR: process.platform === 'win32' ? 'cmd /c exit 0' : '/usr/bin/true', VISUAL: process.platform === 'win32' ? 'cmd /c exit 0' : '/usr/bin/true' },
        timeout: 10_000,
      })
      if (created.error) throw created.error
      const generated = JSON.parse(fs.readFileSync(path.join(scratch, 'opentandem-runtime.json'), 'utf8'))
      // Agent-level servers take precedence over settings/mcp.json. A previously
      // saved same-name server must not replace this run's actual tool endpoint.
      generated.mcpServers = { ...(generated.mcpServers || {}), opentandem: toolServerSpec(run) }
      generated.prompt = `${typeof generated.prompt === 'string' ? generated.prompt.trimEnd() : ''}\n\n${runtimeInstructions(run)}\n`
      const target = path.join(setup.home, 'agents', 'opentandem-runtime.json')
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, JSON.stringify(generated), { mode: 0o600 })
      setup.agent = 'opentandem-runtime'
    } catch (e) {
      console.warn(`[daemon] could not clone Kiro default agent; keeping MCP instructions only: ${e.message}`)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
    return setup
  }

  function kiroArgs(run, localImages, instruction, agent = '') {
    const argv = ['chat', '--no-interactive', '--output-format', 'stream-json']
    if (agent) argv.push('--agent', agent)
    if (run.exec_mode === 'readonly') argv.push('--trust-tools=fs_read,fs_list,grep')
    else argv.push('--trust-all-tools')
    if (run.model && run.model !== 'auto') argv.push('--model', run.model)
    if (run.reasoning_effort) argv.push('--effort', run.reasoning_effort)
    if (run.resume_thread_id) argv.push('--resume-id', run.resume_thread_id)
    const stdinText = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with your file-reading tool)]\n${localImages.join('\n')}`
      : instruction
    return { argv, stdinText, cwd: run.workdir || undefined }
  }

  function kiroHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolById = new Map()
    let answer = ''
    const outputText = (update) => {
      const raw = update?.rawOutput?.items
      if (Array.isArray(raw)) {
        const text = raw.map(item => item?.Json?.stdout || item?.Json?.stderr || '').filter(Boolean).join('\n')
        if (text) return text
      }
      if (Array.isArray(update?.content)) return update.content.map(item => item?.content?.text || '').filter(Boolean).join('\n')
      return ''
    }
    return {
      line(event) {
        if (!isMainSession(event.data?.sessionId)) return
        const sessionId = event.data?.sessionId
        if (typeof sessionId === 'string' && sessionId) ctx.setSession(sessionId)
        if (event.type === 'sessionUpdate') {
          const update = event.data?.update || {}
          if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
            answer += update.content.text
            ctx.pump.push({ type: 'content_delta', data: { text: update.content.text } })
          } else if (update.sessionUpdate === 'tool_call') {
            const rec = { kind: 'command', label: update.title || update._meta?.kiro?.toolName || 'tool', status: 'running', output: '' }
            ctx.reasoningParts.push(rec)
            if (update.toolCallId) toolById.set(update.toolCallId, rec)
            ctx.pump.push({ type: 'tool_event', data: { id: update.toolCallId, kind: 'command', label: rec.label, status: 'running' } })
          } else if (update.sessionUpdate === 'tool_call_update') {
            const rec = update.toolCallId ? toolById.get(update.toolCallId) : undefined
            const output = outputText(update).slice(0, 2000)
            const done = update.status === 'completed' || update.status === 'failed'
            if (rec && done) { rec.status = 'done'; rec.output = output }
            ctx.pump.push({ type: 'tool_event', data: { id: update.toolCallId, kind: 'command', label: rec?.label || update.title || 'tool', status: done ? 'done' : 'running', ...(done ? { output } : {}) } })
          }
          return
        }
        if (event.type === 'runFinished') {
          if (event.data?.status !== 'success') ctx.setErrorText(String(event.data?.stopReason || event.data?.status || 'Kiro CLI error'))
          if (typeof event.data?.finalText === 'string') {
            if (!answer) ctx.pump.push({ type: 'content_delta', data: { text: event.data.finalText } })
            answer = event.data.finalText
            ctx.setFullText(answer)
          }
        }
      },
      flush() { if (answer) ctx.setFullText(answer) },
    }
  }

  return {
    id: 'kiro',
    label: 'Kiro CLI',
    executes: true,
    bin: () => KIRO_BIN,
    detect: collectKiro,
    models: () => kiroGroup(),
    probe: {
      key: 'kiro',
      label: 'kiro-cli chat --list-models',
      run: async () => {
        const res = await probeCliOutput(KIRO_BIN, ['chat', '--list-models', '--format', 'json', '--no-interactive'])
        if (!res.ok) return res
        const models = parseKiroModelsJson(res.stdout)
        return models.length ? { ok: true, models } : { ok: false, error: t('--list-models output could not be parsed: {output}', { output: res.stdout.slice(0, 120) || res.stderr || t('(empty)') }) }
      },
    },
    install: {
      oneClick: scriptInstall('https://cli.kiro.dev/install', [path.join(os.homedir(), '.local', 'bin')]),
      native: (real, home) => real === `${home}/.local/bin/kiro-cli` || real === '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
    },
    session: files.session,
    ownFiles: createKiroFiles,
    toolSetup: kiroScheduleMcpHome,
    command: (run, images, instruction, setup) => kiroArgs(run, images, instruction, setup?.agent),
    processEnv: (env, { setup }) => { if (setup) env.KIRO_HOME = setup.home },
    handler: kiroHandler,
    purgeSide: files.purgeSide,
  }
}
