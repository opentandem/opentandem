// The capability list. The same names work from an app page (client) and from an app server
// (server); each name is also a permission a workspace admin grants. Keep in step with the
// OpenTandem server, which only accepts these names.
import { projects } from './projects.js'
import { sessions } from './sessions.js'
import { messages } from './messages.js'
import { machines } from './machines.js'
import { schedules } from './schedules.js'

/**
 * @typedef {object} CapabilitySpec
 * @property {string} name     `<group>.<action>`, also the permission name.
 * @property {boolean} write   Writes need a POST from servers and a confirmation from members on app pages.
 * @property {string} summary
 * @property {Record<string, string>} params  Parameter name → description.
 * @property {string} returns  Shape of the JSON answer.
 */

/** @type {CapabilitySpec[]} */
export const CAPABILITIES = [...projects, ...sessions, ...messages, ...machines, ...schedules]

export const CAPABILITY_NAMES = CAPABILITIES.map(c => c.name)

/**
 * Turn a call function into `{ projects: { list(params) }, sessions: { list(params) }, ... }`.
 * @template T
 * @param {(name: string, params?: Record<string, unknown>) => Promise<T>} call
 */
export function groupedMethods(call) {
  /** @type {Record<string, Record<string, (params?: Record<string, unknown>) => Promise<T>>>} */
  const out = {}
  for (const { name } of CAPABILITIES) {
    const [group, action] = name.split('.')
    ;(out[group] ??= {})[action] = params => call(name, params)
  }
  return out
}
