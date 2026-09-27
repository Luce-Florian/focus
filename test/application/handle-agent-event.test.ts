import test from 'node:test';
import assert from 'node:assert';

import { createHandleAgentEvent } from '../../src/application/use-cases/handle-agent-event.ts';
import { Arbiter } from '../../src/domain/arbiter.ts';
import type { AgentProfile, AgentRegistry } from '../../src/application/ports.ts';
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

interface Seen {
  event: string;
  payload: unknown;
}

function profileFor(id: 'claude' | 'codex', seen: Seen[]): AgentProfile {
  return {
    id,
    label: id,
    models: () => [],
    launch: () => 'true',
    resume: () => 'true',
    writeSettings: () => '/dev/null',
    settingsFile: () => '/dev/null',
    settingsOwner: () => null,
    summarize: () => Promise.resolve(null),
    // Only one event, on purpose: the test asserts which profile translated.
    translate: (event, payload) => {
      seen.push({ event, payload });
      return event === `${id}-stop` ? { kind: 'stop', reason: 'tour terminé' } : null;
    }
  };
}

function registry(profiles: readonly AgentProfile[]): AgentRegistry {
  return { get: (id) => profiles.find((p) => p.id === id), list: () => [...profiles] };
}

function setup(profiles: readonly AgentProfile[]) {
  const arbiter = new Arbiter({ store: fakeStore() });
  const handle = createHandleAgentEvent({ arbiter, profiles: registry(profiles), fallback: 'claude' });
  return { arbiter, handle };
}

void test('a hook is translated by the profile of the session that received it', () => {
  const claudeSeen: Seen[] = [];
  const codexSeen: Seen[] = [];
  const { arbiter, handle } = setup([profileFor('claude', claudeSeen), profileFor('codex', codexSeen)]);

  arbiter.register({ uuid: 'c1', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  arbiter.register({ uuid: 'x1', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2', agent: 'codex' });

  handle({ uuid: 'c1', event: 'claude-stop', payload: {} });
  handle({ uuid: 'x1', event: 'codex-stop', payload: {} });

  assert.deepEqual(claudeSeen.map((s) => s.event), ['claude-stop']);
  assert.deepEqual(codexSeen.map((s) => s.event), ['codex-stop']);
  assert.equal(arbiter.get('c1')?.state, 'idle');
  assert.equal(arbiter.get('x1')?.state, 'idle');
});

void test('an untranslatable hook is logged and ignored, never fatal', () => {
  const claudeSeen: Seen[] = [];
  const { arbiter, handle } = setup([profileFor('claude', claudeSeen)]);

  arbiter.register({ uuid: 'c1', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  handle({ uuid: 'c1', event: 'SomeFutureEvent', payload: { x: 1 } });

  assert.deepEqual(claudeSeen.map((s) => s.event), ['SomeFutureEvent']);
  assert.equal(arbiter.get('c1')?.state, 'booting', 'no recognised event, no state change');
  assert.equal(arbiter.get('c1')?.lastEvent, 'SomeFutureEvent');
});

void test('a hook for an unknown session still reaches the fallback profile and reports an orphan', () => {
  const claudeSeen: Seen[] = [];
  const { arbiter, handle } = setup([profileFor('claude', claudeSeen)]);
  const orphans: { uuid: string; event: string }[] = [];
  arbiter.on('orphan', (o) => orphans.push(o));

  handle({ uuid: 'zzz', event: 'claude-stop', payload: {} });

  assert.deepEqual(claudeSeen.map((s) => s.event), ['claude-stop'], 'the fallback profile translated it');
  assert.deepEqual(orphans, [{ uuid: 'zzz', event: 'claude-stop' }]);
});