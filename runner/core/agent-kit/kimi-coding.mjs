// Kimi's OpenAI-compatible coding endpoint, shared by the agents that run on
// it (Trae Agent and CodeFuse use it directly; Cline lists the same model).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Default endpoint; a machine can point it elsewhere (another compatible service or a local bridge). */
export const KIMI_CODING_DEFAULT_URL = 'https://api.kimi.com/coding/v1'

export const KIMI_CODING_MODELS = [
  { slug: 'kimi-for-coding', display_name: 'Kimi for Coding', reasoning_levels: [] },
]

export function kimiBackedGroup(runtime, prefix) {
  return {
    runtime,
    models: KIMI_CODING_MODELS.map(model => ({ ...model, slug: `${prefix}/${model.slug}` })),
    default_model: `${prefix}/kimi-for-coding`,
    default_effort: null,
  }
}

/** Kimi coding API credential already configured for OpenCode on this machine.
 * It is injected only into the Trae Agent / CodeFuse child environment and is
 * never sent to the server or placed in argv. Cline keeps its own credential. */
export function kimiCodingApiKey() {
  if (process.env.KIMI_API_KEY) return process.env.KIMI_API_KEY
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
    const value = config?.provider?.kimi?.options?.apiKey
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

