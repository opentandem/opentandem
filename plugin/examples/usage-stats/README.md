# Example: usage dashboard

An app page in the style of a monthly usage poster: total tokens, runs and conversations, a daily chart split by
agent with each agent's share, and a Top 10 of conversations. It asks `sessions.list` once per day (7 calls plus
paging, well inside the 120 reads per minute limit) and adds the per-conversation usage up itself; there is no
per-day or per-agent endpoint. The project picker narrows everything to one project.
`server.mjs` prints the same totals from a server.

Known simplification: a conversation counts for the agent it uses now, even if it switched agents midway.

To install it in one step instead of the steps below, a workspace admin picks this folder in **Settings → Apps → Import plugin folder** (`manifest.json` already names the app and its permissions).

| Step | What to do |
|---|---|
| 1 | Create an app under **Settings → Developer** with `projects.list` and `sessions.list` |
| 2 | Copy the SDK next to the page: `cp -R ../../src ./opentandem` |
| 3 | **Upload plugin folder** and pick this folder |
| 4 | Open the authorization link as a workspace admin and allow |
| 5 | The **Apps** group in the sidebar now shows **Usage** |
| 6 | `OPENTANDEM_APP_ID=… OPENTANDEM_APP_SECRET=… node server.mjs` prints the same totals |
