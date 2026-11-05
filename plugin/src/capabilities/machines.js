/** @typedef {import('./index.js').CapabilitySpec} CapabilitySpec */

/** @type {CapabilitySpec[]} */
export const machines = [
  {
    name: 'machines.list',
    write: false,
    summary: 'Computers connected to the workspace, with the agents installed on each.',
    params: { limit: '1-20, default 20.', offset: 'Use next_offset from the previous page.' },
    returns: '{ machines: [{ id, name, os, online, runner_version, disconnected, last_seen_at, agents: [{ agent, version, logged_in }] }], has_more, next_offset }',
  },
  {
    name: 'machines.info',
    write: false,
    summary: 'One computer: its agents with login state and how many skills it reports, by source (project, user, global, plugin). 404 machine_not_found for a computer of another workspace.',
    params: { machine_id: 'Required.' },
    returns: '{ machine: { id, name, os, online, runner_version, disconnected, last_seen_at, agents: [{ agent, version, logged_in }], skills: { reported, total, by_source, scanned_at } } }',
  },
]
