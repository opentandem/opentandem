// Example app page: tokens over the last 7 days, split by agent, with a Top list of conversations. Read-only.
// The platform gives every conversation its own usage inside a time range; this page asks once per day and adds the
// numbers up, so there is no per-day or per-agent endpoint to maintain. Reads are limited to 120 per minute.
// Before uploading, copy the SDK next to this file:  cp -R ../../src ./opentandem
import { createClient } from './opentandem/client/index.js'

const DAYS = 7
const MAX_PAGES = 10 // 200 conversations per day is plenty for a demo
const TOP = 10
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', kimi: 'Kimi Code', qwen: 'Qwen Code', copilot: 'Copilot', pi: 'Pi', cursor_agent: 'Cursor Agent', dsh: 'DeepSeek Harness' }
const FIXED = { claude: '#d95926', codex: '#3987e5' } // the poster's colors; other agents take the next free one
const PALETTE = ['#a78bfa', '#f472b6', '#facc15']
const GROUPS = 4 // the four biggest agents get a color; everything else is "other"
const OTHER_COLOR = '#199e70'

const TEXT = {
  en: { headline: 'Usage, last 7 days', runs: 'Runs', sessions: 'Conversations', agents: 'Agents', output: 'Output tokens', top: 'Top conversations', project: 'Project', allProjects: 'All projects', noProject: 'No project', other: 'Other', loading: 'Loading day {i} of {n}…', empty: 'No conversations in the last 7 days.', cut: 'Some days have more than 200 active conversations; those are counted from the first 200.', runsOf: '{n} runs', units: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] },
  zh: { headline: '近 7 天消耗', runs: '运行轮次', sessions: '活跃对话', agents: '使用的 Agent', output: '输出 Token', top: '用量最高的对话', project: '项目', allProjects: '全部项目', noProject: '没有项目', other: '其他', loading: '正在读取第 {i}/{n} 天…', empty: '近 7 天没有对话。', cut: '有的日子活跃对话超过 200 个，只统计了前 200 个。', runsOf: '{n} 轮', units: [[1e8, '亿'], [1e4, '万']] },
}

const ot = createClient()
const $ = id => document.getElementById(id)
const { locale } = await ot.context
const t = TEXT[locale] || TEXT.en
document.documentElement.lang = locale
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t[el.dataset.t]
$('headline').textContent = t.headline
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

// Local midnights, oldest first; the last day runs up to now.
const days = Array.from({ length: DAYS }, (_, i) => {
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (DAYS - 1 - i))
  const to = new Date(from); to.setDate(to.getDate() + 1)
  return { from, to: i === DAYS - 1 ? new Date() : to }
})
$('range').textContent = `${new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(days[0].from)} — ${dayLabel(days.at(-1).from)}`
$('axisStart').textContent = dayLabel(days[0].from)
$('axisEnd').textContent = dayLabel(days.at(-1).from)

async function loadDay(day, project) {
  const rows = []
  let more = false
  for (let offset = 0, i = 0; i < MAX_PAGES; i++) {
    const page = await ot.sessions.list({ from: day.from.toISOString(), to: day.to.toISOString(), offset, ...(project ? { project } : {}) })
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
  const perDay = []
  let cut = false
  for (let i = 0; i < days.length; i++) {
    $('progress').textContent = t.loading.replace('{i}', i + 1).replace('{n}', days.length)
    const { rows, more } = await loadDay(days[i], project)
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
    bar.title = `${dayLabel(days[i].from)} · ${fmt(seg.reduce((a, b) => a + b, 0))}`
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

ot.projects.list().then(({ projects }) => {
  $('project').replaceChildren(new Option(t.allProjects, ''), ...projects.map(p => new Option(p.name, p.id)), new Option(t.noProject, 'none'))
  return render()
}).catch(show)
$('project').addEventListener('change', () => render().catch(show))
