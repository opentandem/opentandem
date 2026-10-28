// Trae Agent (`trae-cli run`): an isolated Python venv running on Kimi's OpenAI-compatible coding endpoint.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeRuntimeDetail } from '../../core/agent-kit/kit.mjs'
import { KIMI_CODING_DEFAULT_URL, kimiBackedGroup, kimiCodingApiKey } from '../../core/agent-kit/kimi-coding.mjs'

/** The configured binary if it really is Trae Agent (`run --help` lists --trajectory-file), else
 *  the isolated default. TraeCode ships a `trae-cli` command of the same name. */
/** `probe(file, args, options)` resolves the command's stdout or rejects. */
export async function resolveTraeAgentBin(configured, fallback, probe) {
  const candidates = [...new Set([configured, fallback].filter(Boolean))]
  for (const candidate of candidates) {
    try {
      const help = String(await probe(candidate, ['run', '--help'], { encoding: 'utf8', timeout: 8_000, maxBuffer: 1024 * 1024 }))
      if (/--trajectory-file\b/.test(help)) return candidate
    } catch { /* TraeCode exits 2 because it has `exec`, not Agent's `run`. */ }
  }
  return fallback
}

export function createTraeAgentAdapter(ctx) {
  const { execFile, execFileNow, VERSION_PROBE_MS, runtimeInstructions, toolServerSpec, t } = ctx
  const DEFAULT_TRAE_AGENT_BIN = path.join(os.homedir(), '.local', 'share', 'opentandem', 'runtimes', 'trae-agent', '.venv', ...(process.platform === 'win32' ? ['Scripts', 'trae-cli.exe'] : ['bin', 'trae-cli']))
  const CONFIGURED_TRAE_AGENT_BIN = ctx.config('TRAE_AGENT_BIN')
  let TRAE_AGENT_BIN = CONFIGURED_TRAE_AGENT_BIN || DEFAULT_TRAE_AGENT_BIN
  const TRAE_AGENT_CONFIG = ctx.config('TRAE_AGENT_CONFIG') || path.join(os.homedir(), '.local', 'share', 'opentandem', 'runtimes', 'trae-agent', 'opentandem-config.yaml')

  function collectTraeAgent() {
    return new Promise((resolve) => {
      execFile(TRAE_AGENT_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => resolve({
        installed: !err,
        login: !err,
        version: err ? null : String(stdout).trim().split('\n')[0],
      }))
    })
  }

  async function traeAgentGroup() {
    const status = await collectTraeAgent().catch(() => ({ installed: false, login: false }))
    return status.installed ? kimiBackedGroup('trae_agent', 'trae-agent') : null
  }

  function traeAgentScheduleMcpConfig(run) {
    let original = ''
    try { original = fs.readFileSync(TRAE_AGENT_CONFIG, 'utf8').trimEnd() } catch {}
    const spec = toolServerSpec(run)
    const block = [
      'mcp_servers:',
      '  opentandem:',
      `    command: ${JSON.stringify(spec.command)}`,
      `    args: ${JSON.stringify(spec.args)}`,
      `    env: ${JSON.stringify(spec.env)}`,
      `    cwd: ${JSON.stringify(run.workdir || process.cwd())}`,
      'allow_mcp_servers:',
      '  - opentandem',
    ].join('\n')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-trae-config-'))
    fs.chmodSync(dir, 0o700)
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, `${original}${original ? '\n\n' : ''}${block}\n`, { mode: 0o600 })
    // Trae Agent 0.1.0 hardcodes TRAE_AGENT_SYSTEM_PROMPT and exposes no config
    // field for extending it. Python imports sitecustomize before the CLI entry,
    // so this process-local shim appends our rules without editing the installed
    // package or turning them into part of the user's task message.
    fs.writeFileSync(path.join(dir, 'sitecustomize.py'), [
      'import os',
      'try:',
      '    import trae_agent.prompt.agent_prompt as prompt_module',
      `    extra = os.environ.get("${ctx.configKey('TRAE_SYSTEM_INSTRUCTIONS')}", "").strip()`,
      '    if extra:',
      '        prompt_module.TRAE_AGENT_SYSTEM_PROMPT = prompt_module.TRAE_AGENT_SYSTEM_PROMPT.rstrip() + "\\n\\n" + extra',
      'except Exception:',
      '    pass',
      // On Windows Trae's bash tool opens cmd.exe but reads and writes UTF-8; on a Chinese
      // system cmd uses the ANSI code page (936), so even the start banner fails to decode and
      // every command raises a codec error. chcp 65001 is not an option (cmd exits when it reads
      // piped input containing Chinese under 65001), so only this one session is transcoded.
      'if os.name == "nt":',
      '    try:',
      '        import asyncio, locale',
      '        _acp = locale.getencoding()',
      '        class _AcpFallbackBuffer(bytearray):',
      '            def decode(self, encoding="utf-8", errors="strict"):',
      '                try:',
      '                    return bytearray.decode(self, encoding, errors)',
      '                except UnicodeDecodeError:',
      '                    return bytearray.decode(self, _acp, "replace")',
      '        _create_shell = asyncio.create_subprocess_shell',
      '        async def _trae_cmd_shell(cmd, *args, **kwargs):',
      '            proc = await _create_shell(cmd, *args, **kwargs)',
      '            if cmd == "cmd.exe /v:on":',
      '                for stream in (proc.stdout, proc.stderr):',
      '                    if stream is not None:',
      '                        stream._buffer = _AcpFallbackBuffer(stream._buffer)',
      '                if proc.stdin is not None:',
      '                    _write = proc.stdin.write',
      '                    proc.stdin.write = lambda data: _write(bytes(data).decode("utf-8", "replace").encode(_acp, "replace"))',
      '            return proc',
      '        asyncio.create_subprocess_shell = _trae_cmd_shell',
      '    except Exception:',
      '        pass',
      '',
    ].join('\n'), { mode: 0o600 })
    return { config: file, pythonPath: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  /** Trae Agent currently has no resume protocol and no enforceable read-only
   * mode. Its structured trajectory file is more reliable than the Rich console
   * output, so the handler reads that file after the process exits. */
  function traeAgentArgs(run, localImages, instruction, scheduleConfig = TRAE_AGENT_CONFIG) {
    const resultFile = path.join(os.tmpdir(), `opentandem-trae-${String(run.run_id).replace(/[^\w.-]/g, '_')}-${process.pid}.json`)
    const prompt = `${localImages.length
    ? `${instruction}\n\n[Image files attached to this message]\n${localImages.join('\n')}`
    : instruction}\n\n${t('After the final answer you must call the task_done tool to end the task.')}`
    return {
      argv: ['run', prompt, '--config-file', scheduleConfig, '-w', run.workdir || process.cwd(), '-ct', 'simple', '--max-steps', '50', '--trajectory-file', resultFile],
      stdinText: '',
      cwd: run.workdir || undefined,
      resultFile,
    }
  }

  function traeAgentHandler(ctx) {
    let consoleOutput = ''
    return {
      raw(text) {
        // The trajectory remains canonical on success. Keep the tail solely for
        // failures that happen before Trae Agent creates that file (bad binary,
        // invalid CLI arguments, config errors), otherwise the user only sees a
        // misleading ENOENT and the actionable upstream error is lost.
        consoleOutput = (consoleOutput + text).slice(-64 * 1024)
      },
      line() {},
      flush() {
        if (!ctx.resultFile || !fs.existsSync(ctx.resultFile)) {
          const detail = sanitizeRuntimeDetail(`${ctx.getStderrText?.() || ''}\n${consoleOutput}`)
            .replace(/\s+/g, ' ').trim().slice(-2000)
          ctx.setErrorText(detail
            ? t('Trae Agent produced no result file: {detail}', { detail })
            : t('Trae Agent produced no result file, and stdout and stderr were both empty'))
          return
        }
        try {
          const trajectory = JSON.parse(fs.readFileSync(ctx.resultFile, 'utf8'))
          if (!trajectory.success) {
            ctx.setErrorText(String(trajectory.final_result || t('Trae Agent did not complete the task')))
            return
          }
          const steps = Array.isArray(trajectory.agent_steps) ? trajectory.agent_steps : []
          const results = new Map()
          for (const step of steps) {
            for (const message of Array.isArray(step?.llm_messages) ? step.llm_messages : []) {
              const result = message?.tool_result
              if (result?.call_id) results.set(result.call_id, result)
            }
          }
          for (const step of steps) {
            const usage = step?.llm_response?.usage
            if (usage) {
              ctx.tokens.input += usage.input_tokens || 0
              ctx.tokens.output += usage.output_tokens || 0
            }
            for (const call of Array.isArray(step?.llm_response?.tool_calls) ? step.llm_response.tool_calls : []) {
              if (!call?.name || call.name === 'task_done') continue
              const arg = call.arguments?.command ?? call.arguments?.path ?? call.arguments?.file_path ?? ''
              const label = arg ? `${call.name}(${String(arg).slice(0, 300)})` : call.name
              const result = results.get(call.call_id)
              const output = String(result?.result || result?.error || '').slice(0, 2000)
              const rec = { kind: 'command', label, status: 'done', output }
              ctx.reasoningParts.push(rec)
              ctx.pump.push({ type: 'tool_event', data: { id: call.call_id, kind: 'command', label, status: 'done', output } })
            }
          }
          // Trae Agent 0.1.0 can report success with an empty top-level
          // final_result when the model writes its answer in one step and calls
          // task_done in the following step. Preserve that last non-empty model
          // content instead of turning a successful run into "no completed result".
          const stepAnswer = [...steps].reverse()
            .map(step => typeof step?.llm_response?.content === 'string' ? step.llm_response.content.trim() : '')
            .find(Boolean) || ''
          const answer = (typeof trajectory.final_result === 'string' ? trajectory.final_result.trim() : '') || stepAnswer
          if (answer) {
            ctx.setFullText(answer)
            ctx.pump.push({ type: 'content_delta', data: { text: answer } })
          }
        } catch (e) {
          ctx.setErrorText(t('Could not read the Trae Agent result: {detail}', { detail: e.message }))
        } finally {
          try { fs.unlinkSync(ctx.resultFile) } catch { /* temp file already absent */ }
        }
      },
    }
  }

  const KIMI_CODING_BASE_URL = ctx.config('KIMI_CODING_BASE_URL') || KIMI_CODING_DEFAULT_URL

  return {
    id: 'trae_agent',
    label: 'Trae Agent',
    executes: true,
    bin: () => TRAE_AGENT_BIN,
    detect: collectTraeAgent,
    models: () => traeAgentGroup(),
    install: {
      pip: (real, home) => real.startsWith(`${home}/.local/share/opentandem/runtimes/trae-agent/.venv/`),
    },
    // Runtime validation spawns the CLI, so it runs after the first acknowledged heartbeat.
    // A launchd job keeps an old environment across self-updates, so a stale configured
    // binary must be ignored even after the plist is repaired.
    // Runs `--help` on the candidates asynchronously, so a slow CLI never holds the Runner's main thread.
    startup: async () => {
      TRAE_AGENT_BIN = await resolveTraeAgentBin(CONFIGURED_TRAE_AGENT_BIN, DEFAULT_TRAE_AGENT_BIN, async (file, args, options) => {
        const { error, stdout } = await execFileNow(file, args, options)
        if (error) throw error
        return stdout
      })
    },
    toolSetup: traeAgentScheduleMcpConfig,
    command: (run, images, instruction, setup) => traeAgentArgs(run, images, instruction, setup?.config),
    handler: traeAgentHandler,
    stream: { raw: true },
    processEnv: (env, { run, setup }) => {
      if (setup) {
        env[ctx.configKey('TRAE_SYSTEM_INSTRUCTIONS')] = runtimeInstructions(run)
        env.PYTHONPATH = [setup.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      }
      const apiKey = kimiCodingApiKey()
      if (apiKey) env.OPENAI_API_KEY = apiKey
      // Both are Python CLIs: on Chinese Windows open() decodes as GBK by default, so reading
      // our UTF-8 config (with a Chinese workdir) raises UnicodeDecodeError. UTF-8 mode also covers stdio.
      if (process.platform === 'win32') env.PYTHONUTF8 = '1'
      env.OPENAI_BASE_URL = KIMI_CODING_BASE_URL
    },
  }
}
