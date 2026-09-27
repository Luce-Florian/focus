import test from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFleet } from '../../src/application/fleet.ts';
import { FleetError, type CreatedSession } from '../../src/application/use-cases/create-session.ts';
import type { AgentProfile, AgentRegistry, FleetConfig, HookSink, PaneMultiplexer } from '../../src/application/ports.ts';
import { Arbiter } from '../../src/domain/arbiter.ts';
import { IMPORTANCE } from '../../src/domain/attention.ts';
import type { SessionRepository } from '../../src/domain/ports.ts';

function fakeStore(): SessionRepository {
  return {
    insertSession() {},
    updateSessionState() {},
    logHookEvent() {},
    upsertQueue() {},
    deleteQueue() {},
    setSummary() {},
    setImportance() {},
    deleteSession() {}
  };
}

/**
 * A profile with the claude adapter's command-line shape but none of its
 * I/O: same flags, stub binary, deterministic summary. What is under test
 * is the use case's orchestration, not Claude Code.
 */
function fakeProfile(bin: string, summarize: (prompt: string) => Promise<string | null>): AgentProfile {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return {
    id: 'claude',
    label: 'Claude Code',
    models: () => [{ id: '', label: 'défaut' }, { id: 'sonnet', label: 'Sonnet' }],
    launch: ({ uuid, model, settingsFile, prompt }) => {
      const argv = [quote(bin), '--session-id', quote(uuid)];
      if (model) argv.push('--model', quote(model));
      argv.push('--settings', quote(settingsFile));
      if (prompt) argv.push(quote(prompt));
      return argv.join(' ');
    },
    resume: ({ uuid, model, settingsFile }) => {
      const argv = [quote(bin), '--resume', quote(uuid)];
      if (model) argv.push('--model', quote(model));
      argv.push('--settings', quote(settingsFile));
      return argv.join(' ');
    },
    // The same file shape the real adapter writes, so the URL check below
    // exercises the wiring rather than a stub's freedom.
    writeSettings: ({ runDir, uuid, host, port, token }) => {
      const url = `http://${host}:${port}/h/${token}/${uuid}/UserPromptSubmit`;
      const file = path.join(runDir, `${uuid}.settings.json`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ url }] }] } }));
      return file;
    },
    settingsFile: (runDir, uuid) => path.join(runDir, `${uuid}.settings.json`),
    settingsOwner: (fileName) => /^([0-9a-f-]{36})\.settings\.json$/.exec(fileName)?.[1] ?? null,
    summarize,
    translate: () => null
  };
}

interface FakeBridge {
  commands: { label: string; cwd: string; command: string }[];
  nextWindow: number;
  refuse: boolean;
}

function fakeBridge(): { bridge: FakeBridge; asPort: PaneMultiplexer } {
  const b: FakeBridge = { commands: [], nextWindow: 1, refuse: false };
  const asPort = {
    on: () => undefined,
    newSessionWindow: (spec: { label: string; cwd: string; command: string }) => {
      if (b.refuse) return Promise.reject(new Error('no server running'));
      b.commands.push(spec);
      const n = b.nextWindow++;
      return Promise.resolve({ windowId: `@${n}`, paneId: `%${n}` });
    },
    sendKeys: () => Promise.resolve(),
    setClientSize: () => Promise.resolve(),
    cli: () => Promise.resolve('')
  };
  return { bridge: b, asPort };
}

/**
 * A second agent, naming its settings file nothing like the first one: what
 * proves the tear-down goes through the port instead of spelling the claude
 * adapter's name out.
 */
function otherProfile(): AgentProfile {
  const file = (runDir: string, uuid: string): string => path.join(runDir, `codex-${uuid}.conf`);
  return {
    id: 'codex',
    label: 'Codex',
    models: () => [{ id: '', label: 'défaut' }],
    launch: ({ settingsFile }) => `codex --config ${settingsFile}`,
    resume: ({ settingsFile }) => `codex --resume --config ${settingsFile}`,
    writeSettings: ({ runDir, uuid }) => {
      mkdirSync(runDir, { recursive: true });
      const f = file(runDir, uuid);
      writeFileSync(f, '{}');
      return f;
    },
    settingsFile: file,
    settingsOwner: (fileName) => /^codex-([0-9a-f-]{36})\.conf$/.exec(fileName)?.[1] ?? null,
    summarize: () => Promise.resolve(null),
    translate: () => null
  };
}

const registry = (...profiles: readonly AgentProfile[]): AgentRegistry => ({
  get: (id) => profiles.find((p) => p.id === id),
  list: () => profiles
});

async function withFleet(fn: (ctx: {
  fleet: ReturnType<typeof createFleet>;
  arbiter: Arbiter;
  bridge: FakeBridge;
  runDir: string;
}) => Promise<void>, ...extra: readonly AgentProfile[]): Promise<void> {
  // The fleet's temp dir is managed here, not through `withTempDir`: that
  // helper is synchronous and would clean up before an awaiting test settles.
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-'));
  try {
    const runDir = path.join(dir, 'run');
    const cfg: FleetConfig = {
      RUN_DIR: runDir,
      SESSION_END_MARKER: '[fleet] session ended',
      MAX_SESSIONS: 8
    };
    const hooks: HookSink = { host: '127.0.0.1', port: 42424, token: 'tok' };
    const profile = fakeProfile('/usr/local/bin/claude', () => Promise.resolve('résumé'));
    const arbiter = new Arbiter({ store: fakeStore() });
    const { bridge, asPort } = fakeBridge();
    const fleet = createFleet({ cfg, multiplexer: asPort, arbiter, hooks, profiles: registry(profile, ...extra) });
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
    // The wrapper appends the fleet's own end marker, not the agent's.
    assert.ok(cmd.includes('session ended'));
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

void test('createSession defaults to normal importance and accepts an explicit level', async () => {
  await withFleet(async ({ fleet, arbiter }) => {
    const plain = await fleet.createSession({ cwd: '/tmp', label: 'alpha' });
    assert.equal(arbiter.get(plain.uuid)?.importance, IMPORTANCE.NORMAL);
    const high = await fleet.createSession({ cwd: '/tmp', label: 'beta', importance: IMPORTANCE.HIGH });
    assert.equal(arbiter.get(high.uuid)?.importance, IMPORTANCE.HIGH);
  });
});

void test('createSession records which agent a session runs', async () => {
  await withFleet(async ({ fleet, arbiter }) => {
    const s: CreatedSession = await fleet.createSession({ cwd: '/tmp', label: 'alpha' });
    assert.equal(s.agent, 'claude');
    assert.equal(arbiter.get(s.uuid)?.agent, 'claude');
  });
});

void test('an unknown agent is refused before anything is created', async () => {
  await withFleet(async ({ fleet, bridge }) => {
    await assert.rejects(
      () => fleet.createSession({ cwd: '/tmp', label: 'ghost', agent: 'codex' }),
      (err: unknown) => err instanceof FleetError && err.code === 'EAGENT'
    );
    assert.equal(bridge.commands.length, 0);
  });
});

void test('restoreSession resumes the same uuid with no prompt replay and no manual pick', async () => {
  await withFleet(async ({ fleet, arbiter, bridge }) => {
    const s = await fleet.restoreSession({
      uuid, label: 'alpha', cwd: '/tmp', agent: 'claude', model: 'sonnet',
      prompt: 'migrate the billing schema', summary: 'Migration du schéma de facturation',
      importance: IMPORTANCE.HIGH
    });
    assert.equal(s.uuid, uuid, 'the identity carries over, the pane is fresh');
    const cmd = bridge.commands[0]?.command ?? '';
    assert.ok(cmd.includes('--resume') && cmd.includes(uuid));
    assert.ok(!cmd.includes("'migrate the billing schema'"), 'the old prompt is never replayed');
    const rec = arbiter.get(uuid);
    assert.equal(rec?.summary, 'Migration du schéma de facturation', 'the tooltip survives');
    assert.equal(rec?.resumed, true);
    assert.equal(rec?.importance, IMPORTANCE.HIGH, 'the importance level survives');
    assert.equal(arbiter.focused, uuid, 'first restored session takes the floor on its own');
  });
});

void test('a restore whose directory is gone is refused and opens no window', async () => {
  await withFleet(async ({ fleet, bridge, runDir }) => {
    await assert.rejects(
      fleet.restoreSession({ uuid, label: 'alpha', cwd: '/no/such/dir', agent: 'claude', model: null, prompt: null, summary: null, importance: IMPORTANCE.NORMAL }),
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
      fleet.restoreSession({ uuid, label: 'alpha', cwd: '/tmp', agent: 'claude', model: null, prompt: null, summary: null, importance: IMPORTANCE.NORMAL }),
      (err: unknown) => err instanceof FleetError && err.code === 'ETMUX'
    );
    assert.equal(readdirSync(runDir).length, 0);
  });
});
void test('discarding a session removes the settings file its own agent named', async () => {
  await withFleet(async ({ fleet, runDir }) => {
    const s = await fleet.createSession({ cwd: '/tmp', label: 'beta', agent: 'codex', model: '' });
    assert.ok(existsSync(path.join(runDir, `codex-${s.uuid}.conf`)), 'the second agent wrote its own name');
    await fleet.discard(s.uuid);
    assert.deepEqual(readdirSync(runDir), [], 'no settings file outlives the discard');
  }, otherProfile());
});
