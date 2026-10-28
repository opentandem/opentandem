// 0.68.0: Runner tool-summary reporting and local conversation store recording. The daemon is an 8000-line script
// that is not suitable for importing as a whole, so structural assertions are made on the source text to guard
// "no more full tool_events reporting / terminal states are all written to the local store / commands validate the id".
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareDaemonVersions } from '../core/daemon-semver.mjs'
import { adapterFiles } from './fixtures/runner-sources.mjs'
import { RUNNER_ROOT } from './fixtures/runner-sources.mjs'

const source = readFileSync(join(RUNNER_ROOT, 'core', 'machine-daemon.mjs'), 'utf-8')
// Each runtime's streaming-event translation lives in its adapter (runner/adapters/); the core plus the adapters are all of the Runner's source.
const runner = [source, ...adapterFiles().map(f => readFileSync(f, 'utf-8'))].join('\n')

/** Take the stretch of source after a given marker, used to assert "near a certain event". */
function around(marker: string, before = 0, after = 600) {
  const i = source.indexOf(marker)
  expect(i, marker).toBeGreaterThanOrEqual(0)
  return source.slice(Math.max(0, i - before), i + after)
}

describe('daemon tool summary reporting', () => {
  it('retains tool-summary support and documents the current Runner version', () => {
    const version = /^const DAEMON_VERSION = '(\d+\.\d+\.\d+)'/m.exec(source)?.[1]
    expect(version).toBeDefined()
    expect(compareDaemonVersions(version, '0.68.0')).toBeGreaterThanOrEqual(0)
    expect(source).toContain(`// ${version}:`)
    expect(source).toMatch(/^\/\/ 0\.67\.0:/m)
  })

  it('no longer reports tool_events to the server anywhere', () => {
    // Event data must no longer contain a tool_events key; the live event during a run is type:'tool_event' (singular, a different thing).
    expect(runner).not.toMatch(/\btool_events\s*:/)
    // Comments may mention it, but there must be no data usage such as `tool_events: ...` / `tool_events,` / `'tool_events'`
    expect(runner).not.toMatch(/['"]tool_events['"]|\btool_events\s*[,}]/)
  })

  it('terminal events carry tool_summary only when there is one', () => {
    for (const type of ['message_complete', 'run_cancelled']) {
      const chunk = around(`type: '${type}', data: {`, 0, 400)
      expect(chunk, type).toContain('...(toolSummary ? { tool_summary: toolSummary } : {})')
    }
    expect(source).toContain('const toolSummary = summarizeToolEvents(reasoningParts)')
  })

  it('keeps the live streaming events untouched', () => {
    expect(source).toContain("pump.push({ type: 'reasoning_delta'")
    expect(runner).toMatch(/pump\.push\(\{ type: 'tool_event'/)
  })
})

describe('daemon local conversation store wiring', () => {
  it('opens the store once at startup, before the main loop', () => {
    const open = source.indexOf('localStore = openLocalStore({ server: SERVER')
    expect(open).toBeGreaterThan(0)
    expect(open).toBeLessThan(source.indexOf('await stopDuplicateRunners()'))
    // Fallback for old Node: failures are only logged, and everything uses optional chaining / null checks
    expect(source).toContain('local conversation store unavailable')
    expect(source).not.toMatch(/from ['"]node:sqlite['"]\s*$/m)
  })

  it('records the start only when the server sent local_record, skipping side calls and compaction', () => {
    const start = source.indexOf('localStore.recordRunStart(')
    const compact = source.indexOf('if (run.compact) {')
    expect(start).toBeGreaterThan(compact) // the compaction run has already returned before this point
    expect(source).toContain('const localRecord = !side && localStore ? run.local_record : null')
    // before spawning the execution tool
    expect(start).toBeLessThan(source.indexOf('const { argv, stdinText, cwd, resultFile, keepStdinOpen }'))
  })

  it('records every terminal path exactly once', () => {
    expect(source).toContain('if (!localStarted || localRecorded || !localStore) return')
    expect(source).toContain("recordLocalEnd({ status: 'done'")
    expect(source).toContain("status: 'cancelled'")
    expect(source).toContain("replyText: fullText ? fullText + t('\\n\\n[Cancelled]') : ''")
    // error: spawn error, error before cancellation, non-zero exit, and the outer catch fallback
    expect(source.match(/recordLocalEnd\(\{ status: 'error'/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('never feeds the local store back into prompts or logs', () => {
    expect(source).not.toMatch(/getTaskTranscript/)
    expect(source).not.toMatch(/console\.\w+\([^)]*user_messages\[/)
  })

  it('handles delete_local_task with a strict id check', () => {
    const chunk = around("case 'delete_local_task': {", 0, 1000)
    expect(chunk).toContain('/^[A-Za-z0-9_-]{1,64}$/')
    expect(chunk).toContain("{ error: 'invalid task id' }")
    expect(chunk).toContain('localStore ? localStore.deleteTask(taskId) : 0')
    expect(chunk).toContain('payload = { ok: true, deleted }')
  })
})
