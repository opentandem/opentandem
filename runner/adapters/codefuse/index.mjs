// CodeFuse Agent (`cfuse`): an isolated Python venv running on Kimi's OpenAI-compatible coding endpoint.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KIMI_CODING_DEFAULT_URL, kimiBackedGroup, kimiCodingApiKey } from '../../core/agent-kit/kimi-coding.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createCodeFuseFiles(io) {
  const { fs, os, path } = io

  /** cfuse 0.1.0 `path_to_slug`: absolute path, leading "/" dropped, "/" -> "-",
   *  " " -> "_", and on Windows ":" -> "-" (backslashes stay, so the slug is a
   *  nested path there). The working directory is the resolved real path, the
   *  same one cfuse uses when it looks a session up. */
  function codefuseSlug(workdir) {
    let abs = path.resolve(workdir || process.cwd())
    try { abs = process.platform === 'win32' ? fs.realpathSync.native(abs) : fs.realpathSync(abs) } catch { /* missing: keep the resolved path */ }
    let slug = abs.startsWith('/') ? abs.slice(1) : abs
    slug = slug.replaceAll('/', '-').replaceAll(' ', '_')
    if (process.platform === 'win32') slug = slug.replaceAll(':', '-')
    return slug
  }

  /** A session is ~/.cfuse/logs/<slug>/<id>/ (the Runner pins --logs-dir to
   *  that root); `--session-id <id>` resumes from llm_messages.json there. Only a
   *  non-empty snapshot counts: without it cfuse silently starts a fresh session. */
  function codefuseSessionDir(sessionId, workdir) {
    if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return ''
    return path.join(os.homedir(), '.cfuse', 'logs', codefuseSlug(workdir), sessionId)
  }

  function codefuseSessionPath(sessionId, workdir) {
    const dir = codefuseSessionDir(sessionId, workdir)
    if (!dir) return ''
    const file = path.join(dir, 'llm_messages.json')
    try { return fs.statSync(file).size > 0 ? file : '' } catch { return '' }
  }

  /** Context size after the latest model call: prompt + completion tokens of the
   *  last assistant_response in trajectory.jsonl (appended across resumed turns). */
  function codefuseContextTokens(sessionId, workdir) {
    const dir = codefuseSessionDir(sessionId, workdir)
    if (!dir) return 0
    try {
      const fd = fs.openSync(path.join(dir, 'trajectory.jsonl'), 'r')
      try {
        const size = fs.fstatSync(fd).size
        const len = Math.min(size, 4 * 1024 * 1024)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        const lines = buf.toString('utf8').split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"assistant_response"')) continue
          let entry
          try { entry = JSON.parse(lines[i]) } catch { continue }
          const u = entry.extra_data?.token_usage
          const total = (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)
          if (entry.event_type === 'assistant_response' && total > 0) return total
        }
      } finally { fs.closeSync(fd) }
    } catch { /* unreadable: no context size */ }
    return 0
  }

  return {
    session: { path: (id, workdir) => codefuseSessionPath(id, workdir), exists: (id, workdir) => !!codefuseSessionPath(id, workdir) },
    contextTokens: (id, workdir) => codefuseContextTokens(id, workdir),
    // Title side calls run in a temp `ot-title-*` workdir, so their session sits
    // under a slug that contains that directory name.
    purgeSide: ({ rmNamed }) => rmNamed('.cfuse', 'logs'),
  }
}

export function createCodeFuseAdapter(ctx) {
  const { execFile, execFileNow, VERSION_PROBE_MS, runtimeInstructions, windowsCommand, resolveExecutable } = ctx
  const files = createCodeFuseFiles({ fs, os, path })
  const IS_WIN = process.platform === 'win32'
  const CODEFUSE_BIN = ctx.config('CODEFUSE_BIN') || path.join(os.homedir(), '.local', 'share', 'opentandem', 'runtimes', 'codefuse-agent', '.venv', ...(IS_WIN ? ['Scripts', 'cfuse.exe'] : ['bin', 'cfuse']))
  const KIMI_CODING_BASE_URL = ctx.config('KIMI_CODING_BASE_URL') || KIMI_CODING_DEFAULT_URL
  const GIT_BASH_ENV = ctx.configKey('GIT_BASH')

  function collectCodeFuse() {
    return new Promise((resolve) => {
      // CodeFuse 0.1.x has no --version flag; --help is the stable installation probe.
      execFile(CODEFUSE_BIN, ['--help'], { timeout: VERSION_PROBE_MS }, (err) => {
        let version = null
        if (!err) try {
          const venv = path.dirname(path.dirname(resolveExecutable(CODEFUSE_BIN)))
          const roots = IS_WIN ? [path.join(venv, 'Lib', 'site-packages')]
            : fs.readdirSync(path.join(venv, 'lib')).filter(name => /^python\d+\.\d+$/.test(name)).map(name => path.join(venv, 'lib', name, 'site-packages'))
          for (const root of roots) {
            for (const dir of fs.readdirSync(root).filter(name => /^cfuse-.*\.dist-info$/.test(name))) {
              const metadata = fs.readFileSync(path.join(root, dir, 'METADATA'), 'utf8')
              if (/^Name: cfuse\s*$/m.test(metadata)) version = /^Version: (\S+)$/m.exec(metadata)?.[1] || null
            }
          }
        } catch { /* Do not invent a version when installed metadata is missing. */ }
        resolve({ installed: !err, login: !err, version })
      })
    })
  }

  async function codefuseGroup() {
    const status = await collectCodeFuse().catch(() => ({ installed: false, login: false }))
    return status.installed ? kimiBackedGroup('codefuse', 'codefuse') : null
  }

  // CodeFuse's bash tool hardcodes '/bin/bash' and opens the session at startup, so on Windows
  // the whole CLI fails to start. A sitecustomize swaps it for Git Bash (Claude Code relies on it
  // on Windows too); native command output uses the ANSI code page, so text mode gets
  // errors="replace" and one bad byte cannot kill the reader thread.
  function winGitBash() {
    const gitExe = windowsCommand('git')?.file
    return [
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
      gitExe && path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    ].find(file => file && fs.existsSync(file)) || null
  }

  function codefuseWinShimDir() {
    const dir = path.join(os.tmpdir(), 'opentandem-codefuse-shim')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sitecustomize.py'), [
      'import os, subprocess',
      `_bash = os.environ.get("${GIT_BASH_ENV}")`,
      'if os.name == "nt" and _bash:',
      '    class _GitBashPopen(subprocess.Popen):',
      '        def __init__(self, args, *rest, **kwargs):',
      '            if isinstance(args, list) and args and args[0] == "/bin/bash":',
      '                args = [_bash] + args[1:]',
      '                if kwargs.get("text") or kwargs.get("universal_newlines"):',
      '                    kwargs.setdefault("errors", "replace")',
      '            super().__init__(args, *rest, **kwargs)',
      '    subprocess.Popen = _GitBashPopen',
      '',
    ].join('\n'))
    return dir
  }

  async function codefuseHelpSetup(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentandem-codefuse-help-'))
    const agentFile = path.join(dir, 'agent.md')
    // Load the installed CLI's current default, including user overrides and tool
    // restrictions. Do not reconstruct its profile or change its model/tools.
    const python = path.join(path.dirname(CODEFUSE_BIN), IS_WIN ? 'python.exe' : 'python')
    const script = [
      'import json',
      'from codefuse.core.agent_config import AgentProfileManager',
      'p = AgentProfileManager().get_agent("default")',
      'print(json.dumps({"name":p.name,"description":p.description,"tools":p.tools,"model":p.model,"system_prompt":p.system_prompt}))',
    ].join('\n')
    try {
      // Asynchronous: the Runner's main thread must not wait on a CLI.
      const loaded = await execFileNow(python, ['-c', script], { encoding: 'utf8', timeout: 10000 })
      if (loaded.error) throw loaded.error
      const profile = JSON.parse(loaded.stdout)
      const header = ['---', `name: ${profile.name}`, `description: ${profile.description}`, `tools: ${profile.tools ? profile.tools.join(', ') : ''}`, `model: ${profile.model || ''}`, '---'].join('\n')
      fs.writeFileSync(agentFile, `${header}\n${profile.system_prompt}\n\n${runtimeInstructions(run)}\n`, { mode: 0o600 })
      return { agentFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  /** Native session id for this run: the resumed one, else a new one derived
   *  from the run (attempt included, so a retry never reuses a half-written
   *  session). Only [\w.-], because it becomes a directory name. */
  function codefuseSessionId(run) {
    if (run.resume_thread_id) return run.resume_thread_id
    const base = String(run.run_id || '').replace(/[^\w.-]/g, '').slice(0, 64) || crypto.randomUUID()
    return `ot-${base}-${run.attempt || 1}`
  }

  /** CodeFuse emits plain final text in --no-stream mode. `--yolo` is required
   * for unattended tool execution; the current CLI exposes no read-only tool
   * allowlist, so the server offers only full access. `--session-id` always
   * names the native session: an existing one is resumed (cfuse reloads its
   * llm_messages.json, tool results included), a new one is created. The logs
   * root is pinned so a workdir `.cfuse.yaml` or LOGS_DIR cannot move sessions
   * away from where the session reader looks. */
  function codefuseArgs(run, localImages, instruction, agentFile) {
    const prompt = localImages.length
      ? `${instruction}\n\n[Image files attached to this message]\n${localImages.join('\n')}`
      : instruction
    const model = (run.model || 'codefuse/kimi-for-coding').replace(/^codefuse\//, '')
    return {
      argv: ['-p', prompt, ...(agentFile ? ['--agent-file', agentFile] : []), '--provider', 'openai_compatible', '--model', model, '--base-url', KIMI_CODING_BASE_URL, '--temperature', '1', '--yolo', '--no-stream', '--max-iterations', '50',
        '--session-id', codefuseSessionId(run), '--logs-dir', path.join(os.homedir(), '.cfuse', 'logs')],
      stdinText: '',
      cwd: run.workdir || undefined,
    }
  }

  /** stdout is the final reply as plain text, preceded by cfuse's own status
   *  lines (agent file loaded, session resumed, a stray debug repr). Those are
   *  dropped. A reply that starts with `Error:` is cfuse reporting a failed
   *  model call (it still exits 0, e.g. on HTTP 403), so it becomes the error
   *  instead of the answer. The session id is reported before any output so a
   *  crash mid-turn still leaves it resumable. */
  const CODEFUSE_STATUS_LINE = [
    /^Loading agent from file: /,
    /^\u2713 Agent loaded: /,
    /^\u{1F4C2} Resuming session: /u,
    /^ {3}Loaded \d+ messages from history$/,
    /^\u26A0\uFE0F? +Warning: Failed to load session history: /,
    /^ {3}Starting fresh session with ID: /,
    /^<codefuse\.[\w.]+ object at 0x[0-9a-fA-F]+>$/,
  ]

  function codefuseHandler(ctx) {
    if (ctx.codefuseSessionId) ctx.setSession(ctx.codefuseSessionId)
    let pending = ''
    let mode = 'status' // status -> answer | error
    let answer = ''
    let error = ''
    const take = (line, newline) => {
      if (mode === 'status') {
        if (!line.trim() || CODEFUSE_STATUS_LINE.some(re => re.test(line))) return
        mode = /^(Error|Configuration Errors):/.test(line) ? 'error' : 'answer'
      }
      const text = line + newline
      if (mode === 'error') { error += text; return }
      answer += text
      ctx.pump.push({ type: 'content_delta', data: { text } })
    }
    return {
      raw(text) {
        if (mode === 'answer' && !pending) {
          answer += text
          ctx.pump.push({ type: 'content_delta', data: { text } })
          return
        }
        pending += text
        let at
        while (mode !== 'answer' && (at = pending.indexOf('\n')) >= 0) {
          take(pending.slice(0, at).replace(/\r$/, ''), '\n')
          pending = pending.slice(at + 1)
        }
        if (mode === 'answer' && pending) { const rest = pending; pending = ''; take(rest, '') }
      },
      line() { /* stdout is plain final text, not JSONL */ },
      flush() {
        if (pending) { const rest = pending; pending = ''; take(rest, '') }
        if (error.trim()) { ctx.setErrorText(error.trim()); return }
        const finalText = answer.trim()
        if (finalText) ctx.setFullText(finalText)
      },
    }
  }

  return {
    id: 'codefuse',
    label: 'CodeFuse Agent',
    executes: true,
    bin: () => CODEFUSE_BIN,
    detect: collectCodeFuse,
    models: () => codefuseGroup(),
    nativeInstructions: true,
    helpFile: true,
    install: {
      pip: (real, home) => real.startsWith(`${home}/.local/share/opentandem/runtimes/codefuse-agent/.venv/`),
    },
    toolSetup: codefuseHelpSetup,
    command: (run, images, instruction, setup) => codefuseArgs(run, images, instruction, setup?.agentFile),
    handler: codefuseHandler,
    stream: { raw: true },
    session: files.session,
    contextTokens: files.contextTokens,
    processEnv: (env, { run }) => {
      const sessionId = codefuseSessionId(run)
      const apiKey = kimiCodingApiKey()
      if (apiKey) env.OPENAI_API_KEY = apiKey
      if (IS_WIN) env.PYTHONUTF8 = '1'
      env.COLUMNS = '500'
      if (IS_WIN) {
        const bash = winGitBash()
        if (bash) {
          env[GIT_BASH_ENV] = bash
          env.PYTHONPATH = [codefuseWinShimDir(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
        }
      }
      // Hands the session id to the handler (it has no access to the run).
      return () => ({ codefuseSessionId: sessionId })
    },
    purgeSide: files.purgeSide,
    ownFiles: createCodeFuseFiles,
  }
}
