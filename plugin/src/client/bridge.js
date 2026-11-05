// The message channel between an app page and the OpenTandem console that hosts it.
// The page runs in a sandboxed iframe with no OpenTandem cookies; every capability call goes to
// the parent window, which checks who is signed in, asks for confirmation on writes, and answers.
//
//   page → console  { opentandem: 1, type: 'ready' }
//   page → console  { opentandem: 1, type: 'call', id, capability, params }
//   console → page  { opentandem: 1, type: 'context', locale, app: { id, name } }
//   console → page  { opentandem: 1, type: 'result', id, ok, data } | { ..., ok: false, error, message? }

const READ_TIMEOUT_MS = 30_000
// Writes wait for the member to click Allow or Deny.
const WRITE_TIMEOUT_MS = 10 * 60_000

export class OpenTandemError extends Error {
  /** @param {string} code @param {string} [message] */
  constructor(code, message) {
    super(message || code)
    this.name = 'OpenTandemError'
    this.code = code
  }
}

let seq = 0
const nextId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`

export function createBridge({ target = window.parent, self = window } = {}) {
  /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map()
  /** @type {(ctx: { locale: string, app: { id: string, name: string } }) => void} */
  let resolveContext = () => {}
  const context = new Promise(resolve => { resolveContext = resolve })

  self.addEventListener('message', event => {
    // Only the hosting console may answer.
    if (event.source !== target) return
    const msg = event.data
    if (!msg || msg.opentandem !== 1) return
    if (msg.type === 'context') { resolveContext({ locale: msg.locale, app: msg.app }); return }
    if (msg.type !== 'result' || typeof msg.id !== 'string') return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(new OpenTandemError(msg.error || 'unknown_error', msg.message))
  })

  const post = msg => target.postMessage({ opentandem: 1, ...msg }, '*')
  post({ type: 'ready' })

  /**
   * @param {string} capability
   * @param {Record<string, unknown>} [params]
   * @param {{ write?: boolean }} [opts]
   */
  function call(capability, params = {}, opts = {}) {
    const id = nextId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new OpenTandemError('timeout'))
      }, opts.write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      post({ type: 'call', id, capability, params })
    })
  }

  return { call, context }
}
