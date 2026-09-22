/**
 * End-to-end smoke test without Electron: real tmux control mode, real HTTP
 * hook endpoint, real arbiter, real SQLite, and the real session factory.
 *
 * Sessions are created the way the user interface creates them — through
 * `createFleet().createSession()` — against a stub standing in for the
 * `claude` binary. The stub reads the very arguments the factory builds
 * (`--session-id`, `--settings`, `--model`, the positional prompt), so the
 * command line is exercised rather than assumed.
 *
 *   node dist/test/smoke-e2e.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Arbiter } from '../src/main/arbiter.ts';
import { open } from '../src/main/db.ts';
import { createFleet, type FleetConfig } from '../src/main/fleet.ts';
import { startHooksServer } from '../src/main/hooks-server.ts';
import { TmuxBridge } from '../src/main/tmux.ts';
import { IMPORTANCE, type HookEventName } from '../src/shared/protocol.ts';

const HOST = '127.0.0.1';
const SOCKET = 'fleet-smoke';
const SESSION = 'smoke';
const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
];
const BOOT_TIMEOUT_MS = 1500;
const END_MARKER = '[fleet] session ended';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stub `claude`. It parses the factory's own command line, then plays the
 * scenario named by the positional prompt.
 */
function writeFakeClaude(dir: string, base: string): string {
  const file = path.join(dir, 'fake-claude');
  fs.writeFileSync(
    file,
    `#!/bin/sh
uuid=""; model=""; settings=""; prompt=""; resumed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) uuid="$2"; shift 2 ;;
    --resume)     uuid="$2"; resumed=1; shift 2 ;;
    --settings)   settings="$2"; shift 2 ;;
    --model)      model="$2"; shift 2 ;;
    *)            prompt="$1"; shift ;;
  esac
done

post() {
  curl -sS -X POST -H 'content-type: application/json' -d "$2" "${base}/$uuid/$1" >/dev/null
}

case "$prompt" in
  scenario-mute)
    # Draws nothing and never exits: only the boot backstop can catch it.
    sleep 60 ;;
  scenario-crash)
    # Exits at once; the wrapper prints the end marker.
    exit 1 ;;
esac

echo "UUID=$uuid MODEL=$model PROMPT=$prompt"
[ -f "$settings" ] && echo "SETTINGS-OK"
[ "$resumed" = 1 ] && echo "RESUME-BANNER"

case "$prompt" in
  scenario-alpha)
    echo 'ALPHA-BANNER'
    post SessionStart '{"hook_event_name":"SessionStart"}'
    post PreToolUse '{"hook_event_name":"PreToolUse","tool_name":"Bash"}'
    sleep 3
    post Stop '{"hook_event_name":"Stop"}'
    ;;
  scenario-beta)
    echo 'BETA-BANNER'
    post SessionStart '{"hook_event_name":"SessionStart"}'
    sleep 1
    post Notification '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}'
    sleep 3
    post PreToolUse '{"hook_event_name":"PreToolUse","tool_name":"Bash"}'
    ;;
esac
sleep 60
`
  );
  fs.chmodSync(file, 0o755);
  return file;
}

async function main(): Promise<void> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-smoke-'));
  const workdir = path.join(tmpdir, 'work');
  fs.mkdirSync(workdir);
  const store = open(path.join(tmpdir, 'fleet.db'));
  const output = new Map<string, string>(); // paneId -> accumulated text

  const arbiter = new Arbiter({ store, options: { bootTimeoutMs: BOOT_TIMEOUT_MS } });
  const hooks = await startHooksServer({
    host: HOST,
    onEvent: (e) => {
      arbiter.handleHook(e);
    }
  });

  const bridge = new TmuxBridge({ socket: SOCKET, session: SESSION });
  await bridge.createServer();
  bridge.attach();

  // `MAX_SESSIONS` is read at call time so the ceiling check below can move it.
  const cfg: { -readonly [K in keyof FleetConfig]: FleetConfig[K] } = {
    RUN_DIR: tmpdir,
    HOOK_HOST: HOST,
    HOOK_EVENTS,
    SESSION_END_MARKER: END_MARKER,
    MAX_SESSIONS: 8,
    MODELS: [
      { id: '', label: 'défaut' },
      { id: 'sonnet', label: 'Sonnet' }
    ],
    SUMMARY_MODEL: 'haiku',
    SUMMARY_TIMEOUT_MS: 5000,
    SUMMARY_MAX_CHARS: 120
  };

  const summarised: string[] = [];
  const fleet = createFleet({
    cfg,
    bridge,
    arbiter,
    hooks,
    claudeBin: writeFakeClaude(tmpdir, `http://${HOST}:${hooks.port}/h/${hooks.token}`),
    // The out-of-band pass is stubbed: the smoke proves the wiring, not the model.
    summarize: ({ prompt }) => {
      summarised.push(prompt);
      return Promise.resolve(`RÉSUMÉ ${prompt}`);
    }
  });

  bridge.on('output', (paneId, bytes) => {
    output.set(paneId, (output.get(paneId) ?? '') + bytes.toString('utf8'));
    fleet.observeOutput(paneId, bytes);
  });
  bridge.on('window-closed', (w) => {
    const s = arbiter.byWindow(w);
    if (s) arbiter.markGone(s.uuid);
  });
  arbiter.on('failed', ({ uuid }) => {
    fleet.discard(uuid).catch((err: unknown) => {
      console.error('[fleet] discard', err instanceof Error ? err.message : err);
    });
  });

  const checks: string[] = [];
  const record = (name: string, err?: unknown) => {
    if (err === undefined) {
      checks.push(`  ok   ${name}`);
      return;
    }
    checks.push(`  FAIL ${name}\n       ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    process.exitCode = 1;
  };
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      record(name);
    } catch (err: unknown) {
      record(name, err);
    }
  };
  const acheck = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      record(name);
    } catch (err: unknown) {
      record(name, err);
    }
  };

  const windowCount = async (): Promise<number> =>
    (await bridge.cli(['list-windows', '-t', SESSION, '-F', '#{window_id}'])).split('\n').filter(Boolean).length;

  // ---- runtime creation, the way the interface does it ----

  const alpha = await fleet.createSession({
    cwd: workdir,
    label: 'alpha',
    prompt: 'scenario-alpha',
    model: 'sonnet'
  });
  const beta = await fleet.createSession({ cwd: workdir, label: 'beta', prompt: 'scenario-beta', model: '' });
  arbiter.setImportance(alpha.uuid, IMPORTANCE.HIGH);

  check('a session created at runtime is registered and takes the floor', () => {
    assert.equal(arbiter.focused, beta.uuid, 'the human just asked for this one');
    assert.equal(arbiter.live().length, 2);
    assert.ok(fs.existsSync(path.join(tmpdir, `${alpha.uuid}.settings.json`)));
  });

  // Put alpha on screen, then drop the guards the manual pick just armed: what
  // the next assertions observe is the focus policy itself, nothing else.
  arbiter.focus(alpha.uuid);
  arbiter.clearGuards();

  await sleep(2200);
  check('a background worker loses the floor to a real claim', () => {
    assert.equal(arbiter.focused, beta.uuid, 'alpha only works, beta needs the human');
    assert.equal(arbiter.lastSwitch?.reason, 'permission');
  });

  await sleep(1600);
  check('a weaker claim does not take the floor back', () => {
    assert.equal(arbiter.focused, beta.uuid, 'alpha went idle, beta is still blocking');
    assert.deepEqual(
      arbiter.queue().map((s) => s.uuid),
      [alpha.uuid]
    );
  });

  await sleep(1800);
  check('answering hands the floor to the next best claim', () => {
    assert.equal(arbiter.focused, alpha.uuid);
    assert.equal(arbiter.queue().length, 0);
  });

  check('control mode streamed output from both panes', () => {
    const all = [...output.values()].join('');
    assert.match(all, /ALPHA-BANNER/);
    assert.match(all, /BETA-BANNER/, 'background window streams too');
  });

  check('the factory command line reached the binary intact', () => {
    const all = [...output.values()].join('');
    assert.match(all, new RegExp(`UUID=${alpha.uuid} MODEL=sonnet PROMPT=scenario-alpha`));
    assert.match(all, /SETTINGS-OK/, 'the per-session settings file exists at launch');
  });

  check('the initial prompt is summarised out of band', () => {
    assert.deepEqual([...summarised].sort(), ['scenario-alpha', 'scenario-beta']);
    const s = arbiter.snapshot().sessions.find((x) => x.uuid === alpha.uuid);
    assert.equal(s?.summary, 'RÉSUMÉ scenario-alpha');
    assert.equal(s?.model, 'sonnet');
  });

  check('events landed in sqlite', () => {
    const names = store.recentEvents(50).map((r) => r.event);
    assert.ok(names.includes('Notification'), 'Notification persisted');
    assert.ok(names.includes('Stop'), 'Stop persisted');
  });

  // ---- refusals leave nothing behind ----

  await acheck('an unusable working directory is refused before anything is created', async () => {
    const before = await windowCount();
    await assert.rejects(
      () => fleet.createSession({ cwd: path.join(tmpdir, 'nope'), label: 'ghost' }),
      (err: Error & { code?: string }) => err.code === 'EBADCWD'
    );
    assert.equal(await windowCount(), before, 'no tmux window');
    assert.equal(arbiter.live().length, 2, 'no row');
  });

  await acheck('an unknown model is refused', async () => {
    await assert.rejects(
      () => fleet.createSession({ cwd: workdir, label: 'ghost', model: 'not-a-model' }),
      (err: Error & { code?: string }) => err.code === 'EMODEL'
    );
  });

  // ---- launches that never come up ----

  const expectTornDown = (name: string, prompt: string, waitMs: number) =>
    acheck(name, async () => {
      const before = await windowCount();
      const ghost = await fleet.createSession({ cwd: workdir, label: 'ghost', prompt });
      const settingsFile = path.join(tmpdir, `${ghost.uuid}.settings.json`);
      assert.equal(await windowCount(), before + 1);
      assert.ok(fs.existsSync(settingsFile));

      await sleep(waitMs);
      assert.equal(arbiter.get(ghost.uuid), null, 'the row is gone');
      assert.equal(await windowCount(), before, 'the tmux window is gone');
      assert.ok(!fs.existsSync(settingsFile), 'the settings file is gone');
      assert.notEqual(arbiter.focused, ghost.uuid, 'the floor moved on');
    });

  await expectTornDown('a launch that exits at once is torn down, window and file', 'scenario-crash', 1500);
  await expectTornDown(
    'a launch that draws nothing at all trips the boot backstop',
    'scenario-mute',
    BOOT_TIMEOUT_MS + 1200
  );

  // ---- the ceiling ----

  await acheck('the fleet refuses to grow past its ceiling', async () => {
    cfg.MAX_SESSIONS = arbiter.live().length;
    await assert.rejects(
      () => fleet.createSession({ cwd: workdir, label: 'overflow' }),
      (err: Error & { code?: string }) => err.code === 'EFULL'
    );
  });

  // ---- normal end of life ----

  check('SessionEnd removes a session created at runtime', () => {
    arbiter.handleHook({ uuid: beta.uuid, event: 'SessionEnd', payload: {} });
    assert.equal(arbiter.get(beta.uuid)?.state, 'gone');
    assert.equal(arbiter.live().length, 1);
    assert.notEqual(arbiter.focused, beta.uuid);
  });

  check('send-keys reaches the focused pane', () => {
    assert.ok(arbiter.get(alpha.uuid)?.paneId.startsWith('%'));
  });

  // ---- restart: what was alive comes back ----

  // Counted before the restart: the restore path never re-summarises.
  const summarisedBefore = summarised.length;
  await bridge.kill();
  hooks.server.close();
  store.close();

  const store2 = open(path.join(tmpdir, 'fleet.db'));
  store2.purge();
  const arbiter2 = new Arbiter({ store: store2, options: { bootTimeoutMs: BOOT_TIMEOUT_MS } });
  const hooks2 = await startHooksServer({
    host: HOST,
    onEvent: (e) => {
      arbiter2.handleHook(e);
    }
  });
  const bridge2 = new TmuxBridge({ socket: SOCKET, session: SESSION });
  await bridge2.createServer();
  bridge2.attach();
  const fleet2 = createFleet({
    cfg,
    bridge: bridge2,
    arbiter: arbiter2,
    hooks: hooks2,
    claudeBin: writeFakeClaude(tmpdir, `http://${HOST}:${hooks2.port}/h/${hooks2.token}`)
  });
  const output2 = new Map<string, string>();
  bridge2.on('output', (paneId, bytes) => {
    output2.set(paneId, (output2.get(paneId) ?? '') + bytes.toString('utf8'));
    fleet2.observeOutput(paneId, bytes);
  });
  bridge2.on('window-closed', (w) => {
    const s = arbiter2.byWindow(w);
    if (s) arbiter2.markGone(s.uuid);
  });

  check('only the sessions alive at shutdown are restorable', () => {
    // alpha went idle after its turn; beta ended and was purged.
    assert.deepEqual(
      store2.listRestorable().map((r) => r.uuid),
      [alpha.uuid]
    );
  });

  const [restorable] = store2.listRestorable();
  assert.ok(restorable, 'alpha survived the purge');
  const restored = await fleet2.restoreSession(restorable);

  check('a restored session keeps its uuid and takes the floor on its own', () => {
    assert.equal(restored.uuid, alpha.uuid);
    assert.equal(arbiter2.focused, alpha.uuid, 'première session, no manual pick armed');
  });

  await sleep(1200);
  check('the resumed conversation comes up idle, not working', () => {
    const s = arbiter2.get(alpha.uuid);
    assert.equal(s?.state, 'idle', 'it waits for its next instruction');
    assert.equal(s?.reason, 'reprise');
    assert.equal(arbiter2.live().length, 1);
  });

  check('the importance level survives a full restart', () => {
    assert.equal(arbiter2.get(alpha.uuid)?.importance, IMPORTANCE.HIGH);
    const s = arbiter2.snapshot().sessions.find((x) => x.uuid === alpha.uuid);
    assert.equal(s?.importance, IMPORTANCE.HIGH, 'the renderer sees the level too');
  });

  check('the resume command line reached the binary intact', () => {
    // The stub only prints RESUME-BANNER when it saw --resume with the uuid.
    const all = [...output2.values()].join('');
    assert.match(all, /RESUME-BANNER/);
    assert.match(all, new RegExp(`UUID=${alpha.uuid} MODEL=sonnet PROMPT=\\s`), 'resumed, no prompt replay');
  });

  check('the restored settings file points at this boot\'s hook port', () => {
    const settings = fs.readFileSync(path.join(tmpdir, `${alpha.uuid}.settings.json`), 'utf8');
    assert.ok(settings.includes(`:${hooks2.port}/`), `hook URL rebuilt for port ${hooks2.port}`);
  });

  check('the restored session keeps its tooltip without re-summarising', () => {
    assert.equal(summarised.length, summarisedBefore, 'no summary pass on the restore path');
    const s = arbiter2.snapshot().sessions.find((x) => x.uuid === alpha.uuid);
    assert.equal(s?.summary, 'RÉSUMÉ scenario-alpha', 'the summary survived the restart');
    assert.equal(s?.model, 'sonnet');
  });

  console.log('\n' + checks.join('\n') + '\n');

  await bridge2.kill();
  hooks2.server.close();
  store2.close();
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
