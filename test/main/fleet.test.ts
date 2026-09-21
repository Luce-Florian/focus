import test from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFleet, FleetError, type FleetConfig } from '../../src/main/fleet.ts';
import { Arbiter } from '../../src/main/arbiter.ts';
import type { ArbiterStore } from '../../src/main/db.ts';
import type { TmuxBridge } from '../../src/main/tmux.ts';
import type { HooksServer } from '../../src/main/hooks-server.ts';

function fakeStore(): ArbiterStore {
  return {
    insertSession() {},
    updateSessionState() {},
    logHookEvent() {},
    upsertQueue() {},
    deleteQueue() {},
    setSummary() {},
    deleteSession() {}
  };
}

interface FakeBridge {
  commands: { label: string; cwd: string; command: string }[];
  nextWindow: number;
  refuse: boolean;
}

function fakeBridge(): { bridge: FakeBridge; asTmux: TmuxBridge } {
  const b: FakeBridge = { commands: [], nextWindow: 1, refuse: false };
  const asTmux = {
    newSessionWindow: (spec: { label: string; cwd: string; command: string }) => {
      if (b.refuse) return Promise.reject(new Error('no server running'));
      b.commands.push(spec);
      const n = b.nextWindow++;
      return Promise.resolve({ windowId: `@${n}`, paneId: `%${n}` });
    },
    cli: () => Promise.resolve(undefined)
  } as unknown as TmuxBridge;
  return { bridge: b, asTmux };
}

async function withFleet(fn: (ctx: {
  fleet: ReturnType<typeof createFleet>;
  arbiter: Arbiter;
  bridge: FakeBridge;
  runDir: string;
}) => Promise<void>): Promise<void> {
  // The fleet's temp dir is managed here, not through `withTempDir`: that
  // helper is synchronous and would clean up before an awaiting test settles.
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-'));
  try {
    const runDir = path.join(dir, 'run');
    const cfg: FleetConfig = {
      RUN_DIR: runDir,
      HOOK_HOST: '127.0.0.1',
      HOOK_EVENTS: ['UserPromptSubmit'],
      SESSION_END_MARKER: '[fleet] session ended',
      MODELS: [{ id: '', label: 'défaut' }, { id: 'sonnet', label: 'Sonnet' }],
      SUMMARY_MODEL: 'haiku',
      SUMMARY_TIMEOUT_MS: 1000,
      SUMMARY_MAX_CHARS: 120,
      MAX_SESSIONS: 8
    };
    const arbiter = new Arbiter({ store: fakeStore() });
    const { bridge, asTmux } = fakeBridge();
    const hooks = { port: 42424, token: 'tok' } as unknown as HooksServer;
    const fleet = createFleet({
      cfg,
      bridge: asTmux,
      arbiter,
      hooks,
      claudeBin: '/usr/local/bin/claude',
      summarize: () => Promise.resolve('résumé')
    });
    await fn({ fleet, arbiter, bridge, runDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const uuid = '11111111-1111-4111-8111-111111111111';

void test('createSession launches with --session-id, the prompt positional and fresh hook URLs', async () => {
  await withFleet(async ({ fleet, arbiter, bridge, runDir }) => {
    const s = await fleet.createSession({ cwd: '/tmp', label: 'alpha', prompt: 'go', model: 'sonnet' });
    assert.ok(bridge.commands[0]);
    const cmd = bridge.commands[0].command;
    // The command is sh-quoted as a whole, so match words, not raw strings.
    assert.ok(cmd.includes('--session-id') && cmd.includes(s.uuid));
    assert.ok(cmd.includes('--model') && cmd.includes('sonnet'));
    assert.ok(cmd.includes('--settings'));
    // The prompt is the positional argument, after every option.
    assert.ok(cmd.indexOf("'go'") > cmd.indexOf('--settings'));
    // The hook URL in the settings file carries this boot's port.
    const settings = JSON.parse(readFileSync(s.settingsFile, 'utf8')) as {
      hooks: { UserPromptSubmit?: { hooks: { url: string }[] }[] };
    };
    assert.equal(
      settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.url,
      `http://127.0.0.1:42424/h/tok/${s.uuid}/UserPromptSubmit`
    );
    assert.equal(arbiter.get(s.uuid)?.summary, 'résumé');
    assert.ok(existsSync(path.join(runDir, `${s.uuid}.settings.json`)));
  });
});

void test('restoreSession resumes the same uuid with no prompt replay and no manual pick', async () => {
  await withFleet(async ({ fleet, arbiter, bridge }) => {
    const s = await fleet.restoreSession({
      uuid, label: 'alpha', cwd: '/tmp', model: 'sonnet',
      prompt: 'migrate the billing schema', summary: 'Migration du schéma de facturation'
    });
    assert.equal(s.uuid, uuid, 'the identity carries over, the pane is fresh');
    const cmd = bridge.commands[0]?.command ?? '';
    assert.ok(cmd.includes('--resume') && cmd.includes(uuid));
    assert.ok(!cmd.includes("'migrate the billing schema'"), 'the old prompt is never replayed');
    const rec = arbiter.get(uuid);
    assert.equal(rec?.summary, 'Migration du schéma de facturation', 'the tooltip survives');
    assert.equal(rec?.resumed, true);
    assert.equal(arbiter.focused, uuid, 'first restored session takes the floor on its own');
  });
});

void test('a restore whose directory is gone is refused and opens no window', async () => {
  await withFleet(async ({ fleet, bridge, runDir }) => {
    await assert.rejects(
      fleet.restoreSession({ uuid, label: 'alpha', cwd: '/no/such/dir', model: null, prompt: null, summary: null }),
      (err: unknown) => err instanceof FleetError && err.code === 'EBADCWD'
    );
    assert.equal(bridge.commands.length, 0);
    assert.ok(!existsSync(runDir), 'not even a run directory outlives the refusal');
  });
});

void test('a restore refused by tmux leaves no settings file behind', async () => {
  await withFleet(async ({ fleet, bridge, runDir }) => {
    bridge.refuse = true;
    await assert.rejects(
      fleet.restoreSession({ uuid, label: 'alpha', cwd: '/tmp', model: null, prompt: null, summary: null }),
      (err: unknown) => err instanceof FleetError && err.code === 'ETMUX'
    );
    assert.equal(readdirSync(runDir).length, 0);
  });
});
