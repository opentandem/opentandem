import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stubAdapters } from './fixtures/adapter-context'

const source = fs.readFileSync(path.resolve(__dirname, '../core/machine-daemon.mjs'), 'utf8')
const start = source.indexOf('function runtimeInstructions(run)')
const end = source.indexOf('function killProcessTree(', start)
// Which agent tool has a native question-card tool, and what it is called, is declared by the adapter's userChoices;
// the sentence for rule 6 is in the core userChoicesRule.
const ruleStart = source.indexOf('const userChoicesRule = ')
const context = vm.createContext({ OPENTANDEM_HELP_RULE: 'Help rule.', ADAPTERS: stubAdapters() })
vm.runInContext(source.slice(ruleStart, source.indexOf('\n', ruleStart)) + '\n' + source.slice(start, end), context)

describe('runtime instructions for required user input', () => {
  it.each([
    ['codex', 'request_user_input'],
    ['claude', 'AskUserQuestion'],
    ['opencode', 'question'],
  ])('uses the native question tool and a turn-ending fallback for %s', (runtime, tool) => {
    const result = context.runtimeInstructions({
      runtime,
      runtime_instructions: '5. Keep this rule.\n6. User choices: old rule.\n7. Keep this too.',
    }) as string
    expect(result).toContain(`when a decision or missing information is required to proceed, call ${tool}`)
    expect(result).toContain('wait for an explicit answer')
    expect(result).toContain('If the tool is unavailable, ask the question in your final response and end the turn to wait for the next user message')
    expect(result).toContain('do not use sleep or polling to keep waiting')
    expect(result).toContain('Do not choose or time out on behalf of the user')
    expect(result).toContain('Continue dependent work only after the answer arrives')
    expect(result).toContain('Do not ask for choices or information the user already provided')
    expect(result).toContain('5. Keep this rule.\n6. User choices:')
    expect(result).toContain('\n7. Keep this too.')
    expect(result.match(/6\. User choices:/g)).toHaveLength(1)
    expect(result).not.toContain('old rule')
    expect(result).toContain('The question card shows plain text only')
    expect(result).toContain(`show them in your final reply and end the turn instead of calling ${tool}.\n7. Keep this too.`)
    expect(result.includes('option preview')).toBe(runtime === 'claude')
  })

  it('tells codex never to use the non-blocking async question tool', () => {
    const result = context.runtimeInstructions({ runtime: 'codex', runtime_instructions: '6. User choices: old rule.' }) as string
    expect(result).toContain('never request_user_input_async')
  })

  it('preserves the existing rule for other runtimes', () => {
    expect(context.runtimeInstructions({ runtime: 'gemini', runtime_instructions: '6. User choices: existing rule.' }))
      .toBe('6. User choices: existing rule.\nHelp rule.')
  })
})
