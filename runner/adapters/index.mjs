// Registry of agent adapters. Each adapter module exports one factory that
// receives the Runner context and returns the adapter for one agent CLI; see
// docs/runner-adapters.md for the adapter contract. Order matters: it is the
// order agents are probed and reported in.
import { createCodexAdapter } from './codex/index.mjs'
import { createClaudeAdapter } from './claude/index.mjs'
import { createOpencodeAdapter } from './opencode/index.mjs'
import { createGeminiAdapter } from './gemini/index.mjs'
import { createKimiAdapter } from './kimi/index.mjs'
import { createAntigravityAdapter } from './antigravity/index.mjs'
import { createQwenAdapter } from './qwen/index.mjs'
import { createPiAdapter } from './pi/index.mjs'
import { createDshAdapter } from './dsh/index.mjs'
import { createCopilotAdapter } from './copilot/index.mjs'
import { createKiroAdapter } from './kiro/index.mjs'
import { createCodeBuddyAdapter } from './codebuddy/index.mjs'
import { createTraeAgentAdapter } from './trae-agent/index.mjs'
import { createCodeFuseAdapter } from './codefuse/index.mjs'
import { createClineAdapter } from './cline/index.mjs'
import { createCursorAgentAdapter } from './cursor-agent/index.mjs'
import { createHermesAdapter } from './hermes/index.mjs'
import { createOpenclawAdapter } from './openclaw/index.mjs'
import { createTraeCodeAdapter } from './traecode/index.mjs'
import { createQoderAdapter } from './qoder/index.mjs'
import { createMimoAdapter } from './mimo/index.mjs'
import { createCodeArtsAdapter } from './codearts/index.mjs'
import { createMcodeAdapter } from './mcode/index.mjs'
import { createComateAdapter } from './comate/index.mjs'
import { createMetaCodeAdapter } from './metacode/index.mjs'

const FACTORIES = [
  // Agents the Runner can execute.
  createCodexAdapter, createClaudeAdapter, createOpencodeAdapter, createGeminiAdapter, createKimiAdapter,
  createAntigravityAdapter, createQwenAdapter, createPiAdapter, createDshAdapter, createCopilotAdapter,
  createKiroAdapter, createCodeBuddyAdapter, createTraeAgentAdapter, createCodeFuseAdapter, createClineAdapter,
  createCursorAgentAdapter, createHermesAdapter, createOpenclawAdapter,
  // Agents that are only detected and reported (executes: false).
  createTraeCodeAdapter, createQoderAdapter, createMimoAdapter, createCodeArtsAdapter,
  createMcodeAdapter, createComateAdapter, createMetaCodeAdapter,
]

export function createAdapters(ctx) {
  // No prototype: a runtime id coming from the server must never resolve to an Object method.
  const adapters = Object.create(null)
  for (const create of FACTORIES) {
    const adapter = create(ctx)
    adapters[adapter.id] = adapter
  }
  return adapters
}
