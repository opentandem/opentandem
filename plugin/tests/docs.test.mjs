import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CAPABILITIES, CAPABILITY_NAMES } from '../src/capabilities/index.js'

test('capability names are unique and only messages.send is a write', () => {
  assert.equal(new Set(CAPABILITY_NAMES).size, CAPABILITY_NAMES.length)
  assert.deepEqual(CAPABILITIES.filter(c => c.write).map(c => c.name), ['messages.send'])
})

test('every capability documents its description, params and result', () => {
  for (const c of CAPABILITIES) {
    assert.ok(c.summary.length > 20, c.name)
    assert.equal(typeof c.params, 'object', c.name)
    assert.ok(c.returns.startsWith('{'), c.name)
  }
})

test('both READMEs list every capability', () => {
  for (const file of ['../README.md', '../README.zh-CN.md']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const name of CAPABILITY_NAMES) assert.ok(text.includes(`\`${name}\``), `${file} is missing ${name}`)
  }
})

test('the manifest schema is valid JSON and requires title', () => {
  const schema = JSON.parse(readFileSync(new URL('../manifest.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(schema.required, ['title'])
})
