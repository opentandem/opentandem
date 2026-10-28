// The Gemini API key and model list, shared by every agent that can run on a
// Gemini API key (Gemini CLI, Antigravity, Qwen Code and Pi).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Built-in fallback when no upstream model list has been probed yet.
const GEMINI_KEY_MODELS = [
  { slug: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', reasoning_levels: [] },
  { slug: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', reasoning_levels: [] },
  { slug: 'gemini-3.6-flash', display_name: 'Gemini 3.6 Flash', reasoning_levels: [] },
]

/** Resolve only Gemini's own credential from the local user profile. The key
 * never enters heartbeat payloads, server storage, argv, or another runtime. */
export function geminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  try {
    const source = fs.readFileSync(path.join(os.homedir(), '.gemini', '.env'), 'utf8')
    const match = source.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m)
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
  } catch {
    return ''
  }
}

export function createGeminiApi(ctx) {
  const { execFile, cachedModelProbe, systemHttpProxy, t } = ctx

  /** The probed upstream list with the agent's prefix on every slug; the
   *  built-in table when nothing has been probed. */
  function geminiBackedModels(prefix, fallbackDefault) {
    const upstream = cachedModelProbe('gemini_upstream')?.models
    if (!upstream?.length) {
      return {
        models: GEMINI_KEY_MODELS.map(m => ({ ...m, slug: `${prefix}/${m.slug}` })),
        default_model: `${prefix}/${fallbackDefault}`,
      }
    }
    const models = upstream.map(m => ({ ...m, slug: `${prefix}/${m.slug}` }))
    const preferred = `${prefix}/${fallbackDefault}`
    return { models, default_model: models.some(m => m.slug === preferred) ? preferred : models[0].slug }
  }

  /** Ask the upstream v1beta/models with the local GEMINI_API_KEY. curl rather
   *  than fetch: curl honours HTTPS_PROXY, which a system proxy setup needs. */
  async function probeGeminiUpstream() {
    const key = geminiApiKey()
    if (!key) return { ok: false, error: t('No GEMINI_API_KEY on this machine (~/.gemini/.env); gemini/qwen/pi cannot be probed') }
    const args = ['-sS', '--max-time', '20', '-H', `x-goog-api-key: ${key}`, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200']
    const proxy = await systemHttpProxy()
    if (proxy) args.push('-x', proxy)
    return new Promise((resolve) => {
      execFile('curl', args, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve({ ok: false, error: t('curl failed: {detail}', { detail: String(err.message || err).slice(0, 160) }) }); return }
        let data = null
        try { data = JSON.parse(String(stdout)) } catch { resolve({ ok: false, error: t('Upstream returned non-JSON') }); return }
        if (data?.error) { resolve({ ok: false, error: String(data.error.message || t('Upstream error')).slice(0, 200) }); return }
        const out = []
        for (const m of Array.isArray(data?.models) ? data.models : []) {
          const name = typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : ''
          if (!name || !name.includes('gemini')) continue
          const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
          if (methods.length && !methods.includes('generateContent')) continue
          out.push({
            slug: name,
            display_name: typeof m.displayName === 'string' && m.displayName ? m.displayName : name,
            description: t('Probed from the Gemini API (tiers available to the local key)'),
            reasoning_levels: [],
          })
        }
        resolve(out.length ? { ok: true, models: out } : { ok: false, error: t('Upstream returned no usable gemini models') })
      })
    })
  }

  return {
    geminiBackedModels,
    // Gemini CLI, Qwen Code and Pi share this one probe (key gemini_upstream).
    upstreamProbe: { key: 'gemini_upstream', label: 'Gemini API v1beta/models', run: () => probeGeminiUpstream() },
    keyEnv: (env) => {
      const apiKey = geminiApiKey()
      if (apiKey) env.GEMINI_API_KEY = apiKey
    },
  }
}
