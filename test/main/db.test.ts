import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { open } from '../../src/main/db.ts';

function withStore(fn: (store: ReturnType<typeof open>) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-db-'));
  const store = open(path.join(dir, 'fleet.db'));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void test('a registered session can be read back by uuid', () => {
  withStore((store) => {
    store.insertSession({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', state: 'booting', createdAt: 1000 });
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.label, 'alpha');
    assert.equal(row.state, 'booting');
  });
});

void test('updating state moves the session on and bumps updated_at', () => {
  withStore((store) => {
    store.insertSession({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', state: 'booting', createdAt: 1000 });
    store.updateSessionState('a', 'running', 2000);
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.state, 'running');
    assert.equal(row.updated_at, 2000);
  });
});

void test('the queue keeps one entry per session, refreshed in place without losing its enqueue time', () => {
  withStore((store) => {
    store.upsertQueue('a', 3, 'permission', 1000);
    store.upsertQueue('a', 2, 'attente', 5000); // same session, later refresh: class changes, age does not
    assert.deepEqual(store.readQueue().map((r) => [r.class, r.enqueued_at]), [[2, 1000]]);
    store.deleteQueue('a');
    assert.deepEqual(store.readQueue(), []);
  });
});

void test('hook events append to the log and come back most-recent first', () => {
  withStore((store) => {
    store.logHookEvent('a', 'Stop', { hook_event_name: 'Stop' }, 1000);
    store.logHookEvent('a', 'Notification', { message: 'hi' }, 2000);
    const [latest] = store.recentEvents(10);
    assert.ok(latest);
    assert.equal(latest.event, 'Notification');
    const payload = JSON.parse(latest.payload) as { message: string };
    assert.equal(payload.message, 'hi');
  });
});

void test('every launch starts from a clean fleet: sessions and the queue do not survive a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-db-'));
  const dbPath = path.join(dir, 'fleet.db');
  try {
    const first = open(dbPath);
    first.insertSession({ uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', state: 'booting', createdAt: 1000 });
    first.upsertQueue('a', 3, 'permission', 1000);
    first.close();

    const restarted = open(dbPath);
    try {
      assert.equal(restarted.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a'), undefined);
      assert.deepEqual(restarted.readQueue(), []);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
