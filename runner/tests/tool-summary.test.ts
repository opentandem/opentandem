import { describe, expect, it } from 'vitest'
import {
  TOOL_SUMMARY_MAX_TOOLS, TOOL_SUMMARY_NAME_MAX, TOOL_SUMMARY_OTHER, TOOL_SUMMARY_VERSION,
  isToolSummaryJson, parseToolSummary, stringifyToolSummary, summarizeToolEvents, toolNameFromLabel,
} from '../core/tool-summary.mjs'

const cmd = (label: unknown) => ({ kind: 'command', label })
const sumCounts = (s: { tools: unknown[][] }) => s.tools.reduce((n: number, t) => n + Number(t[1]), 0)

describe('toolNameFromLabel: real label shapes from each runtime', () => {
  it('Claude / Qwen: toolName or toolName(args)', () => {
    expect(toolNameFromLabel('Bash')).toBe('Bash')
    expect(toolNameFromLabel('Bash(ls -la /tmp)')).toBe('Bash')
    expect(toolNameFromLabel('Read(/Users/a/b.ts)')).toBe('Read')
    expect(toolNameFromLabel('Grep(foo.*bar…)')).toBe('Grep')
    expect(toolNameFromLabel('WebFetch(https://x.com)')).toBe('WebFetch')
  })
  it('OpenCode: lowercase tool name', () => {
    expect(toolNameFromLabel('bash(git status)')).toBe('bash')
    expect(toolNameFromLabel('edit(/a/b.ts)')).toBe('edit')
    expect(toolNameFromLabel('todowrite')).toBe('todowrite')
  })
  it('MCP: only the tool name is taken, the server does not enter the summary', () => {
    expect(toolNameFromLabel('mcp__opentandem__schedule_create(at=1)')).toBe('schedule_create')
    expect(toolNameFromLabel('mcp__mcp-chrome__chrome_navigate')).toBe('chrome_navigate')
    expect(toolNameFromLabel('mcp__my_server__do_it(x)')).toBe('do_it')
    expect(toolNameFromLabel('mcp__srv__a__b(x)')).toBe('a__b')
    expect(toolNameFromLabel('mcp__a.b__t')).toBe('t')
  })
  it('an incomplete MCP prefix is treated as a plain identifier', () => {
    expect(toolNameFromLabel('mcp__onlyserver')).toBe('mcp__onlyserver')
    expect(toolNameFromLabel('mcp__')).toBe('mcp__')
  })
  it('Codex: a full shell command is always recorded as shell', () => {
    expect(toolNameFromLabel("/bin/zsh -lc 'ls -la'")).toBe('shell')
    expect(toolNameFromLabel('/usr/bin/bash -lc "cat a"')).toBe('shell')
    expect(toolNameFromLabel('./run.sh --x')).toBe('shell')
    expect(toolNameFromLabel('../bin/tool')).toBe('shell')
    expect(toolNameFromLabel('.hidden')).toBe('shell')
    expect(toolNameFromLabel('~/bin/x')).toBe('shell')
    expect(toolNameFromLabel('\\\\server\\share\\x.exe')).toBe('shell')
    expect(toolNameFromLabel('C:\\Windows\\System32\\cmd.exe /c dir')).toBe('shell')
    expect(toolNameFromLabel('d:/tools/x.exe')).toBe('shell')
  })
  it('leading and trailing whitespace is trimmed', () => {
    expect(toolNameFromLabel('  Bash(ls)\n')).toBe('Bash')
    expect(toolNameFromLabel('\t/bin/sh -c x')).toBe('shell')
  })
  it('empty, non-string, no identifier -> shell', () => {
    for (const bad of ['', '   ', '\n', null, undefined, 42, {}, [], true, '123abc', '(x)', '"quoted"', '中文工具', '-rf']) {
      expect(toolNameFromLabel(bad as never)).toBe('shell')
    }
  })
  it('identifiers allow . and -, and stop at parentheses, spaces or colons', () => {
    expect(toolNameFromLabel('web.search(q)')).toBe('web.search')
    expect(toolNameFromLabel('read-file x')).toBe('read-file')
    expect(toolNameFromLabel('Running: ls')).toBe('Running')
    expect(toolNameFromLabel('_private(x)')).toBe('_private')
  })
  it('an overlong name is cut to 48 characters', () => {
    const long = 'T'.repeat(100)
    expect(toolNameFromLabel(long)).toBe('T'.repeat(TOOL_SUMMARY_NAME_MAX))
    expect(toolNameFromLabel(`mcp__s__${long}(x)`)).toBe('T'.repeat(TOOL_SUMMARY_NAME_MAX))
    expect(toolNameFromLabel('T'.repeat(48))).toHaveLength(48)
  })
})

describe('summarizeToolEvents', () => {
  it('non-array / empty array / only reasoning -> null', () => {
    for (const v of [undefined, null, 'x', 1, {}, [], [{ kind: 'reasoning', label: 'think' }]]) {
      expect(summarizeToolEvents(v as never)).toBeNull()
    }
  })
  it('dirty elements do not throw: null, numbers, strings, missing label, unknown kind', () => {
    const s = summarizeToolEvents([null, 1, 'x', undefined, [], { kind: 'command' }, { kind: 'other', label: 'Bash' }, { label: 'Bash' }])
    expect(s).toEqual({ v: 1, total: 1, tools: [['shell', 1]] })
  })
  it('reasoning is ignored, command is counted', () => {
    const s = summarizeToolEvents([
      { kind: 'reasoning', label: 'thinking…' }, cmd('Bash(ls)'), cmd('Bash(pwd)'), cmd('Read(/a)'),
    ])
    expect(s).toEqual({ v: TOOL_SUMMARY_VERSION, total: 3, tools: [['Bash', 2], ['Read', 1]] })
  })
  it('fields such as status / output do not affect the counts', () => {
    const s = summarizeToolEvents([
      { kind: 'command', label: 'Bash(ls)', status: 'running', output: '' },
      { kind: 'command', label: 'Bash(ls)', status: 'done', output: 'x'.repeat(1000) },
    ])
    expect(s?.total).toBe(2)
  })
  it('case-sensitive: Bash and bash are two different tools', () => {
    const s = summarizeToolEvents([cmd('Bash'), cmd('bash'), cmd('bash')])
    expect(s?.tools).toEqual([['bash', 2], ['Bash', 1]])
  })
  it('equal counts sort by name ascending (code point order)', () => {
    const s = summarizeToolEvents([cmd('b'), cmd('a'), cmd('C'), cmd('c')])
    expect(s?.tools).toEqual([['C', 1], ['a', 1], ['b', 1], ['c', 1]])
  })
  it('descending count takes priority over name', () => {
    const s = summarizeToolEvents([cmd('z'), cmd('z'), cmd('z'), cmd('a'), cmd('m'), cmd('m')])
    expect(s?.tools).toEqual([['z', 3], ['m', 2], ['a', 1]])
  })
  it('all Codex shell commands merge into shell, together with tools actually named shell', () => {
    const s = summarizeToolEvents([cmd("/bin/zsh -lc 'a'"), cmd("/bin/zsh -lc 'b'"), cmd('shell'), cmd('')])
    expect(s?.tools).toEqual([['shell', 4]])
  })
  it('the same MCP tool on different servers is merged', () => {
    const s = summarizeToolEvents([cmd('mcp__a__go(1)'), cmd('mcp__b__go(2)')])
    expect(s?.tools).toEqual([['go', 2]])
  })
  it('exactly 20 kinds: all kept, no __other__', () => {
    const events = Array.from({ length: 20 }, (_, i) => cmd(`tool${String(i).padStart(2, '0')}`))
    const s = summarizeToolEvents(events)!
    expect(s.tools).toHaveLength(20)
    expect(s.tools.some(([n]) => n === TOOL_SUMMARY_OTHER)).toBe(false)
  })
  it('21 kinds: the first 19 kept, the rest merged into a trailing __other__, at most 20 entries, total unchanged', () => {
    const events: unknown[] = []
    for (let i = 0; i < 21; i++) {
      for (let k = 0; k < 30 - i; k++) events.push(cmd(`tool${String(i).padStart(2, '0')}`))
    }
    const s = summarizeToolEvents(events)!
    expect(s.tools).toHaveLength(TOOL_SUMMARY_MAX_TOOLS)
    expect(s.tools[19][0]).toBe(TOOL_SUMMARY_OTHER)
    expect(s.tools[19][1]).toBe(30 - 19 + (30 - 20))
    expect(s.tools[0]).toEqual(['tool00', 30])
    expect(s.total).toBe(events.length)
    expect(sumCounts(s)).toBe(s.total)
  })
  it('50 kinds with 1 call each: 19 kinds + other=31', () => {
    const events = Array.from({ length: 50 }, (_, i) => cmd(`t${String(i).padStart(2, '0')}`))
    const s = summarizeToolEvents(events)!
    expect(s.tools).toHaveLength(20)
    expect(s.tools[19]).toEqual([TOOL_SUMMARY_OTHER, 31])
    expect(s.tools[0][0]).toBe('t00')
    expect(sumCounts(s)).toBe(50)
  })
  it('the ones merged into other are those ranked last (fewest calls)', () => {
    const events: unknown[] = []
    for (let i = 0; i < 25; i++) for (let k = 0; k <= i; k++) events.push(cmd(`n${String(i).padStart(2, '0')}`))
    const s = summarizeToolEvents(events)!
    const kept = s.tools.slice(0, 19).map(([, c]) => c)
    const other = s.tools[19]
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(7)
    expect(other[0]).toBe(TOOL_SUMMARY_OTHER)
    expect(other[1]).toBe(1 + 2 + 3 + 4 + 5 + 6)
  })
  it('a tool really named __other__ is merged into the summary entry and does not appear twice', () => {
    const s = summarizeToolEvents([cmd('__other__'), cmd('a'), cmd('__other__')])!
    expect(s.tools).toEqual([['a', 1], [TOOL_SUMMARY_OTHER, 2]])
    expect(parseToolSummary(s)).not.toBeNull()
  })
  it('20 kinds + one real __other__: still at most 20 entries', () => {
    const events: unknown[] = Array.from({ length: 20 }, (_, i) => cmd(`k${String(i).padStart(2, '0')}`))
    events.push(cmd('__other__'))
    const s = summarizeToolEvents(events)!
    expect(s.tools).toHaveLength(20)
    expect(s.tools[19][0]).toBe(TOOL_SUMMARY_OTHER)
    expect(s.tools[19][1]).toBe(2)
    expect(sumCounts(s)).toBe(21)
  })
  it('the output always passes parseToolSummary, and total always equals the sum of the entries', () => {
    const samples = [
      [cmd('Bash')],
      [cmd('a'), cmd('b'), cmd('a')],
      Array.from({ length: 300 }, (_, i) => cmd(`x${i % 37}`)),
      Array.from({ length: 100 }, (_, i) => cmd(i % 2 ? '/bin/sh -c x' : 'mcp__s__t')),
    ]
    for (const ev of samples) {
      const s = summarizeToolEvents(ev)!
      expect(sumCounts(s)).toBe(s.total)
      expect(parseToolSummary(s)).toEqual(s)
    }
  })
  it('does not modify its input', () => {
    const events = [cmd('Bash'), cmd('Read')]
    const copy = JSON.parse(JSON.stringify(events))
    summarizeToolEvents(events)
    expect(events).toEqual(copy)
  })
})

const good = () => ({ v: 1, total: 3, tools: [['Bash', 2], ['Read', 1]] })

describe('parseToolSummary: valid input', () => {
  it('an object and a JSON string both parse, with the same result', () => {
    expect(parseToolSummary(good())).toEqual(good())
    expect(parseToolSummary(JSON.stringify(good()))).toEqual(good())
  })
  it('a trailing __other__ is valid (including when it is the only entry)', () => {
    expect(parseToolSummary({ v: 1, total: 5, tools: [['a', 2], [TOOL_SUMMARY_OTHER, 3]] })).not.toBeNull()
    expect(parseToolSummary({ v: 1, total: 4, tools: [[TOOL_SUMMARY_OTHER, 4]] })).not.toBeNull()
  })
  it('boundaries: count/total of 1 and 100000, names of 1 and 48 characters, exactly 20 entries', () => {
    expect(parseToolSummary({ v: 1, total: 1, tools: [['a', 1]] })).not.toBeNull()
    expect(parseToolSummary({ v: 1, total: 100000, tools: [['a', 100000]] })).not.toBeNull()
    expect(parseToolSummary({ v: 1, total: 1, tools: [['x'.repeat(48), 1]] })).not.toBeNull()
    const tools = Array.from({ length: 20 }, (_, i) => [`t${i}`, 1])
    expect(parseToolSummary({ v: 1, total: 20, tools })).not.toBeNull()
  })
  it('extra fields are dropped, only v/total/tools are output', () => {
    const out = parseToolSummary({ ...good(), evil: 'x', output: 'secret' })!
    expect(Object.keys(out).sort()).toEqual(['tools', 'total', 'v'])
    expect(out).toEqual(good())
  })
  it('the output is a new object and shares no references with the input', () => {
    const input = good()
    const out = parseToolSummary(input)!
    out.tools[0][1] = 99
    expect(input.tools[0][1]).toBe(2)
  })
  it('names may contain non-ASCII characters and spaces (only control characters are forbidden)', () => {
    expect(parseToolSummary({ v: 1, total: 1, tools: [['工具 A', 1]] })).not.toBeNull()
  })
})

describe('parseToolSummary: invalid input always gives null', () => {
  const cases: Array<[string, unknown]> = [
    ['undefined', undefined], ['null', null], ['数字', 1], ['布尔', true], ['空字符串', ''],
    ['非 JSON 字符串', 'not json'], ['半截 JSON', '{"v":1,'], ['JSON 数字', '5'], ['JSON null', 'null'],
    ['旧格式：事件数组', [{ kind: 'command', label: 'Bash' }]],
    ['旧格式：事件数组 JSON', '[{"kind":"command","label":"Bash"}]'],
    ['空数组', []],
    ['缺 v', { total: 3, tools: [['Bash', 3]] }],
    ['v=2', { v: 2, total: 3, tools: [['Bash', 3]] }],
    ['v 为字符串 "1"', { v: '1', total: 3, tools: [['Bash', 3]] }],
    ['缺 total', { v: 1, tools: [['Bash', 3]] }],
    ['total 不等于各项之和（偏大）', { v: 1, total: 4, tools: [['Bash', 3]] }],
    ['total 不等于各项之和（偏小）', { v: 1, total: 2, tools: [['Bash', 3]] }],
    ['total 为 0', { v: 1, total: 0, tools: [['Bash', 0]] }],
    ['total 为负', { v: 1, total: -1, tools: [['Bash', -1]] }],
    ['total 小数', { v: 1, total: 1.5, tools: [['Bash', 1.5]] }],
    ['total 字符串', { v: 1, total: '3', tools: [['Bash', 3]] }],
    ['total 超上限', { v: 1, total: 100001, tools: [['Bash', 100001]] }],
    ['total NaN', { v: 1, total: NaN, tools: [['Bash', NaN]] }],
    ['total Infinity', { v: 1, total: Infinity, tools: [['Bash', Infinity]] }],
    ['缺 tools', { v: 1, total: 1 }],
    ['tools 不是数组', { v: 1, total: 1, tools: { Bash: 1 } }],
    ['tools 为空', { v: 1, total: 1, tools: [] }],
    ['tools 超过 20 项', { v: 1, total: 21, tools: Array.from({ length: 21 }, (_, i) => [`t${i}`, 1]) }],
    ['项不是数组', { v: 1, total: 1, tools: [{ name: 'a', count: 1 }] }],
    ['项为字符串', { v: 1, total: 1, tools: ['a'] }],
    ['项只有一个元素', { v: 1, total: 1, tools: [['a']] }],
    ['项有三个元素', { v: 1, total: 1, tools: [['a', 1, 'x']] }],
    ['名字不是字符串', { v: 1, total: 1, tools: [[1, 1]] }],
    ['名字为 null', { v: 1, total: 1, tools: [[null, 1]] }],
    ['名字为空', { v: 1, total: 1, tools: [['', 1]] }],
    ['名字 49 字符', { v: 1, total: 1, tools: [['x'.repeat(49), 1]] }],
    ['名字含换行', { v: 1, total: 1, tools: [['a\nb', 1]] }],
    ['名字含 NUL', { v: 1, total: 1, tools: [['a\u0000b', 1]] }],
    ['名字含 ESC', { v: 1, total: 1, tools: [['a\u001bb', 1]] }],
    ['名字含 DEL', { v: 1, total: 1, tools: [['a\u007fb', 1]] }],
    ['名字含 C1 控制符', { v: 1, total: 1, tools: [['a\u0085b', 1]] }],
    ['count 为 0', { v: 1, total: 3, tools: [['a', 0], ['b', 3]] }],
    ['count 为负', { v: 1, total: 1, tools: [['a', -1], ['b', 2]] }],
    ['count 小数', { v: 1, total: 3, tools: [['a', 1.5], ['b', 1.5]] }],
    ['count 字符串', { v: 1, total: 3, tools: [['a', '3']] }],
    ['count 超上限', { v: 1, total: 100001, tools: [['a', 100001]] }],
    ['count null', { v: 1, total: 1, tools: [['a', null]] }],
    ['名字重复', { v: 1, total: 2, tools: [['a', 1], ['a', 1]] }],
    ['__other__ 重复', { v: 1, total: 2, tools: [[TOOL_SUMMARY_OTHER, 1], [TOOL_SUMMARY_OTHER, 1]] }],
    ['__other__ 不在末尾', { v: 1, total: 3, tools: [[TOOL_SUMMARY_OTHER, 1], ['a', 2]] }],
    ['__other__ 在中间', { v: 1, total: 4, tools: [['a', 1], [TOOL_SUMMARY_OTHER, 2], ['b', 1]] }],
    ['超长字符串', JSON.stringify({ v: 1, total: 1, tools: [['a', 1]], pad: 'x'.repeat(600000) })],
  ]
  for (const [name, input] of cases) {
    it(name, () => {
      expect(parseToolSummary(input)).toBeNull()
      if (input !== undefined && typeof input !== 'string') {
        // An object serialized to a string must also give the same result
        const asText = JSON.stringify(input)
        if (asText !== undefined) expect(parseToolSummary(asText)).toBeNull()
      }
    })
  }
})

describe('isToolSummaryJson', () => {
  it('valid summary JSON -> true', () => {
    expect(isToolSummaryJson(JSON.stringify(good()))).toBe(true)
    expect(isToolSummaryJson(stringifyToolSummary(summarizeToolEvents([cmd('Bash')])!)!)).toBe(true)
  })
  it('old-format array JSON -> false', () => {
    expect(isToolSummaryJson('[]')).toBe(false)
    expect(isToolSummaryJson('[{"kind":"reasoning","label":"x"},{"kind":"command","label":"Bash"}]')).toBe(false)
  })
  it('non-string, object, malformed JSON -> false', () => {
    for (const v of [undefined, null, 1, good(), [], '', 'x', '{"v":1}']) {
      expect(isToolSummaryJson(v as never)).toBe(false)
    }
  })
})

describe('stringifyToolSummary', () => {
  it('compact JSON that round-trips', () => {
    const s = summarizeToolEvents([cmd('Bash'), cmd('Bash'), cmd('Read')])!
    const text = stringifyToolSummary(s)!
    expect(text).toBe('{"v":1,"total":3,"tools":[["Bash",2],["Read",1]]}')
    expect(parseToolSummary(text)).toEqual(s)
  })
  it('20 names of 48 characters, large counts: length < 2000', () => {
    const tools = Array.from({ length: 20 }, (_, i) => [`${String.fromCharCode(97 + i)}`.repeat(48), 99999])
    // total is capped at 100000, so small counts are used to build a valid summary
    const small = tools.map(([n], i) => [n, i === 0 ? 1000 : 1])
    const s = { v: 1, total: 1000 + 19, tools: small }
    const text = stringifyToolSummary(s)!
    expect(text.length).toBeLessThan(2000)
    expect(parseToolSummary(text)).toEqual(s)
  })
  it('a full 20 entries including __other__: length < 2000', () => {
    const tools: [string, number][] = Array.from({ length: 19 }, (_, i) => [`n${i}`.padEnd(48, 'x'), 5])
    tools.push([TOOL_SUMMARY_OTHER, 7])
    const text = stringifyToolSummary({ v: 1, total: 19 * 5 + 7, tools })!
    expect(text.length).toBeLessThan(2000)
  })
  it('multi-byte names: also < 2000 in UTF-8 bytes, total unchanged, still a valid summary', () => {
    const tools: [string, number][] = Array.from({ length: 20 }, (_, i) => [`${String.fromCharCode(0x4e00 + i)}`.repeat(48), 3])
    const s = { v: 1, total: 60, tools }
    const text = stringifyToolSummary(s)!
    expect(new TextEncoder().encode(text).length).toBeLessThan(2000)
    const back = parseToolSummary(text)!
    expect(back).not.toBeNull()
    expect(back.total).toBe(60)
    expect(sumCounts(back)).toBe(60)
  })
  it('when shortening names causes collisions, counts are merged and __other__ stays last', () => {
    // 19 of the 20 entries share a long prefix and differ only at the tail, so they collide when shortened a lot.
    const tools: [string, number][] = Array.from({ length: 19 }, (_, i) => [`${'字'.repeat(47)}${String.fromCharCode(65 + i)}`, 2])
    tools.push([TOOL_SUMMARY_OTHER, 4])
    const text = stringifyToolSummary({ v: 1, total: 42, tools })!
    expect(new TextEncoder().encode(text).length).toBeLessThan(2000)
    const back = parseToolSummary(text)!
    expect(back.total).toBe(42)
    expect(back.tools[back.tools.length - 1][0]).toBe(TOOL_SUMMARY_OTHER)
  })
  it('invalid summary -> null; extra fields are dropped', () => {
    expect(stringifyToolSummary(null)).toBeNull()
    expect(stringifyToolSummary({ v: 1, total: 5, tools: [['a', 1]] })).toBeNull()
    expect(stringifyToolSummary([] as never)).toBeNull()
    expect(stringifyToolSummary({ ...good(), extra: 1 })).toBe(stringifyToolSummary(good()))
  })
  it('accepts a JSON string input (reuses parse normalization)', () => {
    expect(stringifyToolSummary(JSON.stringify(good()))).toBe(JSON.stringify(good()))
  })
})

describe('module shape: can be inlined by inlineModule', () => {
  it('the source has only line-start export function/const, no default / list exports / import', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../core/tool-summary.mjs'), 'utf8')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/export\s+default/)
    expect(src).not.toMatch(/export\s*\{/)
    const stripped = src.replace(/^export\s+/gm, '')
    expect(stripped).not.toMatch(/^export\s/m)
  })
})

describe('notes (narration): stored with the summary in the same message, forward compatible', () => {
  const note = (label: string) => ({ kind: 'reasoning', note: true, label })
  const thinkingRaw = { kind: 'reasoning', label: '模型内部推理' }

  it('only note:true narration is kept, recording the number of commands before each one in order; neither reasoning text nor full commands are included', () => {
    const s = summarizeToolEvents([note('先看现状'), cmd('/bin/zsh -lc ls'), thinkingRaw, note('表格如下\n|a|b|'), cmd('Bash(x)')])!
    expect(s.notes).toEqual([{ after: 0, text: '先看现状' }, { after: 1, text: '表格如下\n|a|b|' }])
    expect(JSON.stringify(s)).not.toContain('模型内部推理')
    expect(JSON.stringify(s)).not.toContain('zsh')
  })
  it('narration with no commands is still kept, and the summary is still valid', () => {
    const s = summarizeToolEvents([note('只有旁白')])!
    expect(s).toEqual({ v: 1, total: 0, tools: [], notes: [{ after: 0, text: '只有旁白' }] })
    expect(parseToolSummary(stringifyToolSummary(s))).toEqual(s)
  })
  it('no commands and no narration still returns null; a diagnostic hint (without the note marker) is not narration', () => {
    expect(summarizeToolEvents([thinkingRaw])).toBeNull()
  })
  it('an old-format summary (without notes) reads and writes as usual, with no notes field in the output', () => {
    const old = '{"v":1,"total":56,"tools":[["shell",56]]}'
    expect(parseToolSummary(old)).toEqual({ v: 1, total: 56, tools: [['shell', 56]] })
    expect(stringifyToolSummary(old)).toBe(old)
  })
  it('bad narration entries are skipped and do not break the summary itself', () => {
    const raw = { v: 1, total: 1, tools: [['a', 1]], notes: [{ after: 0, text: '好' }, { after: -1, text: '坏' }, { text: '缺after' }, 'x', { after: 0, text: '  ' }] }
    expect(parseToolSummary(raw)).toEqual({ v: 1, total: 1, tools: [['a', 1]], notes: [{ after: 0, text: '好' }] })
    expect(parseToolSummary({ ...raw, notes: 'bad' })).toEqual({ v: 1, total: 1, tools: [['a', 1]] })
  })
  it('with no commands and no valid narration, an object with total 0 is still invalid', () => {
    expect(parseToolSummary({ v: 1, total: 0, tools: [] })).toBeNull()
    expect(parseToolSummary({ v: 1, total: 0, tools: [], notes: [{ after: 0, text: '' }] })).toBeNull()
  })
  it('over the limit only the newest narration is kept, and a single overlong note is truncated', () => {
    const many = Array.from({ length: 150 }, (_, i) => note(`n${i}`))
    const s = summarizeToolEvents(many)!
    expect(s.notes!.length).toBe(100)
    expect(s.notes![99].text).toBe('n149')
    const long = summarizeToolEvents([note('x'.repeat(10000))])!
    expect(long.notes![0].text.length).toBe(6001)
  })
  it('the summary body stays under 2000 bytes with narration attached separately; serialization round-trips, and lone surrogates are replaced', () => {
    const s = summarizeToolEvents([note('a\ud800b'), cmd('Bash')])!
    const text = stringifyToolSummary(s)!
    const back = JSON.parse(text)
    expect(back.notes[0].text).toBe('a\ufffdb')
    expect(new TextEncoder().encode(JSON.stringify({ v: back.v, total: back.total, tools: back.tools })).length).toBeLessThan(2000)
    expect(isToolSummaryJson(text)).toBe(true)
  })
  it('an old web page / server reading the new object: only v/total/tools are recognized, no error (old parse behavior)', () => {
    // The core check of the old implementation: it passes if v===1 and total and tools are valid, and extra fields are dropped.
    // The new object satisfies this, so old code still shows the one-line summary as before.
    const text = stringifyToolSummary(summarizeToolEvents([note('n'), cmd('Bash')])!)!
    const obj = JSON.parse(text)
    expect(obj.v).toBe(1)
    expect(obj.total).toBe(1)
    expect(obj.tools).toEqual([['Bash', 1]])
  })
})
