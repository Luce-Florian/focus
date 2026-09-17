import test from 'node:test';
import assert from 'node:assert';

import { Arbiter } from '../../src/main/arbiter.ts';
import { STATES } from '../../src/shared/protocol.ts';
import type { ArbiterStore } from '../../src/main/db.ts';
import type { HookPayload } from '../../src/shared/protocol.ts';

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
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2' });
  ctx.arbiter.register({ uuid: 'c', label: 'gamma', cwd: '/c', paneId: '%3', windowId: '@3' });
  return ctx;
}

type Ctx = ReturnType<typeof build>;

const hook = (uuid: string, event: string, payload: HookPayload = {}) => ({ uuid, event, payload });
const PERM = { message: 'Claude needs your permission to use Bash' };
const IDLE = { message: 'Claude is waiting for your input' };

// Put every session in a quiet, non-claiming state and clear the guards.
function settle(ctx: Ctx) {
  for (const uuid of ['a', 'b', 'c']) ctx.arbiter.handleHook(hook(uuid, 'PreToolUse'));
  ctx.advance(5000);
}

void test('background work never holds the foreground', () => {
  const ctx = build();
  settle(ctx);
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'b', 'alpha needs nothing, beta does');
  assert.equal(ctx.arbiter.lastSwitch?.reason, 'permission');
});

void test('a stronger claim preempts a weaker one', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Stop')); // idle, class 1
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE)); // class 2
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.advance(5000);
  ctx.arbiter.handleHook(hook('c', 'Notification', PERM)); // class 3
  assert.equal(ctx.arbiter.focused, 'c');
});

void test('an equal claim never steals: ties keep the incumbent', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a', 'the human is already being asked something here');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b']);
});

void test('answering the current prompt hands the floor to the next claim', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook(hook('a', 'PreToolUse')); // the human approved
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('recent typing defers the switch, the timer then replays it', () => {
  const ctx = build({ typingGraceMs: 2500, dwellMs: 0 });
  settle(ctx);
  ctx.arbiter.noteInput('a');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a', 'mid-keystroke, stay put');
  ctx.advance(2500);
  assert.equal(ctx.arbiter.focused, 'b', 'grace expired, the deferred switch fires');
});

void test('dwell keeps two back-to-back claims from flickering', () => {
  const ctx = build({ dwellMs: 1200, typingGraceMs: 0 });
  settle(ctx);
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE));
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.handleHook(hook('c', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'b', 'too soon after the previous switch');
  ctx.advance(1200);
  assert.equal(ctx.arbiter.focused, 'c');
});

void test('pin suspends automatic switching and releasing it catches up', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setPinned(true);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.setPinned(false);
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('a manual pick is protected for its sticky window', () => {
  const ctx = build({ manualStickyMs: 10000 });
  settle(ctx);
  ctx.arbiter.focus('c');
  assert.equal(ctx.arbiter.focused, 'c');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'c', 'the human just chose this one');
  ctx.advance(10000);
  assert.equal(ctx.arbiter.focused, 'b');
});

void test('a dead session releases the floor immediately', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE));
  ctx.advance(5000);
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.markGone('b');
  assert.equal(ctx.arbiter.focused, 'a');
});

void test('explicit leave promotes the best claim and clears the guards', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
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
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setPinned(true);
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE));
  ctx.advance(10);
  ctx.arbiter.handleHook(hook('c', 'Notification', IDLE));
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b', 'c']);
  ctx.arbiter.handleHook(hook('c', 'Notification', PERM));
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['c', 'b']);
});

void test('SessionEnd clears the claim of a background session', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setPinned(true);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'SessionEnd'));
  assert.equal(ctx.arbiter.queue().length, 0);
  assert.equal(ctx.arbiter.sessions.get('b')?.state, STATES.GONE);
});

void test('hook for an unknown uuid is reported, never crashes', () => {
  const ctx = build();
  const orphans: { uuid: string; event: string }[] = [];
  ctx.arbiter.on('orphan', (o) => orphans.push(o));
  ctx.arbiter.handleHook(hook('zzz', 'Stop'));
  assert.deepEqual(orphans, [{ uuid: 'zzz', event: 'Stop' }]);
});

// ---- runtime creation: coming up, and failing to ----

void test('the pane drawing is what brings a session up, not SessionStart', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.BOOTING);
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.IDLE, 'no prompt: awaiting instructions');
});

void test('a session launched with a prompt comes up working, not idle', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', prompt: 'go' });
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.RUNNING);
});

void test('later output never drags a session back to its boot state', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.noteAlive('a');
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  ctx.arbiter.noteAlive('a');
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.WAITING_PERM);
});

void test('the end marker before the session ever drew anything is a failed launch', () => {
  const ctx = harness();
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2' });
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
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.noteAlive('a');
  ctx.arbiter.noteEnded('a');
  assert.deepEqual(failed, []);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.GONE);
});

void test('a session that draws nothing at all trips the boot backstop', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.advance(15000);
  assert.deepEqual(failed, [{ uuid: 'a', label: 'alpha' }]);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.FAILED);
});

void test('output before the backstop expires disarms it', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  const failed: { uuid: string; label: string }[] = [];
  ctx.arbiter.on('failed', (f) => failed.push(f));
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.noteAlive('a');
  ctx.advance(60000);
  assert.deepEqual(failed, []);
  assert.equal(ctx.arbiter.sessions.get('a')?.state, STATES.IDLE);
});

void test('a failed session does not count as live and can be unregistered', () => {
  const ctx = harness({ bootTimeoutMs: 15000 });
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.advance(15000);
  assert.equal(ctx.arbiter.live().length, 0);
  ctx.arbiter.unregister('a');
  assert.equal(ctx.arbiter.get('a'), null);
  assert.equal(ctx.arbiter.focused, null);
});

void test('the summary of the initial prompt lands on the session snapshot', () => {
  const ctx = harness();
  ctx.arbiter.register({
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1',
    model: 'sonnet', prompt: 'migrate the billing schema and keep it reversible'
  });
  ctx.arbiter.setSummary('a', 'Migration réversible du schéma de facturation');
  const s = ctx.arbiter.snapshot().sessions[0];
  assert.ok(s);
  assert.equal(s.model, 'sonnet');
  assert.equal(s.summary, 'Migration réversible du schéma de facturation');
  assert.equal(s.prompt, 'migrate the billing schema and keep it reversible');
});

void test('a created session takes the floor, even over a pending permission', () => {
  const ctx = harness();
  ctx.arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');

  ctx.arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2' });
  ctx.arbiter.focus('b'); // what createSession does: the human just asked for it
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'b', 'the fresh session is not preempted by an older claim');
});
