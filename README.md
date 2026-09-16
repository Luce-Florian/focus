# poc-tmux — attention arbiter

Electron shell driving several Claude Code sessions, each in its own tmux pane.
The human never navigates: an arbiter decides which session is on screen, and
the view follows whichever one actually needs a human right now.

## Focus policy

Each session carries an *attention class*. The foreground always shows the
highest one, and switches on its own.

| class | state | meaning | foreground |
|---|---|---|---|
| 3 | `waiting_perm` | Notification: blocking permission prompt | yes |
| 2 | `waiting_input` | Notification: idle nudge | yes |
| 1 | `idle` | `Stop`: turn finished, awaiting instructions | yes |
| 0 | `running` / `booting` | working on its own | never |
| -1 | `gone` | `SessionEnd` or dead pane | released at once |

Two invariants keep automatic switching from turning into flicker:

- **ties keep the incumbent** — a session already asking the human something is
  never preempted by an equal claim;
- **guards defer, never cancel** — recent typing (2.5 s), a recent switch
  (1.2 s), a manual pick (10 s) and the pin all postpone the move; a timer
  replays the decision once the guard expires.

Everything that is not the foreground session is second-plane: a slim rail of
chips showing state, queue rank and age.

## How a Claude session joins a tmux pane

The main process mints the session uuid **before** the pane exists:

```
claude --session-id <uuid> --settings run/<uuid>.settings.json
```

That settings file declares HTTP hooks whose URL already carries the identity —
`http://127.0.0.1:<port>/h/<token>/<uuid>/<Event>`. Joining is URL routing: no
registration handshake, no race.

HTTP hooks are POSTed by Claude Code itself, so no subprocess is spawned and
`$TMUX_PANE` is never inherited — it cannot serve as the join key.

`--settings` merges on top of the user's own configuration: nothing here leaks
into Claude Code outside the fleet. The file also pins
`permissions.defaultMode: "default"` for these sessions only, otherwise
permission prompts never fire and there is nothing to arbitrate.

## tmux

Dedicated server (`-L fleet-poc`, `-f /dev/null`), one window per session.
Control mode (`tmux -C attach-session`) runs over plain pipes, no pty. It
streams `%output` for background windows too, so every pane keeps rendering and
a focus change is a visibility toggle rather than a replay.

`%output` escapes non-printable bytes as three-digit octal and passes bytes
`>= 0x80` through raw: the stream is read as latin1, then decoded to bytes.
Input travels back as `send-keys -H <hex>` — no quoting, no key-name
interpretation.

## Stack

| piece | choice | why |
|---|---|---|
| shell | Electron 44 (Node 24) | one window, terminals plus arbiter UI |
| terminal | xterm.js (`@xterm/xterm`), UMD, no bundler | one instance per pane, always live |
| multiplexer | tmux 3.6, control mode | event stream instead of `capture-pane` polling |
| events | Claude Code HTTP hooks | POSTed to a loopback endpoint in the main process |
| storage | `node:sqlite` | built into Node 24, no native rebuild |
| tests | `node:test` | fake clock and fake timers for the state machine |

## Commands

`make help` is the entry point and lists every command.

```
make build    # install dependencies, then check every source file
make lint     # parse every JS source file
make test     # arbiter state machine
make smoke    # end-to-end: real tmux, real HTTP hooks, real SQLite
make check    # lint + test + smoke
make start    # launch the app
make clean    # kill the POC tmux server, drop run artifacts
```

## Layout

```
.
├── Makefile                  entry point for every command (make help)
├── CLAUDE.md -> README.md    project memory, same file
├── src/
│   ├── main/
│   │   ├── index.js          Electron main: wires bridge, hooks, arbiter, IPC
│   │   ├── arbiter.js        attention classes, focus policy, guards
│   │   ├── tmux.js           control mode bridge, octal decoder, send-keys
│   │   ├── hooks-server.js   loopback hook endpoint, identity from the URL
│   │   ├── session-settings.js  per-session `--settings` file generator
│   │   ├── db.js             SQLite schema and queries
│   │   └── config.js         sessions, paths, tmux socket, hook events
│   ├── preload.js            contextBridge: state, output, input, focus, pin
│   └── renderer/             topbar, full-bleed terminal, second-plane rail
├── test/
│   ├── arbiter.test.js       state machine, injected clock and timers
│   └── smoke-e2e.js          full stack without Electron
├── run/                      generated: settings files, fleet.db
└── workspaces/{alpha,beta}/  working directory of each Claude session
```

SQLite (`run/fleet.db`) holds the session registry, the current claims and an
append-only `hook_events` log. Electron owns the tmux lifecycle: every launch
starts from a clean fleet, the event log survives.

Sessions and working directories are declared in `src/main/config.js`.
