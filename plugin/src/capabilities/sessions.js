/** @typedef {import('./index.js').CapabilitySpec} CapabilitySpec */

/** @type {CapabilitySpec[]} */
export const sessions = [
  {
    name: 'sessions.list',
    write: false,
    summary: 'Conversations the acting person can see, most recently updated first, at most 20 per page. Each row carries its own runs and tokens (inside from/to/days when given, otherwise over its whole life); add them up yourself.',
    params: {
      limit: '1-20, default 20.',
      offset: 'Use next_offset from the previous page.',
      project: 'Optional. A project id from projects.list, or `none` for conversations without a project.',
      archived: 'true to list archived conversations instead.',
      from: 'Optional ISO 8601 time: only conversations updated since then, and usage counted from then (with to or days).',
      to: 'Optional ISO 8601 time.',
      days: 'Optional, 1-90.',
    },
    returns: '{ total, sessions: [{ id, title, agent, model, machine_id, machine_name, project_id, project_name, archived, created_at, updated_at, last_message_at, usage: { runs, input_tokens, output_tokens } }], has_more, next_offset }  (total counts every match, not just this page)',
  },
  {
    name: 'sessions.info',
    write: false,
    summary: 'Information about one conversation, like the web "session info" without paths and people. 404 session_not_found when it does not exist or the acting person cannot see it.',
    params: { session_id: 'Required.' },
    returns: '{ session: { ...same fields as sessions.list without usage, messages: { total, user, assistant }, usage: { runs, input_tokens, output_tokens } (whole life), last_run: { status, started_at, finished_at } | null } }',
  },
]
