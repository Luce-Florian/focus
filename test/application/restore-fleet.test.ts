import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRestoreFleet } from '../../src/application/use-cases/restore-fleet.ts';
import type { AgentProfile, AgentRegistry, FleetConfig, FleetStore, HookSink, PaneMultiplexer } from '../../src/application/ports.ts';
import { Arbiter } from '../../src/domain/arbiter.ts';
import type { SessionRepository } from '../../src/domain/ports.ts';

const ALIVE = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';

function fakeStore(): FleetStore {
  const repo: SessionRepository = {
    insertSession() {},
    updateSessionState() {},
    logHookEvent() {},
    upsertQueue() {},
    deleteQueue() {},
    setSummary() {},
    setImportance() {},
    deleteSession() {}
  };
  // Nothing to bring back: what is under test is the sweep that runs after.
  return { ...repo, listRestorable: () => [], purge() {}, close() {} };
}

/** Two agents, two naming schemes, neither of them the sweep's business. */
function profile(id: 'claude' | 'codex', name: (uuid: string) => string, owner: RegExp): AgentProfile {
  return {
    id,
    label: id,
    models: () => [],
    launch: () => 'true',
    resume: () => 'true',
    writeSettings: ({ runDir, uuid }) => path.join(runDir, name(uuid)),
    settingsFile: (runDir, uuid) => path.join(runDir, name(uuid)),
    settingsOwner: (fileName) => owner.exec(fileName)?.[1] ?? null,
    summarize: () => Promise.resolve(null),
    translate: () => null
  };
}

const profiles: AgentRegistry = (() => {
  const list = [
    profile('claude', (u) => `${u}.settings.json`, /^([0-9a-f-]{36})\.settings\.json$/),
    profile('codex', (u) => `codex-${u}.conf`, /^codex-([0-9a-f-]{36})\.conf$/)
  ];
  return { get: (id) => list.find((p) => p.id === id), list: () => list };
})();

const multiplexer = {
  on: () => undefined,
  newSessionWindow: () => Promise.reject(new Error('no session is restored here')),
  sendKeys: () => Promise.resolve(),
  setClientSize: () => Promise.resolve(),
  cli: () => Promise.resolve('')
} as unknown as PaneMultiplexer;

void test('the boot sweep drops orphan settings files, whichever agent named them', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'restore-'));
  try {
    const runDir = path.join(dir, 'run');
    mkdirSync(runDir, { recursive: true });
    for (const f of [`${ALIVE}.settings.json`, `${GONE}.settings.json`, `codex-${GONE}.conf`, 'fleet.db']) {
      writeFileSync(path.join(runDir, f), '{}');
    }

    const cfg: FleetConfig = { RUN_DIR: runDir, SESSION_END_MARKER: '[fleet] session ended', MAX_SESSIONS: 8 };
    const hooks: HookSink = { host: '127.0.0.1', port: 42424, token: 'tok' };
    const arbiter = new Arbiter({ store: fakeStore() });
    arbiter.register({ uuid: ALIVE, label: 'alpha', cwd: '/tmp', paneId: '%1', windowId: '@1', agent: 'claude' });

    await createRestoreFleet({ cfg, store: fakeStore(), arbiter, multiplexer, hooks, profiles })();

    assert.deepEqual(
      readdirSync(runDir).sort(),
      [`${ALIVE}.settings.json`, 'fleet.db'].sort(),
      'the live session keeps its file, fleet.db is not a settings file at all'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
