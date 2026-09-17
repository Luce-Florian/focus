import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { open, type NewSession } from '../../src/main/db.ts';
import { withTempDir } from '../helpers/tmp.ts';

function newSession(over: Partial<NewSession> = {}): NewSession {
  return {
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', state: 'booting',
    model: null, prompt: null, summary: null, createdAt: 1000, ...over
  };
}

function withStore(fn: (store: ReturnType<typeof open>) => void): void {
  withTempDir((dir) => {
    const store = open(path.join(dir, 'fleet.db'));
    try {
      fn(store);
    } finally {
      store.close();
    }
  }, 'fleet-db-');
}

void test('a registered session can be read back by uuid', () => {
  withStore((store) => {
    store.insertSession(newSession());
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.label, 'alpha');
    assert.equal(row.state, 'booting');
  });
});

void test('updating state moves the session on and bumps updated_at', () => {
  withStore((store) => {
    store.insertSession(newSession());
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
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'fleet.db');
    const first = open(dbPath);
    first.insertSession(newSession());
    first.upsertQueue('a', 3, 'permission', 1000);
    first.close();

    const restarted = open(dbPath);
    try {
      assert.equal(restarted.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a'), undefined);
      assert.deepEqual(restarted.readQueue(), []);
    } finally {
      restarted.close();
    }
  }, 'fleet-db-');
});

void test('a session created from the interface keeps its model, prompt and summary', () => {
  withStore((store) => {
    store.insertSession(newSession({ model: 'sonnet', prompt: 'migrate the billing schema' }));
    store.setSummary('a', 'Migration du schéma de facturation');
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.model, 'sonnet');
    assert.equal(row.prompt, 'migrate the billing schema');
    assert.equal(row.summary, 'Migration du schéma de facturation');
  });
});

void test('a discarded session leaves no row behind', () => {
  withStore((store) => {
    store.insertSession(newSession());
    store.deleteSession('a');
    assert.equal(store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a'), undefined);
  });
});

void test('a database written before the model/prompt/summary columns existed is migrated in place', () => {
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'fleet.db');
    // The shape `open()` used to create, without the three later columns.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        uuid TEXT PRIMARY KEY, label TEXT NOT NULL, cwd TEXT NOT NULL,
        pane_id TEXT, window_id TEXT, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const store = open(dbPath);
    try {
      store.insertSession(newSession({ model: 'haiku' }));
      const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
      assert.ok(row);
      assert.equal(row.model, 'haiku');
      assert.equal(row.summary, null);
    } finally {
      store.close();
    }
  }, 'fleet-db-');
});
