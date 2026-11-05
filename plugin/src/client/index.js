// For app pages (the plugin): runs inside the OpenTandem console.
//
//   import { createClient } from '@opentandem/plugin'
//   const ot = createClient()
//   const { locale } = await ot.context
//   const usage = await ot.sessions.list({ days: 7 })
//
// Calls act as the member who opened the page: they only see what that member can see on the
// web, cut down to the permissions the workspace granted the app.
import { CAPABILITIES, groupedMethods } from '../capabilities/index.js'
import { createBridge, OpenTandemError } from './bridge.js'

const WRITES = new Set(CAPABILITIES.filter(c => c.write).map(c => c.name))

export function createClient(options) {
  const bridge = createBridge(options)
  /** @param {string} name @param {Record<string, unknown>} [params] */
  const call = (name, params) => bridge.call(name, params, { write: WRITES.has(name) })
  return { context: bridge.context, call, ...groupedMethods(call) }
}

export { CAPABILITIES, OpenTandemError }
