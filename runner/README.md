# OpenTandem Runner

**OpenTandem is a unified workspace for individuals and teams that manages multiple AI coding agents, with mobile access.**

One workspace, all your machines, with agent switching, model routing, live quota tracking, and team collaboration.

The Runner is the part of OpenTandem that runs on your own computer. It keeps one connection to the
OpenTandem server, picks up the tasks you send from the web app or your phone, starts the coding agent
you chose (Codex, Claude Code, OpenCode, Gemini CLI and others) in the project directory on this
machine, and streams the agent's progress, answers and files back. Your code and the agents'
sessions stay on this computer.

This directory is the complete Runner: everything that runs on your machine is here. The OpenTandem
server and web app are not part of it.

## Install

Most people never need this directory. Run this on the computer where your coding agents live, then scan
the QR code with your phone:

```sh
npx opentandem@latest remote
```

The [`opentandem` command](../cli/) installs and updates this Runner and keeps it running in the
background. On a Mac you can also install the [desktop app](https://opentandem.org/download), sign in and
choose **Connect**; the app runs this Runner for you.

The Runner only works together with an OpenTandem account: tasks come from the web app and the
results go back to it.

> **Note for AI agents:** you can install dependencies, run the tests and build the bundle on your own
> (see below). To connect a computer, run `npx opentandem@latest remote` and show the QR code or link to
> the person you are helping: only they can scan it, sign in and allow the computer. Do not make up a
> machine id or key, and do not copy one from another computer.

## Requirements

- Node.js 22.13 or later (the local conversation store uses the built-in `node:sqlite`).
- The Runner itself has no npm dependencies; it imports only `node:` built-ins. The dev dependencies
  in `package.json` are for the tests.

## Run from source

Connect the computer once as described in [Install](#install). The installed Runner's start command
already contains the machine id (`--id`) and the path of its key file (`--token-file`):

| System | Start command | Key file |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.opentandem.runner.opentandem.org.<machine id>.plist` | `~/Library/Application Support/OpenTandem Runner/opentandem.org.<machine id>/runner.key` |
| Linux | `~/.config/systemd/user/opentandem-runner-opentandem.org.service` | `~/.local/share/opentandem-runner/opentandem.org/runner.key` |
| Windows | `%LOCALAPPDATA%\OpenTandem Runner\opentandem.org\run-runner.cmd` | `%LOCALAPPDATA%\OpenTandem Runner\opentandem.org\runner.key` |

Stop the installed Runner, because two Runners must not use the same machine id at the same time, then run:

```sh
node core/machine-daemon.mjs --server https://opentandem.org --id <machine id> --token-file <path to runner.key>
```

A Runner started from source never updates itself: self-update downloads the single-file build, and
replacing a working copy with it would overwrite your changes.

## Build the single file

Every installed Runner runs one file. `build/bundle.mjs` follows every relative import from
`core/machine-daemon.mjs`, inlines each module in its own scope, and turns `const RUNNER_BUNDLED = false`
into `true`:

```sh
npm run bundle      # writes dist/runner.mjs
npm run selftest    # bundles, then runs the bundle's own self-test (no server needed)
```

## Test

```sh
npm install
npm test            # vitest suites, then the node:test suites in tests/node/
```

`tests/public-ready.test.ts` keeps this directory self-contained: it fails if source outside
`core/locales/` contains Chinese, if anything imports from outside `runner/`, or if the Runner imports
anything but `node:` built-ins.

## Layout

| Path | What it holds |
|---|---|
| `core/machine-daemon.mjs` | The Runner: server connection, heartbeat, task queue, process supervision, event delivery, session recovery, file delivery, self-update |
| `core/agent-kit/` | Helpers shared by several agents (config overlays, Claude Code stream parsing, Gemini API probing, Kimi Coding endpoints) |
| `core/*.mjs` | Peer-to-peer and relay file transfer, local preview gateway, local conversation store, artifact path parsing, tool-call summaries |
| `core/locales/` | `messages.zh.json` maps every English message template to the Chinese wording users currently see; `runner.{en,zh}.json` hold the preview pages and the local store's README |
| `adapters/index.mjs` | The agent registry, in probe and report order |
| `adapters/<agent>/index.mjs` | One agent: how to detect it, list its models, build its command line, parse its output, find its sessions, compact them and install it |
| `build/` | The bundler and its command line |
| `tests/` | Unit tests; `tests/node/` holds suites that need `node --test` (worker threads) |

## Adding an agent

1. Create `adapters/<agent>/index.mjs` exporting `create<Name>Adapter(ctx)`, and add it to
   `adapters/index.mjs`.
2. Return at least `id`, `label`, `executes`, `bin()` and `detect()`. `detect()` only reports whether
   the CLI is installed and its version; it must never run a login or account command. Add the other
   fields (`models`, `command`, `handler`, `session`, `compact`, `install`, …) only for what the agent
   really supports.
3. Use Runner capabilities only through `ctx` (process spawning, translation, config, tool server
   specification and so on). Import only `node:` built-ins and modules inside this directory, and use
   only `export function` / `export const` declarations, because the bundler supports exactly these.
4. Write every message in English through `ctx.t('Template with {name}', { name })` and add the
   template with its Chinese wording to `core/locales/messages.zh.json`.
5. Code that reads the agent's own session files goes into `create<Name>Files(io)` and is listed as
   `ownFiles`: the Runner runs it on its scan thread so slow disks never block the main thread.
6. Add tests under `tests/`, and verify on a real machine: a first turn, resuming the same native
   session on the second turn, cancelling, images, and compaction if the agent has it.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

Bug reports are welcome as GitHub issues. Please report security problems privately through GitHub
security advisories instead of a public issue.
