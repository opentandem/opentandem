// The same numbers from your server:
//   OPENTANDEM_URL=https://opentandem.org OPENTANDEM_APP_ID=ota_… OPENTANDEM_APP_SECRET=ots_… node server.mjs
import { createServerClient } from '../../src/server/index.js'

const ot = createServerClient({
  baseUrl: process.env.OPENTANDEM_URL || 'https://opentandem.org',
  appId: process.env.OPENTANDEM_APP_ID,
  secret: process.env.OPENTANDEM_APP_SECRET,
})
const { spaces } = await ot.spaces()
if (!spaces.length) throw new Error('No workspace has authorized this app yet.')
const where = { space: spaces[0].id }
let tokens = 0, runs = 0, count = 0
for (let offset = 0; ;) {
  const page = await ot.sessions.list({ days: 7, offset }, where)
  for (const s of page.sessions) { tokens += s.usage.input_tokens + s.usage.output_tokens; runs += s.usage.runs; count++ }
  if (!page.has_more) break
  offset = page.next_offset
}
console.log(`${spaces[0].name}: ${count} conversations, ${runs} runs, ${tokens} tokens (last 7 days)`)
