/** @typedef {import('./index.js').CapabilitySpec} CapabilitySpec */

/** @type {CapabilitySpec[]} */
export const messages = [
  {
    name: 'messages.list',
    write: false,
    summary: 'Messages of one conversation, newest first. Only role, text and time: no author identity and no tool output.',
    params: {
      session_id: 'Required.',
      limit: '1-20, default 20.',
      before_seq: 'Use next_before_seq from the previous page to go further back.',
    },
    returns: '{ messages: [{ id, seq, role, content, created_at, via_app }], has_more, next_before_seq }',
  },
  {
    name: 'messages.send',
    write: true,
    summary: 'Send a message into an existing conversation; its agent runs on the computer the conversation is bound to. From an app page, the member confirms every send. Shown in the conversation with the app name.',
    params: {
      session_id: 'Required. A conversation the acting person can see.',
      content: 'Required. Up to 20,000 characters.',
    },
    returns: '{ message_id, run_id, session_id }',
  },
]
