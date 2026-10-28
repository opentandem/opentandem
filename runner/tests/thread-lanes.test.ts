// 0.87.0 thread lanes: the Runner machine runs the single file produced by /api/daemon-script, and the thread code is assembled from function source text,
// so leaving out one helper function only shows up as "is not defined" when that thread task actually runs. Two checks here:
// 1. Static check: every top-level Runner name used by a function listed in a lane must be in the list or in the preceding constants;
// 2. Real run after bundling: start the self-test (OPENTANDEM_LANE_SELFTEST) with the bundled single file and run each task type at least once,
//    with a skill, a Codex session and a Claude session set up in a temporary HOME so the parsing branches are really exercised.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildBundle } from './fixtures/runner-sources.mjs'

const source = fs.readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')

function functionText(name: string) {
  const match = new RegExp(`^(?:async\\s+)?function\\s+${name}\\(`, 'm').exec(source)
  if (!match) return null
  const next = source.slice(match.index + 1).search(/^(?:async\s+)?function\s|^const\s|^let\s|^\/\/ -{10}/m)
  return source.slice(match.index, next < 0 ? undefined : match.index + 1 + next)
}

function laneFunctions(laneSource: string) {
  const body = functionText(laneSource)!
  const list = body.slice(body.indexOf('threadLaneSource('))
  const array = list.slice(list.indexOf('['), list.indexOf('], `{'))
  return array.replace(/\/\/.*$/gm, '').split(/[\s,[\]]+/).filter(Boolean)
}

const topLevel = new Set([
  ...[...source.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
  ...[...source.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
])

describe('thread lane sources list every helper they use', () => {
  it.each([
    ['directoryLaneSource', ['PATH_LIST_MAX', 't']],
    // ADAPTERS on the scan thread is its own copy, built in the prelude from each adapter's ownFiles.
    ['scanLaneSource', ['SqliteDatabaseSync', 'ADAPTERS', 't', 'sessionImport', 'laneFilesState', 'HOME_SKILL_DIRS', 'PROJECT_SKILL_SUBDIRS', 'SESSION_IMPORT_PAGE_SIZE',
      'SESSION_IMPORT_FILE_LIMIT', 'SESSION_IMPORT_MESSAGE_LIMIT', 'SESSION_IMPORT_TEXT_LIMIT', 'importCandidateSources',
      'HTML_ASSET_RE', 'MAX_ARTIFACT_FILES', 'scanInstalledPluginEntries']],
  ])('%s', (lane, prelude) => {
    const listed = laneFunctions(lane)
    // scanSkills(workdirs = skillWorkdirs): the scan thread always passes workdirs, so the default never evaluates there.
    const allowed = new Set([...listed, ...prelude, 'skillWorkdirs'])
    const missing = new Set<string>()
    for (const name of listed) {
      // Functions imported from inlined modules are not top-level in this file; their own module provides them.
      const text = functionText(name)?.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      if (!text) continue
      for (const m of text.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\b/g)) {
        if (topLevel.has(m[1]) && !allowed.has(m[1]) && m[1] !== name) missing.add(`${name} → ${m[1]}`)
      }
    }
    expect([...missing]).toEqual([])
  })
})

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('bundled Runner runs every thread job', () => {
  it('lists, reads and looks up real fixtures without a missing helper', async () => {
    const bundleText = await buildBundle()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-lane-bundle-'))
    try {
      const bundle = path.join(root, 'machine-daemon.mjs')
      fs.writeFileSync(bundle, bundleText)
      const home = path.join(root, 'home')
      const workdir = path.join(root, 'project')
      write(path.join(workdir, 'page.html'), '<img src="pic.png"><link href="style.css">')
      write(path.join(workdir, 'pic.png'), 'png')
      write(path.join(workdir, 'style.css'), 'body{}')
      write(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nbody\n')
      write(path.join(workdir, '.claude', 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: Project skill\n---\nbody\n')
      const codexId = '019a0000-0000-7000-8000-000000000001'
      write(path.join(home, '.codex', 'sessions', '2026', '10', '25', `rollout-2026-10-25T00-00-00-${codexId}.jsonl`), [
        { type: 'session_meta', payload: { id: codexId, cwd: workdir } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi from codex' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      const claudeId = '11111111-2222-3333-4444-555555555555'
      write(path.join(home, '.claude', 'projects', workdir.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeId}.jsonl`), [
        { type: 'user', sessionId: claudeId, cwd: workdir, timestamp: '2026-10-25T00:00:00Z', message: { role: 'user', content: 'hello claude' } },
        { type: 'assistant', sessionId: claudeId, cwd: workdir, timestamp: '2026-10-25T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi from claude' }], usage: { input_tokens: 10, output_tokens: 5 } } },
        { type: 'ai-title', aiTitle: 'Fixture title' },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      const output = execFileSync(process.execPath, [bundle, '--server', 'http://127.0.0.1:9', '--id', 'lane-selftest', '--key', 'ot_selftest'], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '',
          SOPHON_MANAGED: '', OPENTANDEM_LANE_SELFTEST: '1', OPENTANDEM_LANE_SELFTEST_DIR: workdir },
        encoding: 'utf8', timeout: 60_000,
      })
      const report = JSON.parse(output.trim().split('\n').at(-1)!)
      const broken = report.results.filter((r: any) => /is not defined|is not a function|Cannot access|Unknown thread job/.test(r.result?.error || ''))
      expect(broken).toEqual([])
      const find = (type: string, runtime?: string) => report.results.filter((r: any) => r.type === type && (!runtime || r.runtime === runtime))
      expect(find('dirs')[0].result.current).toBe(workdir)
      expect(find('artifact_roots')[0].result.roots).toEqual([workdir])
      expect(find('artifact_abs')[0].result.abs).toBe(path.join(workdir, 'pic.png'))
      expect(find('skills')[0].result.skills.map((s: any) => s.name).sort()).toEqual(['demo', 'local'])
      expect(find('skill_body').map((r: any) => /^\[Using skill: \w+\][\s\S]*\nbody\n?$/.test(r.result.body || ''))).toEqual([true, true, false])
      const listed = find('task_sessions')[0].result
      expect(listed.counts).toMatchObject({ codex: 1, claude: 1 })
      const reads = find('read_task_session').map((r: any) => r.result)
      expect(reads.filter((r: any) => r.messages?.length).map((r: any) => r.runtime).sort()).toEqual(['claude', 'codex'])
      // Each adapter's file readers, run on the scan thread's own copy (ownFiles); a reader that
      // throws shows up as an error here.
      const files = (runtime: string, method: string) => find('adapter_files', runtime).filter((r: any) => r.method === method).map((r: any) => r.result)
      expect(find('adapter_files').filter((r: any) => r.result.error)).toEqual([])
      expect(files('codex', 'session.path').map((r: any) => r.value).filter(Boolean)).toHaveLength(1)
      expect(files('claude', 'session.exists').map((r: any) => r.value)).toEqual([false, true])
      expect(files('claude', 'contextTokens').map((r: any) => r.value)).toEqual([0, 15])
      expect(files('claude', 'nativeTitle').map((r: any) => r.value)).toEqual(['', 'Fixture title'])
      expect(new Set(find('adapter_files').map((r: any) => r.runtime))).toEqual(new Set(['codex', 'claude', 'opencode', 'hermes', 'gemini', 'kimi', 'antigravity', 'qwen', 'pi', 'copilot', 'kiro', 'codebuddy', 'cursor_agent', 'dsh', 'codefuse', 'cline', 'openclaw']))
      const artifacts = find('artifact_files')[0].result
      expect(artifacts.files.map((f: any) => [path.basename(f.abs), !!f.stat?.is_file])).toEqual([['pic.png', true], ['gone.txt', false]])
      expect(find('html_assets')[0].result.files.map((f: string) => path.basename(f)).sort()).toEqual(['page.html', 'pic.png', 'style.css'])
      expect(find('overlay_cleanup')[0].result).toMatchObject({ ok: true, persisted: true })
      // Hermes deletes its side session with its own command, on the main thread: the scan thread reports it unhandled.
      expect(find('purge_side_session').map((r: any) => [r.runtime, r.result.handled, r.result.tmp_removed])).toEqual([['pi', true, true], ['gemini', true, true], ['qwen', true, true], ['hermes', false, true]])
      expect(report.threads.scan.timeouts).toBe(0)
      expect(report.threads.directory.failures).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
