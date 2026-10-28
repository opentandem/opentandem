// Parser for the Claude Code `--output-format stream-json` event stream, shared by every CLI
// that speaks the same protocol (Claude Code, Qwen Code, CodeBuddy).
import { mainSessionEventGuard, providerErrorText } from './kit.mjs'

// Claude Code's own scheduling tools (CodeBuddy ships the same set). They are disallowed so the
// only way to schedule is the Runner's tool server, whose tasks survive the CLI process.
export const CLAUDE_NATIVE_SCHEDULER_TOOLS = 'CronCreate,CronList,CronDelete,RemoteTrigger,ScheduleWakeup'

export function createClaudeStreamHandler({ t }) {
  /**
   * claude `-p --output-format stream-json` → the same StreamEvents.
   * Shapes that matter (everything else — thinking_tokens, rate_limit_event,
   * hook_started … — is deliberately ignored):
   *   {type:'system', subtype:'init', session_id}       → session id
   *   {type:'assistant', message:{content:[…]}}         → thinking / text / tool_use
   *   {type:'user', message:{content:[tool_result…]}}   → tool output
   *   {type:'result', subtype:'success', result, usage} → final answer + tokens
   */
  function claudeHandler(ctx) {
    const isMainSession = mainSessionEventGuard(ctx)
    const toolById = new Map()
    const nativeInput = ctx.runtime === 'claude'
    let finished = false
    let userInput = null
    let answerText = ''
    const seenRequests = new Set()
    const respond = (event, response) => ctx.send({
      type: 'control_response', response: {
        subtype: 'success', request_id: event.request_id,
        response: { ...response, toolUseID: event.request?.tool_use_id },
      },
    })
    const deny = (event, message) => {
      respond(event, { behavior: 'deny', message })
      ctx.reasoningParts.push({ kind: 'reasoning', label: message })
      ctx.pump.push({ type: 'reasoning_delta', data: { text: message } })
      void ctx.pump.finish?.()
    }
    if (nativeInput) {
      const content = ctx.localImages?.length
        ? `${ctx.instruction}\n\n[Images attached to this message (open them with the Read tool)]\n${ctx.localImages.join('\n')}`
        : ctx.instruction
      ctx.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null,
        session_id: ctx.resumeThreadId || 'default' })
    }
    let mainModel = ''
    const labelFor = (name, input) => {
      const arg = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.prompt
      const text = typeof arg === 'string' ? arg : ''
      return text ? `${name}(${text.length > 300 ? text.slice(0, 300) + '…' : text})` : name
    }
    return {
      answer(input) {
        if (!nativeInput || finished || !userInput || input?.key !== userInput.key || !input.answers) return
        const answers = {}
        for (const [index, question] of userInput.event.request.input.questions.entries()) {
          const selected = input.answers[`question_${index}`]?.answers
          if (!Array.isArray(selected) || !selected.length || (!question.multiSelect && selected.length !== 1)
            || selected.some(value => typeof value !== 'string' || !value.trim())) return
          Object.defineProperty(answers, question.question, { value: selected.join(', '), enumerable: true })
        }
        const pending = userInput
        userInput = null
        respond(pending.event, { behavior: 'allow', updatedInput: { ...pending.event.request.input, answers } })
        ctx.pump.push({ type: 'user_input_answered', data: { key: pending.key } })
        void ctx.pump.finish?.()
      },
      line(event) {
        // After the first result stdin is closed, so control frames cannot be answered and are
        // ignored. But once a background sub-agent finishes, Claude Code runs another turn in the
        // same process and emits another result (observed 2026-10-18); keep collecting that
        // turn's text and usage, or the user only sees "waiting for the research" and loses the
        // actual conclusion.
        if (nativeInput && finished && (event.type === 'control_request' || event.type === 'control_cancel_request')) return
        // Control frames have no main-session ID. Handle them before the display
        // ownership guard so a child asking for input cannot deadlock the process.
        if (nativeInput && event.type === 'control_cancel_request') {
          seenRequests.add(event.request_id)
          if (userInput?.event.request_id === event.request_id) {
            userInput = null
            finished = true
            ctx.setErrorText('Claude Code cancelled the pending question. Send a new message to continue.')
            ctx.stop()
          }
          return
        }
        if (nativeInput && event.type === 'control_request') {
          if (typeof event.request_id !== 'string' || !event.request_id || seenRequests.has(event.request_id)) return
          seenRequests.add(event.request_id)
          const request = event.request || {}
          if (request.subtype !== 'can_use_tool') {
            ctx.send({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id,
              error: `Unsupported Claude Code control request: ${request.subtype || 'unknown'}` } })
            return
          }
          if (event.parent_tool_use_id || request.agent_id || (event.session_id && !isMainSession(event.session_id))) {
            deny(event, 'This request cannot ask questions from a subagent. Return the question to the main agent.')
            return
          }
          if (request.tool_name !== 'AskUserQuestion') {
            deny(event, `Claude Code requested permission for ${request.tool_name || 'an unknown tool'}. This action was not approved; continue within the current permission mode.`)
            return
          }
          const questions = request.input?.questions
          if (event.request_id.length > 293 || !Array.isArray(questions) || !questions.length || questions.length > 4
            || questions.some(q => !q || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 10000
              || (q.header !== undefined && (typeof q.header !== 'string' || q.header.length > 300))
              || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')
              || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
              || q.options.some(o => !o || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 2000
                || typeof o.description !== 'string' || o.description.length > 4000))
            || new Set(questions.map(q => q.question)).size !== questions.length) {
            deny(event, 'Claude Code supplied an invalid question. Ask again using the required question format.')
            return
          }
          if (userInput) {
            deny(event, 'Another question is awaiting an answer. Wait for that answer before asking another question.')
            return
          }
          const key = `claude:${event.request_id}`
          userInput = { key, event }
          ctx.pump.push({ type: 'user_input', data: { key, questions: questions.map((q, index) => ({
            id: `question_${index}`, header: q.header || '', question: q.question,
            options: q.options.map(o => ({ label: o.label, description: o.description,
              ...(typeof o.preview === 'string' && o.preview.trim() ? { preview: o.preview.slice(0, 8000) } : {}) })),
            isOther: true, isSecret: false, multiple: q.multiSelect === true,
          })) } })
          void ctx.pump.finish?.()
          return
        }
        if (event.parent_tool_use_id) return
        if (!isMainSession(event.session_id)) return
        switch (event.type) {
          case 'system': {
            if (event.subtype === 'init' && typeof event.session_id === 'string') ctx.setSession(event.session_id)
            if (event.subtype === 'init' && typeof event.model === 'string') mainModel = event.model
            const ui = event.systemPayload?.uiEvent
            if (event.subtype === 'ui_telemetry' && ui?.['event.name'] === 'qwen-code.api_error') {
              ctx.setErrorText(providerErrorText(ui.error_message || ui.error_type || 'Qwen Code API error'))
            }
            break
          }
          case 'assistant': {
            const content = event.message?.content
            if (!Array.isArray(content)) break
            // Input + output of the main thread's (not a sub-agent's) last model call = current context size
            const u = event.message?.usage
            if (ctx.runtime === 'claude' && u && !event.parent_tool_use_id) {
              ctx.contextUsage.tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0)
            }
            if (event.is_api_error_message) {
              const message = content
                .filter(block => block?.type === 'text' && typeof block.text === 'string')
                .map(block => block.text)
                .join('\n')
              ctx.setErrorText(message || event.error || t('Claude Code API error'))
              break
            }
            for (const block of content) {
              if (block?.type === 'thinking' && block.thinking) {
                ctx.reasoningParts.push({ kind: 'reasoning', label: block.thinking })
                ctx.pump.push({ type: 'reasoning_delta', data: { text: block.thinking } })
              } else if (block?.type === 'text' && block.text) {
                // Narration between tool calls. The real answer arrives as the
                // `result` event, so this is timeline material — the same role
                // codex's intermediate agent_message plays.
                ctx.reasoningParts.push({ kind: 'reasoning', note: true, label: block.text })
                ctx.pump.push({ type: 'reasoning_delta', data: { text: block.text } })
              } else if (block?.type === 'tool_use' && block.name) {
                const label = labelFor(block.name, block.input || {})
                const rec = { kind: 'command', label, status: 'running', output: '' }
                ctx.reasoningParts.push(rec)
                if (block.id) toolById.set(block.id, rec)
                ctx.pump.push({ type: 'tool_event', data: { id: block.id, kind: 'command', label, status: 'running' } })
              }
            }
            break
          }
          case 'user': {
            const content = event.message?.content
            if (!Array.isArray(content)) break
            for (const block of content) {
              if (block?.type !== 'tool_result') continue
              const text = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content) ? block.content.map((c) => c?.text || '').join('\n') : ''
              const output = text.slice(0, 2000)
              const rec = block.tool_use_id ? toolById.get(block.tool_use_id) : undefined
              if (rec) { rec.status = 'done'; rec.output = output }
              ctx.pump.push({ type: 'tool_event', data: { id: block.tool_use_id, kind: 'command', label: rec?.label || 'tool', status: 'done', output } })
            }
            break
          }
          case 'result': {
            const followUp = nativeInput && finished
            if (nativeInput) {
              finished = true
              userInput = null
              ctx.endInput?.()
            }
            if (event.usage) {
              // claude counts cache hits separately in cache_*, leaving `input_tokens` with only the
              // misses (one turn over a 50k-character context reported 2). Sum them all, or Claude
              // runs look like they consume almost no input.
              const u = event.usage
              const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
              ctx.tokens.input = followUp ? ctx.tokens.input + input : input
              ctx.tokens.output = followUp ? ctx.tokens.output + (u.output_tokens || 0) : (u.output_tokens ?? ctx.tokens.output)
            }
            const usageByModel = event.modelUsage || {}
            const main = usageByModel[mainModel] || Object.values(usageByModel)
              .sort((a, b) => ((b?.cacheReadInputTokens || 0) + (b?.inputTokens || 0)) - ((a?.cacheReadInputTokens || 0) + (a?.inputTokens || 0)))[0]
            if (ctx.runtime === 'claude' && main?.contextWindow) ctx.contextUsage.window = main.contextWindow
            if (typeof event.session_id === 'string') ctx.setSession(event.session_id)
            // Since claude 2.1.220 a quota-type ending is subtype:"success" + is_error:true with the
            // text in `result`; checking only the subtype would store it as the answer in fullText,
            // which the error branch then discards, leaving the user with "no completed result".
            if (event.subtype === 'success' && !event.is_error && typeof event.result === 'string') {
              // The turn after a sub-agent finishes is appended to the previous text; the user keeps both
              const delta = followUp && answerText && event.result ? `\n\n${event.result}` : event.result
              answerText = followUp ? answerText + delta : delta
              ctx.setFullText(answerText)
              ctx.pump.push({ type: 'content_delta', data: { text: delta } })
            } else if (typeof event.result === 'string') {
              ctx.setErrorText(event.result)
            } else if (Array.isArray(event.errors) && event.errors.length) {
              // subtype:"error_during_execution" has no result; the reason is in errors[]
              // (CodeBuddy when not logged in: "Authentication required. Please use /login...").
              ctx.setErrorText(event.errors.map(String).join('\n'))
            }
            break
          }
        }
      },
      flush() { finished = true; userInput = null },
    }
  }

  //__MOVE_HERE__
  return claudeHandler
}
