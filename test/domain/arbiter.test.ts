import test from 'node:test';
import assert from 'node:assert';

import { Arbiter } from '../../src/domain/arbiter.ts';
import type { AgentEvent } from '../../src/domain/agent.ts';
import { IMPORTANCE, STATES } from '../../src/domain/attention.ts';
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

interface FakeTimer {
  fn: () => void;
  at: number;
}

interface Guards {
  typingGraceMs?: number;
  dwellMs?: number;
  manualStickyMs?: number;
  bootTimeoutMs?: number;
}

function harness(options: Guards = {}) {
  const clock = { t: 100000 };
  const timers: FakeTimer[] = [];
  const arbiter = new Arbiter({
    store: fakeStore(),
    now: () => clock.t,
    schedule: (fn: () => void, ms: number) => {
      timers.push({ fn, at: clock.t + ms });
      return { unref() {} };
    },
    options
  });

  // Only due timers fire; the rest stay armed. The boot backstop is scheduled
  // far ahead of the focus guards and must survive their expiry.
  const advance = (ms: number) => {
    clock.t += ms;
    const due = timers.filter((x) => x.at <= clock.t);
    for (let i = timers.length - 1; i >= 0; i--) {
      if ((timers[i]?.at ?? 0) <= clock.t) timers.splice(i, 1);
    }
    for (const x of due) x.fn();
  };
  return { arbiter, clock, advance };
}

function build(options: Guards = {}) {
  const ctx = harness(options);
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2', agent: 'claude' });
  ctx.arbiter.register({ uuid: 'c', label: 'gamma', cwd: '/c', paneId: '%3', windowId: '@3', agent: 'claude' });
  return ctx;
}

type Ctx = ReturnType<typeof build>;

// The domain receives normalised events only; translating an agent's raw
// hooks is the adapter's job, tested against the claude profile separately.
const PROGRESS: AgentEvent = { kind: 'progress', reason: 'travaille' };
const WAIT_PERM: AgentEvent = { kind: 'waiting-perm', reason: 'permission demandée' };
const WAIT_INPUT: AgentEvent = { kind: 'waiting-input', reason: 'en attente de saisie' };
const STOP: AgentEvent = { kind: 'stop', reason: 'tour terminé' };
const ENDED: AgentEvent = { kind: 'ended', reason: 'session terminée' };

// Put every session in a quiet, non-claiming state and clear the guards.
function settle(ctx: Ctx) {
  for (const uuid of ['a', 'b', 'c']) ctx.arbiter.handleHook(uuid, PROGRESS, 'PreToolUse');
  ctx.advance(5000);
}

void test('background work never holds the foreground', () => {
  const ctx = build();
  settle(ctx);
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'b', 'alpha needs nothing, beta does');
  assert.equal(ctx.arbiter.lastSwitch?.reason, 'permission');
});

void test('a stronger claim preempts a weaker one', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', STOP, 'Stop'); // idle, class 1
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification'); // class 2
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.advance(5000);
  ctx.arbiter.handleHook('c', WAIT_PERM, 'Notification'); // class 3
  assert.equal(ctx.arbiter.focused, 'c');
});

void test('an equal claim never steals: ties keep the incumbent', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a', 'the human is already being asked something here');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b']);
});

void test('answering the current prompt hands the floor to the next claim', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook('a', PROGRESS, 'PreToolUse'); // the human approved
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('recent typing defers the switch, the timer then replays it', () => {
  const ctx = build({ typingGraceMs: 2500, dwellMs: 0 });
  settle(ctx);
  ctx.arbiter.noteInput('a');
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a', 'mid-keystroke, stay put');
  ctx.advance(2500);
  assert.equal(ctx.arbiter.focused, 'b', 'grace expired, the deferred switch fires');
});

void test('dwell keeps two back-to-back claims from flickering', () => {
  const ctx = build({ dwellMs: 1200, typingGraceMs: 0 });
  settle(ctx);
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification');
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.handleHook('c', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'b', 'too soon after the previous switch');
  ctx.advance(1200);
  assert.equal(ctx.arbiter.focused, 'c');
});

void test('no guard outlives its expiry: the deferred claim always lands', () => {
  const ctx = build({ manualStickyMs: 10000, typingGraceMs: 2500, dwellMs: 1200 });
  settle(ctx);
  ctx.arbiter.focus('c'); // arms the manual sticky
  ctx.arbiter.noteInput('c'); // arms the typing grace
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'c', 'guards defer the move');
  ctx.advance(10000);
  assert.equal(ctx.arbiter.focused, 'b', 'every guard expired, nothing holds the view forever');
});

void test('a manual pick is protected for its sticky window', () => {
  const ctx = build({ manualStickyMs: 10000 });
  settle(ctx);
  ctx.arbiter.focus('c');
  assert.equal(ctx.arbiter.focused, 'c');
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'c', 'the human just chose this one');
  ctx.advance(10000);
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('a dead session releases the floor immediately', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification');
  ctx.advance(5000);
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.markGone('b');
  assert.equal(ctx.arbiter.focused, 'a');
});

void test('explicit leave promotes the best claim and clears the guards', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  ctx.arbiter.leave();
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('leave with nothing claiming attention focuses nothing', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.leave();
  assert.equal(ctx.arbiter.focused, null);
});

void test('queue is ordered by class then by age of the claim', () => {
  const ctx = build({ manualStickyMs: 60000 });
  settle(ctx);
  ctx.arbiter.focus('a'); // hold the view so the queue, not the focus, is under test
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification');
  ctx.advance(10);
  ctx.arbiter.handleHook('c', WAIT_INPUT, 'Notification');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b', 'c']);
  ctx.arbiter.handleHook('c', WAIT_PERM, 'Notification');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['c', 'b']);
});

// ---- importance: a tiebreak inside a class, never across ----

void test('queue orders same-class claims by importance before age', () => {
  const ctx = build({ manualStickyMs: 60000 });
  settle(ctx);
  ctx.arbiter.focus('a'); // hold the view so the queue, not the focus, is under test
  ctx.arbiter.setImportance('c', IMPORTANCE.HIGH);
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification');
  ctx.advance(10);
  ctx.arbiter.handleHook('c', WAIT_INPUT, 'Notification');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['c', 'b'], 'high outranks an older normal claim');
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b', 'c'], 'equal importance falls back to age');
  ctx.arbiter.setImportance('b', IMPORTANCE.LOW);
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['c', 'b'], 'low sinks below normal');
});

void test('a higher-importance equal claim takes the floor from the incumbent', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  ctx.advance(5000);
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a', 'equal class, equal importance: the incumbent stays');
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  assert.equal(ctx.arbiter.focused, 'b', 'same class, higher importance: the candidate wins');
});

void test('a lower-importance equal claim never steals the foreground', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_INPUT, 'Notification');
  ctx.advance(5000);
  ctx.arbiter.handleHook('b', WAIT_INPUT, 'Notification');
  ctx.arbiter.setImportance('b', IMPORTANCE.LOW);
  assert.equal(ctx.arbiter.focused, 'a', 'the incumbent is not preempted by a lesser claim');
  ctx.arbiter.setImportance('a', IMPORTANCE.LOW);
  assert.equal(ctx.arbiter.focused, 'a', 'equal on every axis: still no ping-pong');
});

void test('importance never crosses a class boundary', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setImportance('a', IMPORTANCE.NORMAL);
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification'); // class 3, normal
  ctx.advance(5000);
  ctx.arbiter.handleHook('b', STOP, 'Stop'); // class 1, high
  assert.equal(ctx.arbiter.focused, 'a', 'a blocking permission outweighs a high idle');
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  assert.equal(ctx.arbiter.focused, 'a', 'even a bump changes nothing across the boundary');
});

void test('recent typing defers the importance switch, the timer then replays it', () => {
  const ctx = build({ typingGraceMs: 2500, dwellMs: 0 });
  settle(ctx);
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  ctx.advance(5000);
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.noteInput('a');
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  assert.equal(ctx.arbiter.focused, 'a', 'mid-keystroke, stay put');
  ctx.advance(2500);
  assert.equal(ctx.arbiter.focused, 'b', 'grace expired, the importance switch fires');
});

void test('a manual pick is not preempted by a mere importance bump', () => {
  const ctx = build({ manualStickyMs: 10000 });
  settle(ctx);
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  ctx.arbiter.focus('c');
  ctx.arbiter.setImportance('b', IMPORTANCE.HIGH);
  assert.equal(ctx.arbiter.focused, 'c', 'the sticky window holds, importance included');
  ctx.advance(10000);
  assert.equal(ctx.arbiter.focused, 'b', 'once it expires, the stronger claim lands');
});

void test('an ended event clears the claim of a background session', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook('b', WAIT_PERM, 'Notification');
  ctx.arbiter.handleHook('b', ENDED, 'SessionEnd');
  assert.equal(ctx.arbiter.queue().length, 0);
  assert.equal(ctx.arbiter.sessions.get('b')?.state, STATES.GONE);
});

void test('a hook for an unknown uuid is reported, never crashes', () => {
  const ctx = build();
  const orphans: { uuid: string; event: string }[] = [];
  ctx.arbiter.on('orphan', (o) => orphans.push(o));
  ctx.arbiter.handleHook('zzz', STOP, 'Stop');
  assert.deepEqual(orphans, [{ uuid: 'zzz', event: 'Stop' }]);
});

void test('an event the adapter does not recognise is logged but changes nothing', () => {
  const ctx = build();
  settle(ctx);
  const states = ['a', 'b', 'c'].map((u) => ctx.arbiter.get(u)?.state);
  ctx.arbiter.handleHook('a', null, 'SomeFutureEvent');
  assert.equal(ctx.arbiter.get('a')?.lastEvent, 'SomeFutureEvent');
  assert.equal(ctx.arbiter.get('a')?.state, states[0]);
});

// ---- runtime creation: coming up, and failing to ----

void test('the pane drawing is what brings a session up, not the agent announcing itself', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.BOOTING);
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.IDLE, 'no prompt: awaiting instructions');
});

void test('a session launched with a prompt comes up working, not idle', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude', prompt: 'go' });
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.RUNNING);
});

void test('a resumed session comes up idle, whatever its original prompt', () => {
  const ctx = harness();
  ctx.arbiter.register({
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude',
    prompt: 'migrate the billing schema', resumed: true
  });
  ctx.arbiter.noteAlive('a');
  const s = ctx.arbiter.sessions.get('a');
  assert.equal(s?.state, STATES.IDLE, 'a resumed conversation waits for its next instruction');
  assert.equal(s?.reason, 'reprise');
});

void test('a restored session keeps its summary without re-summarising its prompt', () => {
  const ctx = harness();
  ctx.arbiter.register({
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude',
    prompt: 'migrate the billing schema', summary: 'Migration du schéma de facturation', resumed: true
  });
  const s = ctx.arbiter.snapshot().sessions[0];
  assert.ok(s);
  assert.equal(s.summary, 'Migration du schéma de facturation');
});

void test('later output never drags a session back to its boot state', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.noteAlive('a');
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.WAITING_PERM);
});

void test('the end marker before the session ever drew anything is a failed launch', () => {
  const ctx = harness();
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2', agent: 'claude' });
  ctx.arbiter.noteAlive('b');
  ctx.arbiter.noteEnded('a');
  assert.deepEqual(failed, [{ uuid: 'a', label: 'alpha' }]);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.FAILED);
  assert.equal(ctx.arbiter.focused, 'b', 'a pane that never came up is never worth looking at');
});

void test('the end marker after a session came up is a normal end, not a failure', () => {
  const ctx = harness();
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.noteAlive('a');
  ctx.arbiter.noteEnded('a');
  assert.deepEqual(failed, []);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.GONE);
});

void test('a session that draws nothing at all trips the boot backstop', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.advance(15000);
  assert.deepEqual(failed, [{ uuid: 'a', label: 'alpha' }]);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.FAILED);
});

void test('output before the backstop expires disarms it', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.noteAlive('a');
  ctx.advance(60000);
  assert.deepEqual(failed, []);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.IDLE);
});

void test('a failed session does not count as live and can be unregistered', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.advance(15000);
  assert.equal(ctx.arbiter.live().length, 0);
  ctx.arbiter.unregister('a');
  assert.equal(ctx.arbiter.get('a'), null);
  assert.equal(ctx.arbiter.focused, null);
});

void test('the summary of the initial prompt lands on the session snapshot', () => {
  const ctx = harness();
  ctx.arbiter.register({
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude',
    model: 'sonnet', prompt: 'migrate the billing schema and keep it reversible'
  });
  ctx.arbiter.setSummary('a', 'Migration réversible du schéma de facturation');
  const s = ctx.arbiter.snapshot().sessions[0];
  assert.ok(s);
  assert.equal(s.model, 'sonnet');
  assert.equal(s.summary, 'Migration réversible du schéma de facturation');
  assert.equal(s.prompt, 'migrate the billing schema and keep it reversible');
});

void test('the snapshot carries which agent a session runs', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'opencode' });
  assert.equal(ctx.arbiter.snapshot().sessions[0]?.agent, 'opencode');
});

void test('a created session takes the floor, even over a pending permission', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', agent: 'claude' });
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'a');

  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2', agent: 'claude' });
  ctx.arbiter.focus('b'); // what createSession does: the human just asked for it
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.handleHook('a', WAIT_PERM, 'Notification');
  assert.equal(ctx.arbiter.focused, 'b', 'the fresh session is not preempted by an older claim');
});