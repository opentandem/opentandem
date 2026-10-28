// 0.87.0: the Runner main thread only launches and coordinates. Things that may be slow, such as reading user directories,
// scanning agent tool session databases and spawning system commands, are always done in thread lanes (directory / scan),
// the system process lane (systemExec) or fs.promises.
// This lists the functions that may still read or write synchronously on the main thread, each with the category it belongs to.
// This test fails if a synchronous call appears in a new function, or if an entry is no longer synchronous:
// either make it asynchronous / move it into a thread, or register it below with a reason.
// Functions that run inside threads (those listed in each lane's function list) are not covered here; they are meant to be synchronous.
// The create<Name>Files factories of the adapters (which read the agent tool's own session files) also run in the scan thread, so they are excluded too.
// Functions in an adapter live inside the create<Name>Adapter factory and are registered by their name at that level;
// code written directly in the factory counts as the factory itself.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as espree from 'espree'
import { RUNNER_ROOT, adapterFiles } from './fixtures/runner-sources.mjs'

const SYNC = /\b(?:\w+Fs|fs)\.(\w+Sync)\(|\b(execFileSync|spawnSync|rawExecFileSync)\(|new (SqliteDatabaseSync|DatabaseSync)\(/g

const reasons = {
  startup: '启动时只跑一次，Runner 还没开始服务',
  state: 'Runner 自己数据目录里的小文件（状态、日志、发件箱、执行记录、缓存、凭据）',
  agentConfig: '执行工具放在用户主目录里的小配置或凭据文件，探测或起任务前读一次',
  runSetup: '起执行工具前在系统临时目录里建、用完删的临时配置',
  resolve: '按 PATH 找命令，结果缓存 60 秒',
  install: '用户点「一键安装」后才跑，写 Runner 自己的安装目录',
  uninstall: '自删除流程，Runner 已停止服务',
  subprocess: 'MCP 与 opentandem 命令行子进程，不在 Runner 主进程里',
  laneBuilder: '拼线程源码；字符串里的同步调用在线程里执行',
  nativeDeps: '首次需要时下载原生依赖（点对点库、cloudflared），写 Runner 自己的目录',
  localStore: '本机对话库：node:sqlite 只有同步接口，库在 Runner 自己的数据目录',
  pluginScan: '插件目录扫描函数：在扫描线程里执行（pluginScanWorkerSource）',
  laneHelper: '由 Runner 交给扫描线程执行（ctx.persistOverlay → overlay_cleanup）；不传时（测试）才在调用处执行',
} as const

const allowed: Record<string, Record<string, keyof typeof reasons>> = {
  'runner/core/machine-daemon.mjs': {
    winShimTarget: 'resolve', winResolveCommand: 'resolve', commandOnPath: 'resolve', resolveRuntimeExecutable: 'resolve',
    inferRuntimeInstallInfo: 'resolve', addAgentDirsToPath: 'resolve',
    addInstalledAgentDirsToPath: 'resolve', npmInvocation: 'resolve', execFileSync: 'resolve',
    duplicateRunnerPids: 'startup', commandExists: 'startup', writeOtWrapper: 'startup', readSavedLoginPath: 'startup', localInstallId: 'startup',
    saveLoginPath: 'state', writeManagedStatus: 'state', reportLastFatal: 'state', readAgentUpdateReportQueue: 'state',
    writeAgentUpdateReportQueue: 'state', persistDeletionMarker: 'state', loadModelProbes: 'state', saveModelProbes: 'state',
    outboxPersist: 'state', flushOutbox: 'state', makeEventPump: 'state', saveExecution: 'state', clearCompletedExecution: 'state',
    prepareRecovery: 'state', restoreSessions: 'state', executeRun: 'state', maybeUpdateDaemon: 'state',
    clearArtifactSpool: 'state', uploadArtifacts: 'state',
    installMemoryShortfallMb: 'agentConfig',
    writeOpentandemHelp: 'runSetup', sideTitle: 'runSetup',
    prepareDaemonOssUpload: 'runSetup', fakeOpenDir: 'runSetup', ensureTuiProbeHelper: 'runSetup', probeTui: 'runSetup',
    performAgentInstall: 'install',
    scheduleMacCleanup: 'uninstall', scheduleLinuxCleanup: 'uninstall', scheduleWindowsCleanup: 'uninstall',
    mcpArtifactSpool: 'subprocess', scheduleTools: 'subprocess', artifactBlocked: 'subprocess',
    scanLaneSource: 'laneBuilder',
  },
  'runner/core/agent-kit/kit.mjs': { configOverlay: 'runSetup', persistOverlayState: 'laneHelper', mergedMcpJson: 'agentConfig' },
  'runner/adapters/claude/index.mjs': {
    ensureClaudeTokenEnv: 'state', readClaudeCred: 'agentConfig', claudeQuotaViaToken: 'agentConfig', ensureClaudeProbeTrusted: 'agentConfig',
    releaseChannel: 'resolve',
  },
  'runner/adapters/cline/index.mjs': { clineGroup: 'agentConfig', clineScheduleMcpConfig: 'agentConfig' },
  'runner/adapters/codebuddy/index.mjs': { codeBuddyAccountCache: 'agentConfig' },
  'runner/adapters/codefuse/index.mjs': { collectCodeFuse: 'agentConfig', winGitBash: 'resolve', codefuseWinShimDir: 'runSetup', codefuseHelpSetup: 'runSetup' },
  'runner/adapters/codex/index.mjs': { collectCodexQuota: 'agentConfig', writeCodexArtifactContext: 'state', acquireCodexChild: 'runSetup' },
  'runner/adapters/copilot/index.mjs': { copilotRuntimeSetup: 'runSetup' },
  'runner/adapters/cursor-agent/index.mjs': { cursorHelpSetup: 'runSetup' },
  'runner/adapters/dsh/index.mjs': { createDshAdapter: 'startup', collectDsh: 'agentConfig', dshConfiguredModel: 'agentConfig', dshScheduleMcpHome: 'agentConfig' },
  'runner/core/agent-kit/gemini-api.mjs': { geminiApiKey: 'agentConfig' },
  'runner/adapters/gemini/index.mjs': { geminiScheduleMcpHome: 'runSetup' },
  'runner/adapters/hermes/index.mjs': { createHermesAdapter: 'startup', hermesConfiguredModel: 'agentConfig' },
  'runner/core/agent-kit/kimi-coding.mjs': { kimiCodingApiKey: 'agentConfig' },
  'runner/adapters/kimi/index.mjs': { kimiGroup: 'agentConfig', kimiScheduleMcpHome: 'agentConfig' },
  'runner/adapters/kiro/index.mjs': { kiroScheduleMcpHome: 'runSetup' },
  'runner/adapters/mcode/index.mjs': { createMcodeAdapter: 'startup' },
  'runner/adapters/openclaw/index.mjs': { createOpenclawAdapter: 'startup', openclawConfiguredModel: 'agentConfig' },
  'runner/adapters/opencode/index.mjs': {
    collectOpencodeGoQuota: 'agentConfig', opencodeGroup: 'agentConfig', bundledOpenCodeAvailable: 'resolve', openCodeRuntimeSetup: 'runSetup',
    homebrewFormula: 'resolve',
  },
  'runner/adapters/pi/index.mjs': { piOwnModel: 'agentConfig' },
  'runner/adapters/qwen/index.mjs': { qwenOwnAuth: 'agentConfig' },
  'runner/adapters/trae-agent/index.mjs': { traeAgentScheduleMcpConfig: 'runSetup', traeAgentHandler: 'runSetup' },
  'runner/core/runner-p2p.mjs': { p2pLoadNative: 'nativeDeps' },
  'runner/core/local-preview-runner.mjs': { prepareCloudflared: 'nativeDeps', defaultLaunchNamedTunnel: 'runSetup' },
  'runner/core/runner-local-store.mjs': { localSafeChmod: 'localStore', localBackup: 'localStore', localFileId: 'localStore', openLocalStore: 'localStore' },
  'runner/core/codex-plugin-skills.mjs': {
    pluginReadJson: 'pluginScan', pluginDirectories: 'pluginScan', pluginEnabledOverrides: 'pluginScan', pluginScanCodexEntries: 'pluginScan',
    pluginReadConfig: 'pluginScan', pluginInside: 'pluginScan', pluginInstructionEntries: 'pluginScan', pluginScanOpenCode: 'pluginScan',
    pluginEntryPrompt: 'pluginScan',
  },
}

const daemon = fs.readFileSync(new URL('../core/machine-daemon.mjs', import.meta.url), 'utf8')

/** Functions listed in a thread lane's source: they run on that thread. */
function laneFunctions() {
  const names = new Set<string>()
  for (const lane of ['directoryLaneSource', 'scanLaneSource']) {
    const at = daemon.indexOf(`function ${lane}(`)
    const list = daemon.slice(daemon.indexOf('threadLaneSource(', at), daemon.indexOf('], `{', at))
    for (const name of list.slice(list.indexOf('[')).replace(/\/\/.*$/gm, '').split(/[\s,[\]]+/)) if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
  }
  return names
}

/** Top-level functions of a file and the synchronous calls in each (comments stripped). */
function syncCallers(text: string) {
  const lines = text.split('\n')
  const found = new Map<string, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?(?:async\s+)?function\*?\s+([\w$]+)\(/.exec(lines[i])
    if (!m) continue
    let j = i
    const opens = (lines[i].match(/{/g) || []).length
    const oneLine = /}\s*$/.test(lines[i]) && opens > 0 && opens === (lines[i].match(/}/g) || []).length
    if (!oneLine) { j = i + 1; while (j < lines.length && !/^}/.test(lines[j])) j++ }
    const body = lines.slice(i, j + 1).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    const calls = [...new Set([...body.matchAll(SYNC)].map(x => x[1] || x[2] || x[3]))]
    if (calls.length) found.set(m[1], calls)
    i = j
  }
  return found
}

type Node = { type: string; [key: string]: any }

/** An adapter module: the synchronous calls by function directly inside its create<Name>Adapter
 *  factory (or the factory itself). create<Name>Files factories run on the scan thread and are skipped. */
function adapterSyncCallers(text: string) {
  const found = new Map<string, Set<string>>()
  const add = (chain: string[], call: string) => {
    const top = chain[0] || '(module)'
    if (/^create\w+Files$/.test(top)) return
    const owner = /^create\w+$/.test(top) ? chain[1] || top : top
    if (!found.has(owner)) found.set(owner, new Set())
    found.get(owner)!.add(call)
  }
  const walk = (node: any, chain: string[]) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child, chain); return }
    let next = chain
    if (node.type === 'FunctionDeclaration' && node.id) next = [...chain, node.id.name]
    else if (node.type === 'VariableDeclarator' && /Function/.test(node.init?.type || '')) next = [...chain, node.id.name]
    else if (node.type === 'Property' && /Function/.test(node.value?.type || '') && node.key?.type === 'Identifier') next = [...chain, node.key.name]
    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && /Sync$/.test(callee.property.name)) add(chain, callee.property.name)
      if (callee.type === 'Identifier' && /^(execFileSync|spawnSync)$/.test(callee.name)) add(chain, callee.name)
    }
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && /DatabaseSync$/.test(node.callee.name)) add(chain, node.callee.name)
    for (const [key, value] of Object.entries(node)) if (key !== 'loc' && value && typeof value === 'object') walk(value, next)
  }
  walk(espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node, [])
  return new Map([...found].map(([name, calls]) => [name, [...calls]]))
}

// Agent-side modules (adapters and the helpers they share) put their sync calls inside factories.
const isAgentModule = (file: string) => file.startsWith('runner/adapters/') || file.startsWith('runner/core/agent-kit/')
const callersOf = (file: string) => {
  // Keys are labelled from the repository root (runner/...); read them relative to runner/.
  const text = file === 'runner/core/machine-daemon.mjs' ? daemon : fs.readFileSync(path.join(RUNNER_ROOT, file.replace(/^runner\//, '')), 'utf8')
  return isAgentModule(file) ? adapterSyncCallers(text) : syncCallers(text)
}

describe('Runner main thread keeps synchronous I/O to the listed places', () => {
  const lanes = laneFunctions()
  it.each(Object.keys(allowed))('%s', file => {
    const callers = callersOf(file)
    const unlisted = [...callers].filter(([name]) => !(file === 'runner/core/machine-daemon.mjs' && lanes.has(name)) && !allowed[file][name])
      .map(([name, calls]) => `${name}: ${calls.join(', ')}`)
    // Move these onto a thread lane, systemExec or fs.promises; register only what fits one of the reasons above.
    expect(unlisted).toEqual([])
    const stale = Object.keys(allowed[file]).filter(name => !callers.has(name))
    expect(stale).toEqual([])
  })

  it('every Runner module with synchronous I/O is covered', () => {
    // Every module the core imports, plus every adapter and shared agent module.
    const modules = [...daemon.matchAll(/^import [^\n]* from '\.\/([^']+\.mjs)'/gm)].map(m => `runner/core/${m[1]}`)
    const adapters = adapterFiles().map(file => `runner/${path.relative(RUNNER_ROOT, file)}`)
    expect(modules.length).toBeGreaterThanOrEqual(10)
    expect(adapters.length).toBeGreaterThanOrEqual(25)
    const uncovered = [...new Set([...modules, ...adapters])].filter(file => !allowed[file] && callersOf(file).size)
    expect(uncovered).toEqual([])
  })
})
