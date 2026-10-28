// Tool call summary: at the end of each turn the Runner only reports which tools were used and how many times each;
// the server and the web page also only store and show this.
// This is the only implementation of the summary, shared by the Runner and the server: do not write
// another copy of the counting or validation elsewhere.
//
// Note: this file is bundled into the single-file Runner (runner/build/bundle.mjs): put imports only
// at the top of the file and import only
// relative-path modules or node: built-ins; use only export function / export const for exports. Each
// module has its own scope,
// so top-level names no longer collide with machine-daemon.
// The server and the web page also import this file directly, so keep it free of dependencies.

export const TOOL_SUMMARY_VERSION = 1
export const TOOL_SUMMARY_MAX_TOOLS = 20
export const TOOL_SUMMARY_NAME_MAX = 48
// When there are more than 20 kinds of tools, the extras are merged into this entry (always sorted last).
export const TOOL_SUMMARY_OTHER = '__other__'

// Upper limit for a single count and for the total: it guards against abnormal payloads and is not a business limit.
const COUNT_MAX = 100000
// The serialized form must be smaller than this: list queries (LIST_COLS) inline up to 2048 bytes, so leave some margin.
const JSON_BYTE_LIMIT = 2000
// Reject over-long strings before parsing, so we do not waste JSON.parse on dirty data.
const PARSE_TEXT_MAX = 500000

// Narration (progress or interim results the model writes to the user between tool calls) is stored in
// the same message as the summary.
// The limit only guards against abnormal length; when exceeded, the newest entries are kept and the
// older ones are dropped.
export const NOTES_MAX_COUNT = 100
export const NOTE_TEXT_MAX = 6000
export const NOTES_TOTAL_MAX = 60000
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length
}

/**
 * Extract the tool name from the label of a command event. Labels differ between agents:
 * Claude/Qwen use `Bash(ls)`, `Read(/a/b)`, `mcp__srv__tool(args)`; OpenCode uses `bash(...)`, `edit(...)`;
 * Codex's label is the full shell command (`/bin/zsh -lc '...'`); the others use a tool name or a name with arguments.
 * A full command can neither be aggregated nor be trusted not to contain paths and secrets,
 * so anything that does not look like a tool name is recorded as `shell`.
 */
export function toolNameFromLabel(label) {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return 'shell'
  // MCP tools: keep only the tool name. The server name is not part of the summary (the same tool on
  // different servers counts as the same usage).
  const mcp = /^mcp__[\w.-]+?__([\w.-]+)/.exec(text)
  if (mcp) return clip(mcp[1])
  // A path, a relative command, a home directory, a Windows backslash, or a drive-letter prefix: this is
  // a full shell command, not a tool name.
  if (/^[/.~\\]/.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return 'shell'
  const ident = /^[A-Za-z_][\w.-]*/.exec(text)
  if (!ident) return 'shell'
  return clip(ident[0])
}

function clip(name) {
  return name.length > TOOL_SUMMARY_NAME_MAX ? name.slice(0, TOOL_SUMMARY_NAME_MAX) : name
}

// Sort by count descending, and by name ascending for equal counts (compared by code point, independent of locale).
function byCountThenName(a, b) {
  if (b[1] !== a[1]) return b[1] - a[1]
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

/**
 * Aggregate the tool_events of one turn into a summary. Commands are only counted, and the full
 * command text is not stored;
 * reasoning with note:true is narration and is kept verbatim in order of appearance, with after = the
 * number of commands executed before it.
 * Return null when there are no commands and no narration (the caller does not report in that case).
 * Dirty input is tolerated and never throws.
 */
export function summarizeToolEvents(events) {
  if (!Array.isArray(events)) return null
  const counts = new Map()
  let otherCount = 0
  let total = 0
  const notes = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.kind === 'reasoning') {
      if (ev.note === true && typeof ev.label === 'string' && ev.label.trim()) notes.push({ after: total, text: ev.label })
      continue
    }
    if (ev.kind !== 'command') continue
    const name = toolNameFromLabel(ev.label)
    total += 1
    // If a tool is really named __other__, merge it into the overflow bucket to avoid a name clash with the aggregate entry.
    if (name === TOOL_SUMMARY_OTHER) { otherCount += 1; continue }
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  const kept = normalizeNotes(notes)
  if (total === 0 && kept.length === 0) return null
  const named = [...counts.entries()].sort(byCountThenName)
  let tools = named
  if (named.length + (otherCount > 0 ? 1 : 0) > TOOL_SUMMARY_MAX_TOOLS) {
    tools = named.slice(0, TOOL_SUMMARY_MAX_TOOLS - 1)
    for (const [, n] of named.slice(TOOL_SUMMARY_MAX_TOOLS - 1)) otherCount += n
  }
  if (otherCount > 0) tools = [...tools, [TOOL_SUMMARY_OTHER, otherCount]]
  return { v: TOOL_SUMMARY_VERSION, total, tools, ...(kept.length ? { notes: kept } : {}) }
}

// Validate and truncate the narration: bad entries are skipped (a narration problem must not break the whole summary);
// when over the limit, keep the newest.
function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return []
  const items = []
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue
    if (!Number.isInteger(n.after) || n.after < 0 || n.after > COUNT_MAX) continue
    if (typeof n.text !== 'string' || !n.text.trim()) continue
    const text = n.text.length > NOTE_TEXT_MAX ? n.text.slice(0, NOTE_TEXT_MAX) + '…' : n.text
    items.push({ after: n.after, text })
  }
  const kept = []
  let chars = 0
  for (let i = items.length - 1; i >= 0 && kept.length < NOTES_MAX_COUNT; i--) {
    chars += items[i].text.length
    if (chars > NOTES_TOTAL_MAX && kept.length > 0) break
    kept.push(items[i])
  }
  return kept.reverse()
}

function isCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= COUNT_MAX
}

/**
 * Strictly validate and normalize a summary. The input can be a JSON string, an object, or any value;
 * only if the structure is fully valid is a new object with just v/total/tools/notes returned (extra
 * fields are dropped), otherwise null.
 * notes is optional, and bad entries are skipped without affecting whether the summary itself is valid.
 * The server uses it to reject dirty data in the Runner's payload, and the web page uses it to read
 * values from the database.
 */
export function parseToolSummary(value) {
  let obj = value
  if (typeof value === 'string') {
    if (value.length > PARSE_TEXT_MAX) return null
    try { obj = JSON.parse(value) } catch { return null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.v !== TOOL_SUMMARY_VERSION) return null
  const notes = normalizeNotes(obj.notes)
  // A message with narration but no commands: total is 0 and tools is empty; this is only valid when narration is present.
  const noCommands = notes.length > 0 && obj.total === 0 && Array.isArray(obj.tools) && obj.tools.length === 0
  if (!noCommands && !isCount(obj.total)) return null
  const raw = obj.tools
  if (!Array.isArray(raw) || (!noCommands && raw.length < 1) || raw.length > TOOL_SUMMARY_MAX_TOOLS) return null
  const seen = new Set()
  const tools = []
  let sum = 0
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!Array.isArray(item) || item.length !== 2) return null
    const [name, count] = item
    if (typeof name !== 'string' || name.length < 1 || name.length > TOOL_SUMMARY_NAME_MAX) return null
    if (CONTROL_CHARS.test(name)) return null
    if (!isCount(count)) return null
    if (seen.has(name)) return null
    // The aggregate entry may only be last; if it is not last, reject it even when it is not in seen.
    if (name === TOOL_SUMMARY_OTHER && i !== raw.length - 1) return null
    seen.add(name)
    sum += count
    tools.push([name, count])
  }
  if (sum !== obj.total) return null
  return { v: TOOL_SUMMARY_VERSION, total: obj.total, tools, ...(notes.length ? { notes } : {}) }
}

/**
 * Whether the string is valid summary JSON. The old tool_events format is an array JSON, which gives false,
 * and the web page uses this to tell old from new.
 */
export function isToolSummaryJson(text) {
  return typeof text === 'string' && parseToolSummary(text) !== null
}

// Truncate all names to cap characters; counts of names that collide after truncation are merged, and
// the aggregate entry stays last.
function capNames(tools, cap) {
  const merged = new Map()
  let other = 0
  for (const [name, count] of tools) {
    if (name === TOOL_SUMMARY_OTHER) { other += count; continue }
    const key = name.slice(0, cap)
    merged.set(key, (merged.get(key) || 0) + count)
  }
  const out = [...merged.entries()].sort(byCountThenName)
  if (other > 0) out.push([TOOL_SUMMARY_OTHER, other])
  return out
}

/**
 * Serialize to compact JSON. The summary body (without narration) is guaranteed to be under 2000 UTF-8 bytes;
 * it can only exceed that when names contain multi-byte characters, in which case names are shortened step by step
 * (colliding names are merged, total is unchanged) until it fits.
 * Narration is attached separately in notes, and its total size is limited by normalizeNotes; list
 * queries strip it before
 * sending when the whole thing exceeds 2048 bytes.
 * Returns null when the input is not a valid summary.
 */
export function stringifyToolSummary(summary) {
  const s = parseToolSummary(summary)
  if (!s) return null
  let base = { v: s.v, total: s.total, tools: s.tools }
  let text = JSON.stringify(base)
  for (let cap = TOOL_SUMMARY_NAME_MAX; utf8Bytes(text) >= JSON_BYTE_LIMIT && cap > 1; cap--) {
    base = { v: s.v, total: s.total, tools: capNames(s.tools, cap) }
    text = JSON.stringify(base)
  }
  if (!s.notes) return text
  // A lone surrogate makes MySQL JSON functions fail, so replace it with U+FFFD before writing to the database.
  const notes = s.notes.map(n => ({ after: n.after, text: n.text.replace(LONE_SURROGATE, '\ufffd') }))
  return JSON.stringify({ ...base, notes })
}
