// Pi Agent Harness (`pi`): `--mode json` runs; `--mode rpc` for native compaction.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMPACT_TIMEOUT_MS, npmInstall, providerErrorText } from '../../core/agent-kit/kit.mjs'
import { createGeminiApi, geminiApiKey } from '../../core/agent-kit/gemini-api.mjs'

// What reads or cleans up this agent's own session files. It uses only `io` and its
// arguments, so the Runner can also build it on its scan thread (see ownFiles).
export function createPiFiles(io) {
  const { fs, os, path } = io

  function piSessionExists(sessionId) {
    return !!piSessionPath(sessionId)
  }

  function piSessionPath(sessionId) {
    if (!sessionId) return false
    const root = path.join(os.homedir(), '.pi', 'agent', 'sessions')
    try {
      for (const project of fs.readdirSync(root)) {
        try {
          const name = fs.readdirSync(path.join(root, project)).find(file => file.endsWith(`_${sessionId}.jsonl`))
          if (name) return path.join(root, project, name)
        } catch { /* unreadable project */ }
      }
    } catch { /* no ~/.pi/agent/sessions */ }
    return ''
  }

  return {
    session: { path: id => piSessionPath(id), exists: id => piSessionExists(id) },
    purgeSide: ({ rmNamed }) => rmNamed('.pi', 'agent', 'sessions'),
  }
}

export function createPiAdapter(ctx) {
  const { execFile, spawn, VERSION_PROBE_MS, killCompactChild, runtimeInstructions, t } = ctx
  const files = createPiFiles({ fs, os, path })
  const geminiApi = createGeminiApi(ctx)
  const PI_BIN = ctx.config('PI_BIN') || 'pi'

  function collectPi() {
    return new Promise((resolve) => {
      execFile(PI_BIN, ['--version'], { timeout: VERSION_PROBE_MS }, (err, stdout) => resolve({
        installed: !err,
        login: !err,
        version: err ? null : String(stdout).trim().split('\n')[0],
      }))
    })
  }

  async function piGroup() {
    const status = await collectPi().catch(() => ({ installed: false, login: false }))
    if (!status.installed) return null
    const own = piOwnModel()
    if (own) return { runtime: 'pi', models: [{ slug: `pi/${own}`, display_name: own, reasoning_levels: [] }], default_model: `pi/${own}`, default_effort: null }
    const picked = geminiApi.geminiBackedModels('pi', 'gemini-3.5-flash-lite')
    return { runtime: 'pi', ...picked, default_effort: null }
  }

  function piOwnModel() {
    if (geminiApiKey()) return ''
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8'))
      return settings?.defaultProvider && settings?.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : ''
    } catch { return '' }
  }

  function piArgs(run, localImages, instruction) {
    const model = (run.model || '').replace(/^pi\//, '')
    const own = piOwnModel()
    // With a self-configured provider the model slug is provider/model; split it for pi
    const [provider, id] = own && model.includes('/') ? [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)] : ['google', model]
    const argv = ['--provider', provider, '--mode', 'json', '--append-system-prompt', runtimeInstructions(run)]
    if (id) argv.push('--model', id)
    if (run.exec_mode === 'readonly') argv.push('--tools', 'read,grep,find,ls')
    if (run.resume_thread_id) argv.push('--session', run.resume_thread_id)
    for (const image of localImages) argv.push(`@${image}`)
    argv.push('-p', instruction)
    return { argv, stdinText: '', cwd: run.workdir || undefined }
  }

  function piHandler(ctx) {
    let lastMessage = ''
    return {
      line(event) {
        if (event.type === 'session' && typeof event.id === 'string') {
          ctx.setSession(event.id)
          return
        }
        if (event.type !== 'message_end' || event.message?.role !== 'assistant') return
        if (event.message.stopReason === 'error' || event.message.errorMessage) {
          ctx.setErrorText(providerErrorText(event.message.errorMessage || 'Pi provider error'))
        }
        const content = Array.isArray(event.message.content) ? event.message.content : []
        const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
        for (const part of content) {
          if (part?.type === 'thinking' && part.thinking) {
            ctx.reasoningParts.push({ kind: 'reasoning', label: part.thinking })
            ctx.pump.push({ type: 'reasoning_delta', data: { text: part.thinking } })
          }
        }
        if (text) {
          if (lastMessage) {
            ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: lastMessage })
            ctx.pump.push({ type: 'reasoning_delta', data: { text: lastMessage } })
          }
          lastMessage = text
        }
        const usage = event.message.usage
        if (usage) {
          ctx.tokens.input += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
          ctx.tokens.output += (usage.output || 0) + (usage.reasoning || 0)
        }
      },
      flush() {
        if (!lastMessage) return
        ctx.setFullText(lastMessage)
        ctx.pump.push({ type: 'content_delta', data: { text: lastMessage } })
        lastMessage = ''
      },
    }
  }

  async function compactPi(sessionId, workdir, model) {
    const id = String(model || '').replace(/^pi\//, '')
    const [provider, piModel] = piOwnModel() && id.includes('/') ? [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)] : ['google', id]
    const argv = ['--provider', provider, '--mode', 'rpc', '--session', sessionId]
    if (piModel) argv.push('--model', piModel)
    return await new Promise(resolve => {
      const child = spawn(PI_BIN, argv, {
        stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir || undefined, env: process.env,
        detached: process.platform !== 'win32',
      })
      let settled = false
      let stderrTail = ''
      const finish = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killCompactChild(child)
        resolve(payload)
      }
      const timer = setTimeout(() => finish({ error: t('Pi did not finish compaction within {seconds}s', { seconds: COMPACT_TIMEOUT_MS / 1000 }) }), COMPACT_TIMEOUT_MS)
      let buf = ''
      child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-500) })
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          let m; try { m = JSON.parse(line) } catch { continue }
          if (m.type !== 'response' || m.command !== 'compact') continue
          // success=false is pi's real answer (most often "session too small, nothing to compact");
          // report it as is, never as a success and never as a tool failure.
          if (m.success !== true) return finish({ error: t('Pi did not compact: {reason}', { reason: m.error || t('no reason given') }) })
          const data = m.data || {}
          finish({
            ok: true,
            detail: t('Pi finished one native context compaction'),
            tokens_before: Number.isFinite(data.tokensBefore) ? data.tokensBefore : undefined,
            tokens_after: Number.isFinite(data.estimatedTokensAfter) ? data.estimatedTokensAfter : undefined,
          })
        }
      })
      child.on('error', e => finish({ error: t('Could not start pi: {detail}', { detail: e.message }) }))
      child.on('exit', code => finish({ error: t('pi exited unexpectedly (code={code}){tail}', { code, tail: stderrTail ? t(': {detail}', { detail: stderrTail.trim().slice(-200) }) : '' }) }))
      // rpc mode must load the session first; a command written immediately is dropped.
      setTimeout(() => { try { child.stdin.write(JSON.stringify({ id: 'compact', type: 'compact' }) + '\n') } catch { /* died */ } }, 2_000)
    })
  }

  return {
    id: 'pi',
    label: 'Pi Agent Harness',
    executes: true,
    bin: () => PI_BIN,
    detect: collectPi,
    models: () => piGroup(),
    probe: geminiApi.upstreamProbe,
    nativeInstructions: true,
    helpFile: true,
    install: {
      oneClick: npmInstall('pi', '@earendil-works/pi-coding-agent', ['--ignore-scripts']),
      npmPackage: () => '@earendil-works/pi-coding-agent',
      npmFlags: ['--ignore-scripts'],
    },
    session: files.session,
    ownFiles: createPiFiles,
    command: piArgs,
    handler: piHandler,
    systemProxy: true,
    processEnv: geminiApi.keyEnv,
    compact: (id, workdir, model) => compactPi(id, workdir, model),
    purgeSide: files.purgeSide,
  }
}
