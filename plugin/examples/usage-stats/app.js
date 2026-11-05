// Example app page: tokens over a time range (7 days by default, up to one year), split by agent, with a Top list of
// conversations. Read-only.
// The platform gives every conversation its own usage inside a time range; this page splits the range into buckets
// (days, weeks or months, so every call stays far below the 90-day limit of one call), asks once per bucket and adds the
// numbers up, so there is no per-day or per-agent endpoint to maintain. Reads are limited to 120 per minute; when the
// limit is hit the page waits and goes on.
// Before uploading, copy the SDK next to this file:  cp -R ../../src ./opentandem
import { createClient } from './opentandem/client/index.js'

const DEFAULT_PRESET = '7d'
const MAX_SPAN_DAYS = 365 // one year
const MAX_PAGES = 100 // 2,000 conversations per bucket (a page is 20)
const TOP = 10
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', kimi: 'Kimi Code', qwen: 'Qwen Code', copilot: 'Copilot', pi: 'Pi', cursor_agent: 'Cursor Agent', dsh: 'DeepSeek Harness' }
const FIXED = { claude: '#d95926', codex: '#3987e5' } // the poster's colors; other agents take the next free one
const PALETTE = ['#a78bfa', '#f472b6', '#facc15']
const GROUPS = 4 // the four biggest agents get a color; everything else is "other"
const OTHER_COLOR = '#199e70'

const TEXT = {
  en: {
    headline: { '7d': 'Usage, last 7 days', '30d': 'Usage, last 30 days', thisMonth: 'Usage, this month', lastMonth: 'Usage, last month', custom: 'Usage, {range}' },
    presets: { '7d': 'Last 7 days', '30d': 'Last 30 days', thisMonth: 'This month', lastMonth: 'Last month', custom: 'Custom' },
    from: 'From', to: 'To', apply: 'Apply', maxSpan: 'At most 1 year (365 days)',
    errEmpty: 'Pick a start and an end date.', errOrder: 'The end date cannot be before the start date.', errSpan: 'The range is {n} days; the maximum is 365 days (1 year). Shorten it.',
    by: { day: 'Bars: one per day', week: 'Bars: one per week (starting Monday)', month: 'Bars: one per month' },
    runs: 'Runs', sessions: 'Conversations', agents: 'Agents', output: 'Output tokens', top: 'Top conversations', project: 'Project', allProjects: 'All projects', noProject: 'No project', other: 'Other',
    loading: 'Loading {i} of {n}…', waiting: 'Reached the read limit (120 per minute); continuing in {s}s…', empty: 'No conversations in this range.', cut: 'Some periods have more than 2,000 active conversations; those are counted from the first 2,000.', runsOf: '{n} runs', units: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] },
  zh: {
    headline: { '7d': '近 7 天消耗', '30d': '近 30 天消耗', thisMonth: '本月消耗', lastMonth: '上月消耗', custom: '{range} 消耗' },
    presets: { '7d': '近 7 天', '30d': '近 30 天', thisMonth: '本月', lastMonth: '上月', custom: '自定义' },
    from: '开始', to: '结束', apply: '应用', maxSpan: '最长 1 年（365 天）',
    errEmpty: '请选择开始和结束日期。', errOrder: '结束日期不能早于开始日期。', errSpan: '所选范围 {n} 天，最长 365 天（1 年），请缩短。',
    by: { day: '柱图：每天一根', week: '柱图：每周一根（周一起）', month: '柱图：每月一根' },
    runs: '运行轮次', sessions: '活跃对话', agents: '使用的 Agent', output: '输出 Token', top: '用量最高的对话', project: '项目', allProjects: '全部项目', noProject: '没有项目', other: '其他',
    loading: '正在读取第 {i}/{n} 段…', waiting: '已达读取上限（每分钟 120 次），{s} 秒后继续…', empty: '这段时间没有对话。', cut: '有的时段活跃对话超过 2000 个，只统计了前 2000 个。', runsOf: '{n} 轮', units: [[1e8, '亿'], [1e4, '万']] },
}

const ot = createClient()
const $ = id => document.getElementById(id)
const { locale } = await ot.context
const t = TEXT[locale] || TEXT.en
document.documentElement.lang = locale
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t[el.dataset.t]
$('project').setAttribute('aria-label', t.project)
const show = err => { $('error').textContent = err?.message || String(err) }

const fmt = n => new Intl.NumberFormat().format(n)
/** 234,650,000,000 → { n: '2,346.5', u: '亿' } in Chinese, { n: '234.65', u: 'B' } in English. */
function compact(v) {
  for (const [size, unit] of t.units) if (v >= size) return { n: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v / size), u: unit }
  return { n: fmt(v), u: '' }
}
const agentName = id => AGENT_NAMES[id] || id
const tokens = u => u.input_tokens + u.output_tokens
const dayLabel = d => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(d)
const fullDay = d => new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const monthLabel = d => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(d)

// ---- time range -------------------------------------------------------------------------------------------------
const midnight = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const spanDays = (a, b) => Math.round((b - a) / 86400000) + 1 // both days included
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parseDay = v => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d) }

/** First and last day (local midnights, both included) of a preset. */
function presetRange(preset) {
  const today = midnight()
  if (preset === '30d') return { start: addDays(today, -29), end: today }
  if (preset === 'thisMonth') return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today }
  if (preset === 'lastMonth') return { start: new Date(today.getFullYear(), today.getMonth() - 1, 1), end: new Date(today.getFullYear(), today.getMonth(), 0) }
  return { start: addDays(today, -6), end: today }
}

/** Days up to 31 → one bucket per day, up to ~6 months → per week (Monday first), longer → per month. */
function makeBuckets({ start, end }) {
  const n = spanDays(start, end), stop = addDays(end, 1), now = new Date()
  const unit = n <= 31 ? 'day' : n <= 183 ? 'week' : 'month'
  const out = []
  for (let from = start; from < stop;) {
    let next
    if (unit === 'day') next = addDays(from, 1)
    else if (unit === 'week') next = addDays(from, ((8 - from.getDay()) % 7) || 7)
    else next = new Date(from.getFullYear(), from.getMonth() + 1, 1)
    if (next > stop) next = stop
    const last = addDays(next, -1)
    out.push({ from, to: next > now ? now : next, label: unit === 'month' ? monthLabel(from) : dayLabel(from), title: unit === 'day' ? dayLabel(from) : unit === 'month' ? monthLabel(from) : `${dayLabel(from)} – ${dayLabel(last)}` })
    from = next
  }
  return { unit, buckets: out }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** One call; when the per-minute read limit is hit, wait (counting down on the page) and try again. */
async function listPage(args, mine) {
  for (let tries = 0; ; tries++) {
    try { return await ot.sessions.list(args) } catch (err) {
      if (err?.code !== 'rate_limited' || tries >= 5) throw err
      for (let left = 15; left > 0; left--) {
        if (mine !== generation) return null
        $('progress').textContent = t.waiting.replace('{s}', left)
        await sleep(1000)
      }
    }
  }
}

// Buckets that ended before today never change, so switching between ranges re-uses them (this page only; reload clears it).
const finished = new Map()
async function loadBucket(bucket, project, mine) {
  const key = `${project}|${bucket.from.getTime()}|${bucket.to.getTime()}`, settled = bucket.to <= midnight()
  if (settled && finished.has(key)) return finished.get(key)
  const result = await fetchBucket(bucket, project, mine)
  if (settled && mine === generation) finished.set(key, result)
  return result
}
async function fetchBucket(bucket, project, mine) {
  const rows = []
  let more = false
  for (let offset = 0, i = 0; i < MAX_PAGES; i++) {
    const page = await listPage({ from: bucket.from.toISOString(), to: bucket.to.toISOString(), offset, ...(project ? { project } : {}) }, mine)
    if (!page) return { rows, more }
    rows.push(...page.sessions)
    if (!page.has_more) break
    offset = page.next_offset
    more = i === MAX_PAGES - 1
  }
  return { rows, more }
}

let generation = 0
async function render() {
  const mine = ++generation
  const project = $('project').value
  const { unit, buckets } = makeBuckets(current.range)
  $('headline').textContent = t.headline[current.preset].replace('{range}', `${fullDay(current.range.start)} – ${fullDay(current.range.end)}`)
  $('range').textContent = `${fullDay(current.range.start)} — ${fullDay(current.range.end)}`
  $('axisStart').textContent = buckets[0].label
  $('axisEnd').textContent = buckets.at(-1).label
  $('by').textContent = t.by[unit]
  const perDay = []
  let cut = false
  for (let i = 0; i < buckets.length; i++) {
    $('progress').textContent = t.loading.replace('{i}', i + 1).replace('{n}', buckets.length)
    const { rows, more } = await loadBucket(buckets[i], project, mine)
    if (mine !== generation) return
    cut ||= more
    perDay.push(rows.filter(r => r.usage.runs > 0))
  }
  $('progress').textContent = ''

  // Totals per agent (whole range), per conversation (whole range) and per agent per day.
  const byAgent = new Map(), bySession = new Map()
  const sum = { runs: 0, input: 0, output: 0 }
  for (const rows of perDay) for (const s of rows) {
    const v = tokens(s.usage)
    byAgent.set(s.agent, (byAgent.get(s.agent) || 0) + v)
    const cur = bySession.get(s.id) || { ...s, total: 0, runs: 0 }
    cur.total += v; cur.runs += s.usage.runs
    bySession.set(s.id, cur)
    sum.runs += s.usage.runs; sum.input += s.usage.input_tokens; sum.output += s.usage.output_tokens
  }
  const total = sum.input + sum.output
  const ranked = [...byAgent.entries()].sort((a, b) => b[1] - a[1])
  const palette = [...PALETTE]
  const groups = ranked.slice(0, GROUPS).map(([a]) => ({ agent: a, name: agentName(a), color: FIXED[a] || palette.shift() || OTHER_COLOR, value: byAgent.get(a) }))
  const groupOf = agent => { const i = groups.findIndex(g => g.agent === agent); return i >= 0 ? i : GROUPS }
  const otherValue = ranked.slice(GROUPS).reduce((a, [, v]) => a + v, 0)
  if (ranked.length > GROUPS) groups.push({ agent: null, name: t.other, color: OTHER_COLOR, value: otherValue })

  const big = compact(total)
  $('bigNumber').textContent = total ? big.n : '0'
  $('bigUnit').textContent = big.u
  $('runs').textContent = fmt(sum.runs)
  $('sessions').textContent = fmt(bySession.size)
  $('agents').textContent = fmt(byAgent.size)
  $('output').textContent = compact(sum.output).n + compact(sum.output).u

  // Daily stacked bars, one segment per agent group.
  const dayTotals = perDay.map(rows => {
    const seg = groups.map(() => 0)
    for (const s of rows) seg[groupOf(s.agent)] += tokens(s.usage)
    return seg
  })
  const max = Math.max(1, ...dayTotals.map(seg => seg.reduce((a, b) => a + b, 0)))
  $('bars').replaceChildren(...dayTotals.map((seg, i) => {
    const bar = document.createElement('div')
    bar.className = 'bar'
    bar.title = `${buckets[i].title} · ${fmt(seg.reduce((a, b) => a + b, 0))}`
    for (let g = 0; g < seg.length; g++) {
      const part = document.createElement('i')
      part.style.height = `${(seg[g] / max) * 100}%`
      part.style.background = groups[g].color
      bar.append(part)
    }
    return bar
  }))
  $('legend').replaceChildren(...groups.map(g => {
    const el = document.createElement('span')
    el.innerHTML = '<i></i><span></span><b></b>'
    el.children[0].style.background = g.color
    el.children[1].textContent = g.name
    el.children[2].textContent = total ? `${((g.value / total) * 100).toFixed(1)}%` : '0%'
    return el
  }))

  // Top conversations of the whole range.
  const top = [...bySession.values()].sort((a, b) => b.total - a.total).slice(0, TOP)
  const topMax = Math.max(1, ...top.map(s => s.total))
  $('top').replaceChildren(...top.map((s, i) => {
    const li = document.createElement('li')
    li.innerHTML = '<span class="rk"></span><span class="ti"></span><span class="v"></span><span class="meta"><i></i><span></span></span><div class="track"><div></div></div>'
    li.children[0].textContent = i + 1
    li.children[1].textContent = s.title
    li.children[2].textContent = fmt(s.total)
    const color = groups[groupOf(s.agent)].color
    li.querySelector('.meta i').style.background = color
    li.querySelector('.meta span').textContent = [agentName(s.agent), s.project_name, t.runsOf.replace('{n}', s.runs)].filter(Boolean).join(' · ')
    li.querySelector('.track div').style.cssText = `width:${(s.total / topMax) * 100}%;background:${color}`
    return li
  }))
  $('note').textContent = !bySession.size ? t.empty : cut ? t.cut : ''
}

// ---- range picker -----------------------------------------------------------------------------------------------
const current = { preset: DEFAULT_PRESET, range: presetRange(DEFAULT_PRESET) }

$('presets').replaceChildren(...Object.keys(t.presets).map(key => {
  const b = document.createElement('button')
  b.type = 'button'; b.dataset.preset = key; b.textContent = t.presets[key]
  b.addEventListener('click', () => choose(key))
  return b
}))
const customBox = $('custom')
$('maxSpan').textContent = t.maxSpan
const today = isoDay(midnight())
for (const id of ['from', 'to']) { $(id).max = today; $(id + 'Label').textContent = t[id] }
$('apply').textContent = t.apply

function markPreset() {
  for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.preset === current.preset))
  customBox.hidden = current.preset !== 'custom'
}
function choose(preset) {
  current.preset = preset
  if (preset === 'custom') {
    $('from').value = isoDay(current.range.start); $('to').value = isoDay(current.range.end)
    markPreset(); checkCustom()
    return
  }
  current.range = presetRange(preset)
  markPreset(); $('rangeError').textContent = ''
  render().catch(show)
}
/** Validate the custom dates; returns the range, or null with the reason shown. */
function checkCustom() {
  const f = $('from').value, e = $('to').value
  let range = null, msg = ''
  if (!f || !e) msg = t.errEmpty
  else {
    const start = parseDay(f), end = parseDay(e)
    if (end < start) msg = t.errOrder
    else if (spanDays(start, end) > MAX_SPAN_DAYS) msg = t.errSpan.replace('{n}', spanDays(start, end))
    else range = { start, end }
  }
  $('rangeError').textContent = msg
  $('apply').disabled = !range
  return range
}
$('from').addEventListener('input', checkCustom)
$('to').addEventListener('input', checkCustom)
$('apply').addEventListener('click', () => {
  const range = checkCustom()
  if (!range) return
  current.range = range
  render().catch(show)
})

markPreset()
ot.projects.list().then(({ projects }) => {
  $('project').replaceChildren(new Option(t.allProjects, ''), ...projects.map(p => new Option(p.name, p.id)), new Option(t.noProject, 'none'))
  return render()
}).catch(show)
$('project').addEventListener('change', () => render().catch(show))
