// When Claude Code moves a timed-out command to the background it tells the model "You will be notified when it completes".
// That is not true in headless -p mode (once the model replies, the background command is killed a few seconds later).
// The PostToolUse hook registered by the Runner recognizes tool_response.backgroundTaskId and appends a correction
// after the same tool result.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { adapterPath } from './fixtures/runner-sources.mjs'

const DAEMON = path.join(__dirname, '..', 'core', 'machine-daemon.mjs')
const CLAUDE_ADAPTER = adapterPath('claude')
const hook = (input: string) =>
  spawnSync(process.execPath, [DAEMON, 'claude-hook'], { input, encoding: 'utf8', timeout: 10_000 })

describe('Claude Code background-command correction hook', () => {
  it('appends a correction when a command is moved to the background, and names schedule_create', () => {
    const r = hook(JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: '', backgroundTaskId: 'b1', timedOutAfterMs: 2000 } }))
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout).hookSpecificOutput
    expect(out.hookEventName).toBe('PostToolUse')
    expect(out.additionalContext).toContain('you will not be notified')
    expect(out.additionalContext).toContain('schedule_create')
  })

  it('ordinary commands and malformed input produce no output and no error', () => {
    for (const input of [JSON.stringify({ tool_response: { stdout: 'hi' } }), 'not json', '']) {
      const r = hook(input)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })

  it('claudeArgs registers this hook via --settings, attached to Bash only', () => {
    const src = readFileSync(CLAUDE_ADAPTER, 'utf8')
    const fn = src.slice(src.indexOf('function claudeArgs('), src.indexOf('function claudeArgs(') + 3000)
    expect(fn).toContain("argv.push('--settings'")
    expect(fn).toContain("matcher: 'Bash'")
    expect(fn).toContain('claude-hook')
  })
})
