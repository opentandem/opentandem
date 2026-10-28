/** OpenCode's noninteractive CLI disables/cancels its native question tool.
 * Drive an owned `serve` process instead, preserving the existing output parser.
 * V1 uses Question + message parts; V2 uses Form + durable session events.
 * No dependency on the app: this module is inlined into the downloaded Runner. */
import http from 'node:http'

/** A fetch-shaped request over node:http, for requests that last as long as the turn. The global
 *  fetch gives up after 300 s without response headers (undici headersTimeout), and OpenCode V1
 *  answers the prompt request only when the whole turn ends, so every turn longer than five
 *  minutes was cut off as "fetch failed". node:http has no such limit; the run's own controller
 *  still aborts it. Its own connection (agent: false), so no keep-alive socket timeout applies. */
function longRequest(url, { method, signal, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method, signal, agent: false,
      headers: body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(text) })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

export function createOpenCodeNativeRun(ctx, output) {
  const v2 = ctx.opencodeMajor >= 2
  const fetcher = ctx.fetch || fetch
  const longFetcher = ctx.fetch || longRequest
  const controller = new AbortController()
  let base = '', startup = '', sessionID = ctx.resumeThreadId || ''
  let finished = false, submitted = false, promoted = false, replying = false
  let v1Busy = false, v1Idle = false, v1PromptDone = false
  let pending = null
  const queued = [], requests = new Set(), seen = new Set(), tools = new Map()
  const owned = new Set()
  const messageID = ctx.opencodeMessageId
  const startupTimer = setTimeout(() => fail('OpenCode server startup timed out'), 30_000)
  startupTimer.unref?.()
  const directory = `directory=${encodeURIComponent(ctx.cwd)}`
  const scoped = route => v2 ? route : `${route}${route.includes('?') ? '&' : '?'}${directory}`
  const api = async (route, method = 'GET', body, long = false) => {
    const signal = long ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    const response = await (long ? longFetcher : fetcher)(`${base}${scoped(route)}`, {
      method, signal, headers: { authorization: ctx.opencodeAuthorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`OpenCode API ${method} ${route.split('?')[0]} failed (HTTP ${response.status})`)
    return response.status === 204 ? null : response.json()
  }
  function fail(error) {
    if (finished) return
    finished = true
    clearTimeout(startupTimer)
    controller.abort()
    pending = null
    ctx.setErrorText(error instanceof Error ? error.message : String(error))
    ctx.stop()
  }
  function complete() {
    if (finished) return
    if (pending || queued.length) { fail('OpenCode finished with an unanswered question'); return }
    finished = true
    clearTimeout(startupTimer)
    controller.abort()
    ctx.markDone()
    ctx.stop()
  }
  const emit = (type, part, error) => output.line({ type, sessionID, part, error })
  // OpenCode retries a failed model call by itself (a hung model shows up only after its 300 s
  // timeout). Each retry becomes a live progress line; it is not part of the saved timeline.
  let retries = 0
  function retrying(retry, reason) {
    if (!Number.isSafeInteger(retry) || retry < 1) return
    ctx.pump.push({ type: 'tool_event', data: { id: `retry:${++retries}`, kind: 'retry', label: String(reason || 'unknown error').slice(0, 500), retry } })
  }
  // The provider's HTTP status rides along as JSON, so the failure title can show it.
  function errorText(error, fallback) {
    const message = error?.data?.message || error?.message || fallback
    const status = error?.data?.statusCode ?? error?.status
    return Number.isSafeInteger(status) ? JSON.stringify({ message, statusCode: status }) : message
  }
  async function owns(id) {
    if (!id || id === 'global') return false
    if (owned.has(id)) return true
    // Questions/permissions from native child sessions must remain answerable,
    // but an unrelated session must never be admitted through the shared DB.
    const visited = new Set()
    let next = id
    while (next && !visited.has(next) && visited.size < 32) {
      if (owned.has(next)) { owned.add(id); return true }
      visited.add(next)
      const result = await api(`${v2 ? '/api' : ''}/session/${encodeURIComponent(next)}`)
      next = (v2 ? result.data : result)?.parentID
    }
    return false
  }
  function showNext() {
    if (finished || pending || !queued.length) return
    pending = queued.shift()
    ctx.pump.push({ type: 'user_input', data: { key: pending.key, questions: pending.questions } })
    void ctx.pump.finish?.()
  }
  function ask(request) {
    if (requests.has(request.id)) return
    const fields = v2 ? request.fields : request.questions
    if (!Array.isArray(fields) || !fields.length || fields.length > 10) throw new Error('OpenCode returned unsupported questions')
    const key = `opencode:${request.sessionID}:${request.id}`
    const questions = fields.map((field, index) => {
      if (v2 && !['string', 'multiselect'].includes(field.type)) throw new Error('OpenCode returned an unsupported question field')
      const options = (field.options || []).map(option => ({ label: option.label, description: option.description || '' }))
      const question = { id: `question_${index}`, header: (v2 ? field.title : field.header) || '',
        question: (v2 ? field.description : field.question) || '', options,
        isOther: field.custom !== false, isSecret: false, multiple: v2 ? field.type === 'multiselect' : field.multiple === true }
      if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 10000
        || typeof question.header !== 'string' || question.header.length > 300 || options.length > 20
        || options.some(o => typeof o.label !== 'string' || !o.label || o.label.length > 2000 || typeof o.description !== 'string' || o.description.length > 4000)
        || new Set(options.map(o => o.label)).size !== options.length) throw new Error('OpenCode returned invalid question options')
      return question
    })
    if (key.length > 300) throw new Error('OpenCode returned an invalid question identifier')
    requests.add(request.id)
    queued.push({ key, request, fields, questions })
    showNext()
  }
  function settled(id, cancelled) {
    const index = queued.findIndex(q => q.request.id === id)
    if (index >= 0) queued.splice(index, 1)
    if (pending?.request.id !== id) return
    if (cancelled) { fail('OpenCode cancelled the pending question. Send a new message to continue.'); return }
    // The native event confirms acceptance, including an answer from another
    // native client. Never ACK merely because the browser submitted a value.
    ctx.pump.push({ type: 'user_input_answered', data: { key: pending.key } })
    pending = null
    void ctx.pump.finish?.()
    showNext()
  }
  function partV1(part) {
    if (part?.sessionID !== sessionID) return
    const terminal = part.type === 'tool' ? ['completed', 'error'].includes(part.state?.status)
      : part.type === 'step-finish' || (['text', 'reasoning'].includes(part.type) && part.time?.end)
    if (!terminal || seen.has(part.id)) return
    seen.add(part.id)
    emit(part.type === 'tool' ? 'tool_use' : part.type === 'step-finish' ? 'step_finish' : part.type, part)
  }
  async function event(event) {
    if (finished || !submitted) return
    const data = v2 ? event.data : event.properties
    if (!data) return
    if (event.type === 'permission.asked' && await owns(data.sessionID)) {
      await api(v2 ? `/api/session/${data.sessionID}/permission/${data.id}/reply` : `/permission/${data.id}/reply`, 'POST',
        v2 ? { decision: ctx.execMode === 'readonly' ? 'reject' : 'once' } : { reply: ctx.execMode === 'readonly' ? 'reject' : 'once' })
      return
    }
    const question = v2 && event.type === 'form.created' ? data.form : !v2 && event.type === 'question.asked' ? data : null
    if (question && await owns(question.sessionID)) {
      if (v2 && question.metadata?.kind !== 'question') throw new Error('OpenCode requested an unsupported interactive form')
      ask(question)
      return
    }
    if (['question.replied', 'question.rejected', 'form.replied', 'form.cancelled'].includes(event.type)) {
      if (await owns(data.sessionID)) settled(v2 ? data.id : data.requestID, ['question.rejected', 'form.cancelled'].includes(event.type))
      return
    }
    if (!v2) {
      if (event.type === 'message.part.updated') partV1(data.part)
      if (event.type === 'session.status' && data.sessionID === sessionID) {
        if (data.status?.type === 'busy' || data.status?.type === 'retry') v1Busy = true
        if (data.status?.type === 'retry') retrying(data.status.attempt, data.status.message)
        if (data.status?.type === 'idle' && v1Busy) { v1Idle = true; if (v1PromptDone) complete() }
      }
      if (event.type === 'session.error' && data.sessionID === sessionID) fail(errorText(data.error, 'OpenCode session failed'))
      return
    }
    if (data.sessionID !== sessionID) return
    if (event.type === 'session.inbox.delivered' && data.inboxID === messageID) { promoted = true; return }
    if (!promoted) {
      if (event.type === 'session.execution.failed') fail(errorText(data.error, 'OpenCode failed before accepting the prompt'))
      return
    }
    if (seen.has(event.id)) return
    seen.add(event.id)
    // V2 numbers the request about to be made, so its first retry is attempt 2.
    if (event.type === 'session.retry.scheduled') retrying(data.attempt - 1, data.error?.message)
    const part = { id: event.id, sessionID, messageID: data.assistantMessageID }
    if (event.type === 'session.text.ended') emit('text', { ...part, text: data.text })
    if (event.type === 'session.step.ended') emit('step_finish', { ...part, tokens: data.tokens, cost: data.cost })
    const toolKey = `${data.assistantMessageID}:${data.id}`
    if (event.type === 'session.tool.input.started') tools.set(toolKey, { name: data.name, input: {} })
    if (event.type === 'session.tool.called') {
      const tool = tools.get(toolKey) || { name: 'tool' }
      tool.input = data.input
      tools.set(toolKey, tool)
      emit('tool_use', { ...part, callID: data.id, tool: tool.name, state: { status: 'running', input: tool.input } })
    }
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
      const tool = tools.get(toolKey) || { name: 'tool', input: {} }
      emit('tool_use', { ...part, callID: data.id, tool: tool.name, state: { input: tool.input,
        status: event.type === 'session.tool.success' ? 'completed' : 'error',
        output: (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n'), error: data.error?.message } })
      tools.delete(toolKey)
    }
    if (event.type === 'session.execution.succeeded') complete()
    if (event.type === 'session.execution.failed' || event.type === 'session.step.failed') fail(errorText(data.error, 'OpenCode execution failed'))
    if (event.type === 'session.execution.interrupted') fail(`OpenCode execution interrupted: ${data.reason || 'unknown'}`)
  }
  async function stream(response) {
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', inactivityTimer
    const touch = () => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => fail('OpenCode event stream stopped responding'), 60_000)
      inactivityTimer.unref?.()
    }
    touch()
    try {
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        touch()
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (data) await event(JSON.parse(data))
        }
        if (buffer.length > 8 * 1024 * 1024) throw new Error('OpenCode event stream exceeded the frame limit')
      }
      if (!finished) fail('OpenCode event stream disconnected before completion')
    } catch (error) { if (!finished) fail(error) }
    finally { clearTimeout(inactivityTimer); void reader.cancel().catch(() => {}) }
  }
  async function start() {
    const parsed = /^([^/]+)\/(.+?)(?:#([^#]+))?$/.exec(ctx.model || '')
    const effort = ctx.reasoningEffort && ctx.reasoningEffort !== '__default__' ? ctx.reasoningEffort : undefined
    const model = parsed ? { providerID: parsed[1], id: parsed[2], ...(effort || parsed[3] ? { variant: effort || parsed[3] } : {}) } : undefined
    if (ctx.model && !parsed) throw new Error('OpenCode requires a provider/model identifier')
    if (v2 && effort && !model) throw new Error('OpenCode requires a model when selecting a reasoning variant')
    const questionRule = v2 ? { action: 'question', resource: '*', effect: 'allow' } : { permission: 'question', pattern: '*', action: 'allow' }
    const planRules = ['plan_enter', 'plan_exit'].map(action => v2 ? { action, resource: '*', effect: 'deny' } : { permission: action, pattern: '*', action: 'deny' })
    if (sessionID) {
      const result = await api(`${v2 ? '/api' : ''}/session/${encodeURIComponent(sessionID)}`)
      const session = v2 ? result.data : result
      const rules = (v2 ? session.permissions : session.permission) || []
      const permission = [...rules.filter(r => !['question', 'plan_enter', 'plan_exit'].includes(v2 ? r.action : r.permission)), questionRule, ...planRules]
      await api(`${v2 ? '/api' : ''}/session/${encodeURIComponent(sessionID)}`, 'PATCH', v2 ? { permissions: permission } : { permission })
      if (v2 && model) await api(`/api/session/${sessionID}/model`, 'POST', { model })
      if (v2 && ctx.execMode === 'readonly') await api(`/api/session/${sessionID}/agent`, 'POST', { agent: 'plan' })
      else if (v2 && session.agent === 'plan') {
        // V2 persists the selected agent across turns. Its agent list puts the
        // configured default first; leave an existing custom agent untouched,
        // and only leave plan when the current run explicitly permits execution.
        const catalog = await api('/api/agent')
        const agent = catalog.data?.find(a => a.id !== 'plan' && a.mode !== 'subagent' && !a.hidden)
        if (!agent?.id) throw new Error('OpenCode has no executable primary agent for this run')
        await api(`/api/session/${sessionID}/agent`, 'POST', { agent: agent.id })
      }
    } else {
      const result = await api(v2 ? '/api/session' : '/session', 'POST', v2
        ? { location: { directory: ctx.cwd }, agent: ctx.execMode === 'readonly' ? 'plan' : undefined, model, permissions: [questionRule, ...planRules] }
        : { permission: [questionRule, ...planRules] })
      sessionID = (v2 ? result.data : result)?.id
    }
    if (!sessionID) throw new Error('OpenCode did not return a session ID')
    owned.add(sessionID)
    ctx.setSession(sessionID)
    const response = await fetcher(`${base}${scoped(v2 ? '/api/event' : '/event')}`, {
      headers: { authorization: ctx.opencodeAuthorization }, signal: controller.signal,
    })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('OpenCode could not open its event stream')
    clearTimeout(startupTimer)
    submitted = true
    void stream(response)
    // The prompt goes into the native session next: a later failure must not be replayed into it again.
    ctx.markSubmitted?.()
    if (v2) {
      await api(`/api/session/${sessionID}/prompt`, 'POST', { id: messageID, text: ctx.instruction,
        files: (ctx.opencodeFiles || []).map(file => ({ uri: file.url, name: file.filename })), delivery: 'steer' }, true)
      // Admission is not completion. Only a promoted execution terminal ends this run.
    } else {
      const result = await api(`/session/${sessionID}/message`, 'POST', {
        agent: ctx.execMode === 'readonly' ? 'plan' : undefined,
        ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
        ...(model?.variant || effort ? { variant: model?.variant || effort } : {}),
        parts: [...(ctx.opencodeFiles || []).map(file => ({ type: 'file', ...file })), { type: 'text', text: ctx.instruction }],
      }, true)
      if (finished) return
      if (result?.info?.error) throw new Error(errorText(result.info.error, 'OpenCode prompt failed'))
      if (result?.info?.role !== 'assistant') throw new Error('OpenCode did not return a completed assistant message')
      for (const part of result.parts || []) partV1(part)
      v1PromptDone = true
      if (v1Idle) complete()
    }
  }
  return {
    line: output.line,
    raw(text) {
      if (finished || base) return
      startup = (startup + text).slice(-8192)
      const match = startup.match(/https?:\/\/127\.0\.0\.1:\d+/)
      if (!match) return
      base = match[0]
      void start().catch(fail)
    },
    async answer(input) {
      if (finished || replying || !pending || input?.key !== pending.key || !input.answers) return
      const current = pending
      const selected = current.questions.map(q => input.answers[q.id]?.answers)
      if (selected.some((values, index) => !Array.isArray(values) || !values.length || (!current.questions[index].multiple && values.length !== 1)
        || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000)
        || (current.questions[index].isOther === false && values.some(value => !current.questions[index].options.some(o => o.label === value))))) return
      replying = true
      try {
        if (v2) {
          const answer = Object.fromEntries(current.fields.map((field, index) => {
            const values = selected[index].map(value => field.options?.find(o => o.label === value)?.value ?? value)
            return [field.key, field.type === 'multiselect' ? values : values[0]]
          }))
          await api(`/api/session/${current.request.sessionID}/form/${current.request.id}/reply`, 'POST', { answer })
        } else await api(`/question/${current.request.id}/reply`, 'POST', { answers: selected })
        if (!finished && pending === current) settled(current.request.id, false)
      } catch (error) { fail(error) }
      finally { replying = false }
    },
    flush() {
      finished = true
      clearTimeout(startupTimer)
      controller.abort()
      pending = null
      queued.length = 0
      output.flush()
    },
  }
}
