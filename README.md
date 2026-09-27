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
| 1 | `idle` | `Stop`, or a fresh pane: awaiting instructions | yes |
| 0 | `running` / `booting` | working on its own | never |
| -1 | `gone` / `failed` | `SessionEnd`, dead pane, or a launch that never joined | released at once |

Two invariants keep automatic switching from turning into flicker:

- **ties keep the incumbent** — a session already asking the human something is
  never preempted by an equal claim;
- **guards defer, never cancel** — recent typing (2.5 s), a recent switch
  (1.2 s) and a manual pick (10 s) all postpone the move; a timer
  replays the decision once the guard expires.

Everything that is not the foreground session is second-plane: a slim rail of
chips showing state, importance, queue rank and age.

### Importance

Each session also carries a human-assigned importance — `low`, `normal` (the
default) or `high` — set at creation and changeable at any time from its chip in
the rail. The ordering key becomes **class, then importance, then age of the
claim**:

- the attention class keeps absolute priority: importance only breaks ties
  *inside* a class, never across a boundary — a `high` `idle` session never
  overtakes a `normal` `waiting_perm` one, because a blocked permission weighs
  more than a finished turn;
- within one class, the more important session takes the foreground; an equal
  class with an equal importance still keeps the incumbent, so no ping-pong is
  introduced;
- changing the level of a live session re-decides at once, under the same
  guards as a hook — a sticky manual pick never yields to a mere bump.

The level is persisted in SQLite and survives a restart.

## Starting a session

The fleet starts empty. `+ session` asks for a working directory (any directory
on disk), an agent, a name, an optional initial prompt, a model and an
importance, then the `create-session` use case (`src/application/`) does the
same thing at runtime that it does at boot:

```
validate cwd → mint uuid → write settings → tmux new-window → register → focus
```

Each step undoes the previous one on failure, so a refused creation leaves no
tmux window, no settings file and no row. The initial prompt travels as
`claude`'s positional argument, not as replayed keystrokes.

The new session takes the foreground immediately, through the manual-pick path:
the human just asked for it, so no incoming claim preempts it.

The initial prompt is also summarised out of band — a detached `claude -p` with
every tool denied — into the one-line tooltip carried by the session chip. It
never delays the session, and it never receives the fleet's `--settings`: that
file would make it POST hook events under the session's identity.

## Restarting: the fleet comes back

Closing Focus kills the tmux server and, with it, every `claude` process. The
sessions that were alive at that moment are not lost: at the next boot the
fleet reads what survived in SQLite and relaunches each one with
`claude --resume <uuid>`, which reuses the original session id — verified, that
is what makes the hooks rejoin by URL routing alone, with no handshake.

```
purge gone/failed rows → list restorable sessions → resume each in a fresh pane
```

The rules keep the restore boring:

- **alive means restorable** — `running`, `idle`, `waiting_perm`,
  `waiting_input` come back; `gone` and `failed` rows are purged, and their
  settings files with them;
- **the settings file is rewritten** — the hook port and token change at every
  boot, so the old file's URLs would point at a dead endpoint;
- **no prompt replay** — the conversation resumes where it stopped, the session
  comes up `idle` ("reprise"), never `running`; its tooltip survives without a
  new summary pass;
- **a restore that cannot happen is skipped, not fatal** — a deleted directory,
  a retired model or a full fleet logs one line and the rest of the fleet still
  comes up. A resume that fails in the pane is caught by the ordinary
  marker → `failed` → discard pipeline.

The first restored session takes the foreground through the ordinary
`première session` path; the arbiter then re-evaluates as hooks arrive.

### Liveness comes from the pane, not from a hook

`SessionStart` never fires — verified against Claude Code 2.1.236, with the
hook declared both through `--settings` and through a project
`.claude/settings.json`. `UserPromptSubmit`, `Stop` and `SessionEnd` all
arrive. So the first hook of a session only lands once the human says
something, which is far too late to tell a live session from a dead one.

The pane itself is the signal, and the bridge already streams it:

- **first bytes drawn** — the process is up. With no initial prompt it becomes
  `idle` (it is waiting for its first instruction); with one, `running`.
- **`SESSION_END_MARKER` in the pane** — the wrapper prints it when Claude Code
  exits. Before the session ever drew anything that is a failed launch
  (`failed`); afterwards it is a normal end (`gone`). It is checked before the
  liveness signal, because a launch that fails prints its error and the marker
  in the same breath.
- **`BOOT_TIMEOUT_MS` (15 s)** — backstop only, for a launch that draws nothing
  at all and never exits.

A `failed` session has its window and its settings file taken down.

This is also what makes the workspace trust dialog survivable: an unapproved
directory makes Claude Code stop on a prompt without POSTing anything. The pane
draws it, the session goes `idle` with the dialog on screen, and the human
answers it — instead of being killed by a timer.

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
| language | TypeScript, strict | attention classes, hook payloads, tmux control-mode messages, the `contextBridge` API and SQLite rows are typed at every process boundary (`src/shared/protocol.ts`), not just documented |
| bundler | esbuild | three entry points — main (`esm`/node), preload (`cjs`/node), renderer (`iife`/browser) — plus one bundle per test file; `tsc` only type-checks, esbuild does the actual compile |
| linter | ESLint + typescript-eslint (`strictTypeChecked`, `stylisticTypeChecked`) | conventions enforced, not merely documented |
| terminal | xterm.js (`@xterm/xterm`) | one instance per pane, always live; inlined into the renderer bundle instead of loaded as a separate `<script>` |
| multiplexer | tmux 3.6, control mode | event stream instead of `capture-pane` polling |
| events | Claude Code HTTP hooks | POSTed to a loopback endpoint in the main process |
| storage | `node:sqlite` | built into Node 24, no native rebuild |
| tests | `node:test` | fake clock and fake timers for the state machine |
| packaging | electron-builder | one `dmg`, arm64, ad-hoc signed: the bundles plus `package.json`, no `node_modules` |
| versioning | release-please | the version comes out of the commit history, through a release pull request nobody has to edit |
| commits | commitlint + husky | Conventional Commits are what release-please reads, so they are checked at write time and again in CI |

## Commands

`make help` is the entry point and lists every command.

```
make build     # install dependencies, then compile every entry point with esbuild
make typecheck # tsc --noEmit, strict
make lint      # ESLint, typescript-eslint
make test      # arbiter state machine
make smoke     # end-to-end: real tmux, real HTTP hooks, real SQLite
make check     # typecheck + lint + test + smoke
make start     # launch the app
make package   # build the macOS disk image into release/ (arm64, ad-hoc signed)
make clean     # kill the POC tmux server, drop run artifacts, dist/ and release/
```

## Releasing

Versions are computed, never typed. Every commit landing on `main` is a
Conventional Commit; release-please accumulates them into a *release pull
request* that bumps `package.json` and writes `CHANGELOG.md`. Nothing is
published while that pull request stays open.

| step | where | result |
|---|---|---|
| `fix:` / `feat:` / `feat!:` on a pull request | `.github/workflows/check.yml` | patch / minor / major, decided by the history rather than by a human |
| push on `main` | `.github/workflows/release.yml` | the release pull request, kept up to date |
| merging it | same workflow | tag `vX.Y.Z`, GitHub Release, and `Focus-X.Y.Z-arm64.dmg` attached to it |

`make package` builds that same disk image locally, into `release/`.

The convention is enforced twice. `.husky/commit-msg` rejects a malformed
subject at write time — installed by `make install`, therefore skippable with
`--no-verify` or by a fresh clone. The `commits` job revalidates every commit
of a pull request, and that one is not skippable: a subject nobody parsed is a
version that never gets bumped.

### The disk image is not notarized

No Developer ID certificate is involved: electron-builder signs the bundle
ad-hoc, which is the minimum Apple Silicon requires for an application to
start at all. macOS still quarantines a downloaded image, so the first launch
goes through right click → *Ouvrir*, or once:

```
xattr -dr com.apple.quarantine /Applications/Focus.app
```

### Installed, the application no longer lives in the repository

Two things change when the code runs from a read-only `app.asar` instead of a
checkout, both handled in `src/infrastructure/electron/main.ts`:

- **`run/` moves to `userData`** — `~/Library/Application Support/Focus/run`
  holds the per-session settings files and `fleet.db`, because nothing can be
  written next to the bundle;
- **`PATH` comes from the login shell** — an application launched from the
  Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`, where neither `tmux` nor
  `claude` is found. It is read once at startup, packaged builds only.

## Layout

Hexagonal: the domain is pure, the application composes use cases over ports,
the infrastructure holds every adapter, and `shared/protocol.ts` is the only
facade the UI ever imports. ESLint enforces the boundary (`no-restricted-imports`)
rather than merely documenting it.

```
.
├── Makefile                  entry point for every command (make help)
├── CLAUDE.md -> README.md    project memory, same file
├── tsconfig.json              strict TypeScript config (noEmit: esbuild compiles)
├── eslint.config.js           typescript-eslint strictTypeChecked + stylisticTypeChecked + layer boundaries
├── electron-builder.yml       macOS packaging: what ships, ad-hoc signature, dmg name
├── commitlint.config.js       Conventional Commits, the input of the version bump
├── release-please-config.json  release type and changelog, plus its version manifest
├── .husky/commit-msg          local half of the commit convention
├── .github/workflows/
│   ├── check.yml               make check on every pull request, plus commitlint
│   └── release.yml             release pull request, then tag and dmg on merge
├── scripts/
│   └── build.mjs               esbuild: main, preload, renderer and test bundles
├── src/
│   ├── domain/                pure core, zero infrastructure imports
│   │   ├── attention.ts        attention classes, importance, session states
│   │   ├── agent.ts           AgentId, normalised AgentEvent, hook payload shapes
│   │   ├── session.ts         SessionRecord, snapshots as the UI sees them
│   │   ├── ports.ts           SessionRepository, clock, scheduler
│   │   └── arbiter.ts         the focus policy and its guards
│   ├── application/           use cases over ports
│   │   ├── ports.ts           PaneMultiplexer, HookSink, AgentProfile, AgentRegistry
│   │   ├── fleet.ts           orchestrator composing the use cases
│   │   └── use-cases/
│   │       ├── create-session.ts    validate → settings → pane → register → focus
│   │       ├── restore-fleet.ts     purge → resume what survived, skip the impossible
│   │       ├── observe-pane-output.ts  liveness: end marker vs first bytes
│   │       ├── handle-agent-event.ts   raw hook → profile translation → arbiter
│   │       ├── discard-session.ts  tear down a launch that never came up
│   │       └── set-importance.ts  persist and re-decide the level
│   ├── infrastructure/        adapters
│   │   ├── tmux/tmux-bridge.ts      control mode bridge, octal decoder, send-keys
│   │   ├── hooks/hook-server.ts     loopback hook endpoint, identity from the URL
│   │   ├── sqlite/store.ts          SQLite schema and queries
│   │   ├── agents/claude/           the Claude Code adapter: command lines,
│   │   │                            settings file, hook translation, models, summary
│   │   ├── electron/main.ts         composition root: adapters meet ports, IPC
│   │   └── config.ts               paths, tmux socket, fleet limits
│   ├── shared/
│   │   └── protocol.ts        UI facade: contextBridge contract, re-exports domain
│   ├── preload.ts             contextBridge: state, output, input, focus, importance
│   └── renderer/              topbar, full-bleed terminal, second-plane rail
├── test/
│   ├── domain/                attention and arbiter state machine, fake clock
│   ├── application/           use cases over fake ports and fake profiles
│   ├── infrastructure/        one *.test.ts per adapter
│   ├── helpers/               shared temp-directory cleanup
│   └── smoke-e2e.ts           full stack without Electron
├── dist/                      generated: esbuild output, gitignored
├── run/                      generated: settings files, fleet.db
└── workspaces/               leftover POC sandboxes, no longer wired in
```

### Adding another agent

Everything agent-specific lives behind the `AgentProfile` port
(`src/application/ports.ts`): resolve the binary, build the launch and resume
command lines, write the per-session settings file — *and* name it, so a
failed launch and the boot sweep can take it down without knowing the
scheme — summarise a prompt, and translate that agent's raw events into the
domain's normalised `AgentEvent`.
Supporting Codex or opencode means writing one folder under
`src/infrastructure/agents/` and adding one line to the composition root in
`src/infrastructure/electron/main.ts` — no domain, use case or store change.
The session row already carries its `agent` column, so a session created with
one agent is restored with the same one.

SQLite (`run/fleet.db`) holds the session registry, the current claims and an
append-only `hook_events` log. Electron owns the tmux lifecycle: every launch
relaunches the sessions that were alive at the previous shutdown, the event log
survives.

`src/infrastructure/config.ts` no longer declares the sessions themselves —
`SESSIONS` is an optional seed, empty by default. It holds the fleet's limits
instead: `MAX_SESSIONS`, `BOOT_TIMEOUT_MS`, `SESSION_END_MARKER`. The models
offered at creation and the summary settings are the claude adapter's business
(`src/infrastructure/agents/claude/models.ts`).
