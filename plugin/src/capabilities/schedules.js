/** @typedef {import('./index.js').CapabilitySpec} CapabilitySpec */

/** @type {CapabilitySpec[]} */
export const schedules = [
  {
    name: 'schedules.list',
    write: false,
    summary: 'Scheduled tasks the acting person can see, without the prompt text (see schedules.info).',
    params: {
      limit: '1-20, default 20.',
      offset: 'Use next_offset from the previous page.',
      filter: 'all (default), active, paused or completed.',
    },
    returns: '{ schedules: [{ id, name, enabled, kind, at_time, interval_minutes, day_spec, timezone, next_run_at, last_status, machine_id, machine_name, project_id, project_name, target, target_session_id }], has_more, next_offset }',
  },
  {
    name: 'schedules.info',
    write: false,
    summary: 'One scheduled task in full, including its prompt text and run settings. A separate permission from schedules.list because prompts can hold internal content. 404 schedule_not_found when missing or not visible.',
    params: { schedule_id: 'Required.' },
    returns: '{ schedule: { id, name, enabled, prompt, kind, at_time, interval_minutes, day_spec, timezone, next_run_at, last_status, consecutive_failures, disabled_reason, machine_id, machine_name, project_id, project_name, target, target_session_id, last_session_id, agent, model, reasoning_effort, exec_mode, created_at } }',
  },
]
