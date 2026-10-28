# OpenTandem CLI

The `opentandem` command connects a computer to [OpenTandem](https://opentandem.org) and keeps the
[Runner](../runner/) running in the background, so you can send tasks to the coding agents on that
computer from your phone or the web.

```sh
# macOS and Linux (Node.js is not needed)
curl -fsSL https://opentandem.org/install.sh -o install.sh && sh install.sh remote
```

```powershell
# Windows PowerShell (Node.js is not needed)
irm https://opentandem.org/install.ps1 | iex; opentandem remote
```

Scan the QR code with your phone, sign in, and tap **Allow**. The computer is connected, runs in the
background and starts with the computer.

Already have Node.js 18 or later? This does the same in one line:

```sh
npx -y opentandem@latest remote
```

Either way the background service runs on its own pinned runtime, not on the Node.js you have installed.

## Commands

| Command | What it does |
|---|---|
| `opentandem remote` | Connect this computer by scanning a QR code with your phone. When it is already connected, says so and shows a QR code that opens OpenTandem on your phone. |
| `opentandem list` | The Runners on this computer (one per workspace), their ids, and whether each is online. |
| `opentandem start` · `stop` · `restart` `[<id> \| all]` | Start, stop or restart one Runner by id (the first few characters are enough). With a single Runner the id can be left out; with several, it lists them and asks. `all` acts on the whole background service: `start all` also turns on start at login, `stop all` turns it off. |
| `opentandem logs [<id>] [-f]` | Show the latest log lines, or follow them. |
| `opentandem update` | Update the CLI and the Runner now and restart the service. |
| `opentandem uninstall` | Remove the service and the program. Your local conversation history stays. |

Add `--server <url>` to use another OpenTandem server.

## How it works

| File | Role |
|---|---|
| `launcher.mjs` | The only file in the npm package and the file the background service starts. On every run it asks the server for the current CLI, Runner and Node.js versions, installs the pinned Node.js runtime once (checked against a pinned sha256), downloads the current CLI files, and runs them. If the server cannot be reached it uses what is already installed. |
| `opentandem.cjs` | The commands. `remote` asks the server for a pairing code and shows it as a QR code; after you allow it on the phone, the CLI receives a short-lived session (bound to a secret that never leaves this computer), uses it once to register the computer and signs it out right away. |
| `core.cjs` | Device id, the connection file, and the Runner pool (one Runner per connection). Shared with the OpenTandem desktop app. |
| `service.cjs` | The background service: a LaunchAgent on macOS, a systemd user service on Linux, a hidden start at login on Windows. |
| `install.sh`, `install.ps1` | Installers for computers without Node.js. |

The background service and every Runner run on OpenTandem Service: Node.js under our name, so Activity Monitor, Task Manager and the macOS privacy settings show OpenTandem instead of node. On macOS it is the signed `OpenTandem Service.app` published with the OpenTandem desktop app (downloaded once and checked against a sha256 from the server; the Node.js license is kept next to it); on Windows and Linux it is a renamed copy of the pinned Node.js. It contains no OpenTandem code. When you run `cli/launcher.mjs` from source and the server offers no OpenTandem Service, your own Node.js is used.

When the OpenTandem desktop app already connects this computer to the same server, the CLI does not connect it a second time: `remote` and `connect` point you to the app, `status` and `logs` show the app's Runners, and the app manages the rest.

Everything is stored next to the Runner's local data: `~/Library/Application Support/OpenTandem/<server>` on macOS,
`%LOCALAPPDATA%\OpenTandem\<server>` on Windows and `~/.local/share/opentandem/<server>` on Linux.
`uninstall` removes only the CLI's own files there.

The CLI uses only Node.js built-in modules.

## License

[GNU Affero General Public License v3.0](LICENSE).
