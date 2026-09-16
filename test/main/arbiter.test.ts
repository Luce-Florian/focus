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
    deleteQueue() {}
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
}

function build(options: Guards = {}) {
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
  arbiter.register({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1' });
  arbiter.register({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2' });
  arbiter.register({ uuid: 'c', label: 'gamma', cwd: '/c', paneId: '%3', windowId: '@3' });

  const advance = (ms: number) => {
    clock.t += ms;
    const due = timers.filter((x) => x.at <= clock.t);
    timers.length = 0;
    for (const x of due) x.fn();
  };
  return { arbiter, clock, advance };
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

test('background work never holds the foreground', () => {
  const ctx = build();
  settle(ctx);
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'b', 'alpha needs nothing, beta does');
  assert.equal(ctx.arbiter.lastSwitch?.reason, 'permission');
});

test('a stronger claim preempts a weaker one', () => {
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

test('an equal claim never steals: ties keep the incumbent', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a', 'the human is already being asked something here');
  assert.deepEqual(ctx.arbiter.queue().map((s) => s.uuid), ['b']);
});

test('answering the current prompt hands the floor to the next claim', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.handleHook(hook('a', 'PreToolUse')); // the human approved
  assert.equal(ctx.arbiter.focused, 'b');
});

test('recent typing defers the switch, the timer then replays it', () => {
  const ctx = build({ typingGraceMs: 2500, dwellMs: 0 });
  settle(ctx);
  ctx.arbiter.noteInput('a');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a', 'mid-keystroke, stay put');
  ctx.advance(2500);
  assert.equal(ctx.arbiter.focused, 'b', 'grace expired, the deferred switch fires');
});

test('dwell keeps two back-to-back claims from flickering', () => {
  const ctx = build({ dwellMs: 1200, typingGraceMs: 0 });
  settle(ctx);
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE));
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.handleHook(hook('c', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'b', 'too soon after the previous switch');
  ctx.advance(1200);
  assert.equal(ctx.arbiter.focused, 'c');
});

test('pin suspends automatic switching and releasing it catches up', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setPinned(true);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'a');
  ctx.advance(5000);
  ctx.arbiter.setPinned(false);
  assert.equal(ctx.arbiter.focused, 'b');
});

test('a manual pick is protected for its sticky window', () => {
  const ctx = build({ manualStickyMs: 10000 });
  settle(ctx);
  ctx.arbiter.focus('c');
  assert.equal(ctx.arbiter.focused, 'c');
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  assert.equal(ctx.arbiter.focused, 'c', 'the human just chose this one');
  ctx.advance(10000);
  assert.equal(ctx.arbiter.focused, 'b');
});

test('a dead session releases the floor immediately', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('b', 'Notification', IDLE));
  ctx.advance(5000);
  assert.equal(ctx.arbiter.focused, 'b');
  ctx.arbiter.markGone('b');
  assert.equal(ctx.arbiter.focused, 'a');
});

test('explicit leave promotes the best claim and clears the guards', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.handleHook(hook('a', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  ctx.arbiter.leave();
  assert.equal(ctx.arbiter.focused, 'b');
});

test('leave with nothing claiming attention focuses nothing', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.leave();
  assert.equal(ctx.arbiter.focused, null);
});

test('queue is ordered by class then by age of the claim', () => {
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

test('SessionEnd clears the claim of a background session', () => {
  const ctx = build();
  settle(ctx);
  ctx.arbiter.setPinned(true);
  ctx.arbiter.handleHook(hook('b', 'Notification', PERM));
  ctx.arbiter.handleHook(hook('b', 'SessionEnd'));
  assert.equal(ctx.arbiter.queue().length, 0);
  assert.equal(ctx.arbiter.sessions.get('b')?.state, STATES.GONE);
});

test('hook for an unknown uuid is reported, never crashes', () => {
  const ctx = build();
  const orphans: Array<{ uuid: string; event: string }> = [];
  ctx.arbiter.on('orphan', (o) => orphans.push(o));
  ctx.arbiter.handleHook(hook('zzz', 'Stop'));
  assert.deepEqual(orphans, [{ uuid: 'zzz', event: 'Stop' }]);
});
