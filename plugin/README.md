# OpenTandem plugin SDK

Build apps for [OpenTandem](https://opentandem.org). An app can read conversations (with their usage), projects, computers and scheduled tasks from a
workspace and send messages into conversations, from its own server, from a page inside the
OpenTandem console, or both.

中文文档：[README.zh-CN.md](README.zh-CN.md)

| Part | What it is | Where it runs |
|---|---|---|
| App | Your identity: an app ID, a secret and the permissions you ask for. Created under **Settings → Developer**. A workspace admin authorizes it for their workspace. | — |
| Plugin | Optional, at most one per app. The app's page: an entry in the console sidebar plus a page in the main area. A folder of static files you upload. | In the console, in a sandboxed iframe |
| API (page) | `@opentandem/plugin`: calls capabilities from the plugin page through the console. | Browser |
| Server | `@opentandem/plugin/server`: exchanges the app ID and secret for a token and calls the same capabilities over HTTPS. | Your server |

Both sides call the same [capabilities](#capabilities) with the same parameters and get the same JSON.

## Permissions model

- Every capability is also a permission. The app asks for a set; the workspace admin grants all or part of it.
- **From a page**, a call acts as the member who opened it: it sees only what that member can see on
  the web, cut down to what the workspace granted. Writes (`messages.send`) show the member a
  confirmation dialog every time.
- **From your server**, a call acts as the admin who authorized the app, as they are now. If they
  leave the workspace or stop being an admin, calls fail with `grant_inactive` until an admin
  authorizes again.
- An app never gets more than the person it acts as could open on the web. Revoking takes effect on the next call.

## Getting started

1. In OpenTandem, open **Settings → Developer → Create app**, choose a name and the permissions. Save the secret; it is shown once.
2. Copy the **authorization link** and send it to a workspace admin. They review the permissions and click **Allow**.
3. Call capabilities from your server (below), or upload a plugin to give the app a page.

## Framework: the plugin folder

```
my-plugin/
  manifest.json        required
  index.html           the entry page (or whatever manifest.entry names)
  app.js, style.css, images, fonts …
  opentandem/          copy of this package's src/ folder, if you don't use a bundler
```

`manifest.json` ([schema](manifest.schema.json)):

```json
{
  "name": "Usage",
  "title": { "zh": "用量", "en": "Usage" },
  "scopes": ["projects.list", "sessions.list", "messages.send"],
  "entry": "index.html"
}
```

`name` and `scopes` are only read when someone installs the folder with **Settings → Apps → Import plugin folder** (see below); they let it be installed in one step. When you upload to your own app under **Settings → Developer**, the app's name and permissions are the ones you set there.

`title` is one string, or one string per language (`zh`, `en`; at most 20 characters each). The sidebar and the page header show the viewer's language, then English, then Chinese. The page itself gets the language from `ot.context`.

| Rule | Value |
|---|---|
| Size | At most 100 files and 5 MB in total; each image at most 2 MB |
| File types | html, js, mjs, css, json, map, txt, svg, png, jpg, gif, webp, ico, woff, woff2; other files (such as README.md) are skipped |
| Paths | Letters, digits, `.`, `_`, `-` and `/`. Files starting with a dot are skipped |
| Links | Use relative paths (`./app.js`). Absolute paths (`/app.js`) point outside your folder and will not load |
| Upload | **Settings → Developer → Upload plugin folder**. Every upload is a new version; authorized workspaces pick it up when the page is opened again |
| Install someone else's plugin | A workspace admin picks the folder in **Settings → Apps → Import plugin folder**, then confirms the permissions from `scopes`. The admin becomes the app's owner and the import is a copy: later changes by its author do not reach it, import again to update. To keep receiving the author's updates, authorize the author's own app by its app ID instead |

### The sandbox

The page runs in an iframe with a sandbox and its own opaque origin. It has no OpenTandem cookies
and cannot read or change the console. Content Security Policy of the page:

| Directive | Allowed |
|---|---|
| Scripts, styles | Your own files and inline |
| Images | Your files, `data:`, `blob:` and any `https:` URL |
| Network (`fetch`, WebSocket) | Any `https:` URL, for example your own backend |
| Popups | Allowed, opened outside the sandbox |
| `localStorage`, cookies | Not available (opaque origin); keep state in memory or on your server |

## API: calling from the page

```html
<script type="module">
  import { createClient } from './opentandem/client/index.js' // or '@opentandem/plugin' with a bundler
  const ot = createClient()
  const { locale } = await ot.context          // 'zh' or 'en'; the console language
  const { sessions } = await ot.sessions.list({ days: 7 })
  document.body.textContent = `${sessions.length} conversations`
</script>
```

| Member | Meaning |
|---|---|
| `ot.context` | Promise of `{ locale, app: { id, name } }` |
| `ot.<group>.<action>(params)` | Call a capability, e.g. `ot.sessions.list({ limit: 20 })`. Resolves with the JSON answer |
| `ot.call(name, params)` | Same, by name |
| Errors | Rejects with `OpenTandemError` (`code`, `message`). `user_denied` when the member declined a write, `timeout` after 30 s (10 min for writes waiting for confirmation) |

Context never includes who the member is. Show their data, not their identity.

## Server: calling from your backend

```js
import { createServerClient } from '@opentandem/plugin/server'

const ot = createServerClient({
  baseUrl: 'https://opentandem.org',
  appId: process.env.OPENTANDEM_APP_ID,
  secret: process.env.OPENTANDEM_APP_SECRET,
})
const { spaces } = await ot.spaces()                       // workspaces that authorized the app
const { sessions } = await ot.sessions.list({ days: 7 }, { space: spaces[0].id })
```

The client caches the token and renews it 5 minutes before it expires. Without the SDK:

| Request | Answer |
|---|---|
| `POST /api/open/token` with `{ "app_id", "secret" }` | `{ access_token, token_type: "Bearer", expires_at }`, valid 2 hours. Resetting the secret invalidates every token |
| `GET /api/open/spaces?offset=0` with `Authorization: Bearer <token>` | `{ spaces: [{ id, name, scopes, granted_at }], has_more, next_offset }` |
| `GET` or `POST /api/open/<group>/<action>` with the token; parameters in the query string (GET) or JSON body (POST), plus `space` | The capability's JSON answer. Writes must use POST |

## Capabilities

| Name | Write | Parameters | Returns |
|---|---|---|---|
| `projects.list` |  | `limit` (≤20), `offset` | `projects[]` (`id`, `name`, `access`, `machine_id`, `created_at`), `has_more`, `next_offset` |
| `sessions.list` |  | `limit` (≤20), `offset`, `project` (a project id, or `none`), `archived`, optional range (`from`, `to` or `days`) | `total` (every match), `sessions[]` (`id`, `title`, `agent`, `model`, `machine_id`, `machine_name`, `project_id`, `project_name`, `archived`, `created_at`, `updated_at`, `last_message_at`, `usage` { `runs`, `input_tokens`, `output_tokens` }), `has_more`, `next_offset`. `usage` is inside the range when one is given, otherwise over the conversation's whole life; add the rows up for totals |
| `sessions.info` |  | `session_id` | `session`: the list fields plus `messages` { `total`, `user`, `assistant` }, `usage` (whole life) and `last_run` |
| `messages.list` | | `session_id`, `limit` (≤20), `before_seq` | `messages[]` (`id`, `seq`, `role`, `content`, `created_at`, `via_app`), `has_more`, `next_before_seq` |
| `messages.send` | ✓ | `session_id`, `content` (≤20,000 chars) | `message_id`, `run_id`, `session_id` |
| `machines.list` | | `limit` (≤20), `offset` | `machines[]` (`id`, `name`, `os`, `online`, `runner_version`, `disconnected`, `last_seen_at`, `agents[]`), `has_more`, `next_offset` |
| `machines.info` |  | `machine_id` | `machine`: the list fields plus `skills` { `reported`, `total`, `by_source`, `scanned_at` } |
| `schedules.list` |  | `limit` (≤20), `offset`, `filter` (`all`, `active`, `paused`, `completed`) | `schedules[]` (no prompts), `has_more`, `next_offset` |
| `schedules.info` |  | `schedule_id` | `schedule` in full, including `prompt` and the agent settings. Its own permission, separate from `schedules.list` |

Notes:

- Times are UTC strings `YYYY-MM-DD HH:MM:SS` unless a parameter says otherwise.
- Some agents do not report token counts; their runs are counted with zero tokens.
- Messages carry no author identity and no tool output. A message an app sent shows the app's name in the conversation.
- Lists return at most 20 items per page.

The machine-readable list is in [`src/capabilities/`](src/capabilities/index.js).

## Limits

Per app and workspace: reads 120 per minute and 20,000 per day; writes 20 per minute and 1,000 per day; token
requests 30 per minute per app. Over the limit the answer is `429 rate_limited` with `Retry-After` (seconds).

## Errors

Errors are JSON `{ "error": "<code>", "message"?: "…" }`.

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | Wrong app ID or secret |
| `invalid_token` | 401 | Token forged, expired, or issued before the secret was reset |
| `space_not_granted` | 403 | That workspace has not authorized the app (or does not exist) |
| `grant_inactive` | 403 | The admin who authorized the app is no longer an admin there |
| `scope_not_granted` | 403 | The workspace did not grant this capability |
| `unknown_capability` | 404 | No such capability |
| `session_not_found` | 404 | The conversation does not exist or the acting person cannot see it |
| `invalid_param` | 400 | A parameter is missing or malformed; `message` says which |
| `machine_offline`, `machine_disconnected` | 400, 409 | `messages.send`: the conversation's computer cannot take work right now |
| `rate_limited` | 429 | See [Limits](#limits) |
| `user_denied` | — | Page only: the member declined the write |

## License

AGPL-3.0-only, like the rest of this repository.
