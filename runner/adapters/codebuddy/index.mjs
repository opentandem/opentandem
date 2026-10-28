// CodeBuddy Code (`codebuddy`): headless stream-json runs (Claude Code protocol).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_NATIVE_SCHEDULER_TOOLS, createClaudeStreamHandler } from '../../core/agent-kit/claude-stream.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createCodeBuddyFiles(io) {
  const { fs, os, path } = io

  function codebuddySessionExists(sessionId) {
    return !!codebuddySessionPath(sessionId)
  }

  function codebuddySessionPath(sessionId) {
    if (!sessionId) return false
    const root = path.join(os.homedir(), '.codebuddy', 'projects')
    try {
      for (const project of fs.readdirSync(root)) {
        const file = path.join(root, project, `${sessionId}.jsonl`)
        if (fs.existsSync(file)) return file
      }
    } catch { /* no ~/.codebuddy/projects */ }
    return ''
  }

  return {
    session: { path: id => codebuddySessionPath(id), exists: id => codebuddySessionExists(id) },
    purgeSide: ({ rmNamed, rmMentioning }) => {
        rmNamed('.codebuddy', 'projects')
        rmMentioning('.codebuddy', 'logs')
        rmMentioning('.codebuddy', 'traces')
      },
  }
}

export function createCodeBuddyAdapter(ctx) {
  const { execFile, VERSION_PROBE_MS, runtimeInstructions, toolServerSpec } = ctx
  const files = createCodeBuddyFiles({ fs, os, path })
  const claudeHandler = createClaudeStreamHandler(ctx)
  const CODEBUDDY_BIN = ctx.config('CODEBUDDY_BIN') || 'codebuddy'

  function collectCodeBuddy() {
    return new Promise((resolve) => {
      execFile(CODEBUDDY_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => {
        if (err) { resolve({ installed: false, login: false, version: null, models: [] }); return }
        const account = codeBuddyAccountCache()
        const models = Array.isArray(account?.data?.models) ? account.data.models : []
        resolve({ installed: true, login: true, version: String(stdout).trim().split('\n')[0], models })
      })
    })
  }

  async function codebuddyGroup() {
    const status = await collectCodeBuddy().catch(() => ({ installed: false, login: false, models: [] }))
    if (!status.installed) return null
    const models = status.models
      .filter(model => typeof model?.id === 'string' && model.id)
      .map(model => ({ slug: model.id, display_name: typeof model.name === 'string' && model.name ? model.name : model.id, reasoning_levels: [] }))
    if (!models.length) models.push({ slug: 'default', display_name: 'Default', reasoning_levels: [] })
    return { runtime: 'codebuddy', models, default_model: models.some(model => model.slug === 'default') ? 'default' : models[0].slug, default_effort: null }
  }

  function codebuddyArgs(run, localImages, instruction) {
    const argv = ['-p', '--output-format', 'stream-json', '--setting-sources', 'user']
    if (run.exec_mode === 'readonly') argv.push('--permission-mode', 'plan', '--tools', 'Read,Glob,Grep')
    else argv.push('--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions')
    if (run.model && run.model !== 'default') argv.push('--model', run.model)
    if (run.reasoning_effort) argv.push('--effort', run.reasoning_effort)
    if (runtimeInstructions(run)) argv.push('--append-system-prompt', runtimeInstructions(run))
    if (run.resume_thread_id) argv.push('-r', run.resume_thread_id)
    // As in Claude Code: CodeBuddy shares its codebase and ships the same Cron tools
    // (product.*.json lists CronCreate/CronDelete/CronList in its tool allowlist).
    argv.push('--disallowedTools', CLAUDE_NATIVE_SCHEDULER_TOOLS)
    argv.push('--mcp-config', JSON.stringify({ mcpServers: { opentandem: toolServerSpec(run) } }))
    const stdinText = localImages.length
      ? `${instruction}\n\n[Images attached to this message (open them with the Read tool)]\n${localImages.join('\n')}`
      : instruction
    return { argv, stdinText, cwd: run.workdir || undefined }
  }

  function codeBuddyAccountCache() {
    const root = path.join(os.homedir(), '.codebuddy', 'local_storage')
    try {
      for (const file of fs.readdirSync(root)) {
        if (!file.endsWith('.info')) continue
        try {
          const rows = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
          const account = Array.isArray(rows) ? rows.find(row => row && typeof row.userId === 'string' && row.userId) : null
          if (account) return account
        } catch { /* not an account cache */ }
      }
    } catch { /* no local state */ }
    return null
  }

  return {
    id: 'codebuddy',
    label: 'CodeBuddy Code',
    executes: true,
    bin: () => CODEBUDDY_BIN,
    detect: collectCodeBuddy,
    models: () => codebuddyGroup(),
    nativeInstructions: true,
    session: files.session,
    ownFiles: createCodeBuddyFiles,
    command: codebuddyArgs,
    handler: claudeHandler,
    purgeSide: files.purgeSide,
  }
}
