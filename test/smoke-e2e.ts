/**
 * End-to-end smoke test without Electron: real tmux control mode, real HTTP
 * hook endpoint, real arbiter, real SQLite. Panes POST simulated Claude Code
 * hook payloads with curl, which exercises the exact URL-based join the app
 * uses in production.
 *
 *   node dist/test/smoke-e2e.js
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Arbiter } from '../src/main/arbiter.ts';
import { open } from '../src/main/db.ts';
import { startHooksServer } from '../src/main/hooks-server.ts';
import { writeSessionSettings } from '../src/main/session-settings.ts';
import { TmuxBridge } from '../src/main/tmux.ts';
import type { HookEventName } from '../src/shared/protocol.ts';

const HOST = '127.0.0.1';
const SOCKET = 'fleet-smoke';
const SESSION = 'smoke';
const HOOK_EVENTS: readonly HookEventName[] = ['SessionStart', 'PreToolUse', 'Notification', 'Stop'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function post(url: string, json: unknown): string {
  return `curl -sS -X POST -H 'content-type: application/json' -d ${shQuote(JSON.stringify(json))} ${shQuote(url)} >/dev/null`;
}

interface SessionSpec {
  readonly label: string;
  readonly script: readonly string[];
}

async function main(): Promise<void> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-smoke-'));
  const store = open(path.join(tmpdir, 'fleet.db'));
  const output = new Map<string, string>(); // paneId -> accumulated text

  const arbiter = new Arbiter({ store });
  const hooks = await startHooksServer({ host: HOST, onEvent: (e) => { arbiter.handleHook(e); } });

  const bridge = new TmuxBridge({ socket: SOCKET, session: SESSION });
  await bridge.createServer();
  bridge.attach();
  bridge.on('output', (paneId, bytes) => {
    output.set(paneId, (output.get(paneId) ?? '') + bytes.toString('utf8'));
  });
  bridge.on('window-closed', (w) => {
    const s = arbiter.byWindow(w);
    if (s) arbiter.markGone(s.uuid);
  });

  const url = (uuid: string, event: string) => `http://${HOST}:${hooks.port}/h/${hooks.token}/${uuid}/${event}`;

  const specs: readonly SessionSpec[] = [
    {
      label: 'alpha',
      script: [
        `echo 'ALPHA-BANNER'`,
        post(url('%UUID%', 'SessionStart'), { hook_event_name: 'SessionStart' }),
        post(url('%UUID%', 'PreToolUse'), { hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
        'sleep 3',
        post(url('%UUID%', 'Stop'), { hook_event_name: 'Stop' })
      ]
    },
    {
      label: 'beta',
      script: [
        `echo 'BETA-BANNER'`,
        post(url('%UUID%', 'SessionStart'), { hook_event_name: 'SessionStart' }),
        'sleep 1',
        post(url('%UUID%', 'Notification'), {
          hook_event_name: 'Notification',
          message: 'Claude needs your permission to use Bash'
        }),
        'sleep 3',
        post(url('%UUID%', 'PreToolUse'), { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
      ]
    }
  ];

  const uuids: Record<string, string> = {};
  for (const spec of specs) {
    const uuid = crypto.randomUUID();
    uuids[spec.label] = uuid;
    writeSessionSettings({
      runDir: tmpdir, uuid, host: HOST, port: hooks.port, token: hooks.token, events: HOOK_EVENTS
    });
    const body = spec.script.join('; ').replaceAll('%UUID%', uuid) + '; exec sleep 60';
    const { windowId, paneId } = await bridge.newSessionWindow({
      label: spec.label, cwd: tmpdir, command: `sh -c ${shQuote(body)}`
    });
    arbiter.register({ uuid, label: spec.label, cwd: tmpdir, paneId, windowId });
  }
  const alpha = uuids.alpha;
  const beta = uuids.beta;
  assert.ok(alpha && beta, 'both sessions registered');

  const checks: string[] = [];
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      checks.push(`  ok   ${name}`);
    } catch (err) {
      checks.push(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };

  await sleep(2200);
  check('a background worker loses the floor to a real claim', () => {
    assert.equal(arbiter.focused, beta, 'alpha only works, beta needs the human');
    assert.equal(arbiter.lastSwitch?.reason, 'permission');
  });

  await sleep(1600);
  check('a weaker claim does not take the floor back', () => {
    assert.equal(arbiter.focused, beta, 'alpha went idle, beta is still blocking');
    assert.deepEqual(arbiter.queue().map((s) => s.uuid), [alpha]);
  });

  await sleep(1800);
  check('answering hands the floor to the next best claim', () => {
    assert.equal(arbiter.focused, alpha);
    assert.equal(arbiter.queue().length, 0);
  });

  check('control mode streamed output from both panes', () => {
    const all = [...output.values()].join('');
    assert.match(all, /ALPHA-BANNER/);
    assert.match(all, /BETA-BANNER/, 'background window streams too');
  });

  check('events landed in sqlite', () => {
    const rows = store.recentEvents(50);
    const names = rows.map((r) => r.event);
    assert.ok(names.includes('Notification'), 'Notification persisted');
    assert.ok(names.includes('Stop'), 'Stop persisted');
  });

  check('send-keys reaches the focused pane', () => {
    assert.ok(arbiter.sessions.get(beta)?.paneId.startsWith('%'));
  });

  console.log('\n' + checks.join('\n') + '\n');

  await bridge.kill();
  hooks.server.close();
  store.close();
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
