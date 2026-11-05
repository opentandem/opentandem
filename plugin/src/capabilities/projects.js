/** @typedef {import('./index.js').CapabilitySpec} CapabilitySpec */

/** @type {CapabilitySpec[]} */
export const projects = [
  {
    name: 'projects.list',
    write: false,
    summary: 'Projects the acting person can see (admins: all; members: open projects and restricted ones they belong to). No folder paths. Use an id as the `project` parameter of sessions.list.',
    params: { limit: '1-20, default 20.', offset: 'Use next_offset from the previous page.' },
    returns: '{ projects: [{ id, name, access, machine_id, created_at }], has_more, next_offset }',
  },
]
