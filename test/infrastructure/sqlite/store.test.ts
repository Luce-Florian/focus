import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { open, type Store } from '../../../src/infrastructure/sqlite/store.ts';
import type { SessionRowInput } from '../../../src/domain/ports.ts';
import { IMPORTANCE } from '../../../src/domain/attention.ts';
import { withTempDir } from '../../helpers/tmp.ts';

function newSession(over: Partial<SessionRowInput> = {}): SessionRowInput {
  return {
    uuid: 'a', label: 'alpha', cwd: '/a', paneId: '%1', windowId: '@1', state: 'booting',
    model: null, prompt: null, summary: null, importance: IMPORTANCE.NORMAL, agent: 'claude', createdAt: 1000, ...over
  };
}

function withStore(fn: (store: Store) => void): void {
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

void test('a restart keeps the sessions that were alive and purges the rest', () => {
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'fleet.db');
    const first = open(dbPath);
    first.insertSession(newSession({ state: 'running' }));
    first.insertSession(newSession({ uuid: 'b', label: 'beta', cwd: '/b', paneId: '%2', windowId: '@2', state: 'idle', createdAt: 2000 }));
    first.insertSession(newSession({ uuid: 'c', label: 'gamma', cwd: '/c', paneId: '%3', windowId: '@3', state: 'gone', createdAt: 3000 }));
    first.insertSession(newSession({ uuid: 'd', label: 'delta', cwd: '/d', paneId: '%4', windowId: '@4', state: 'failed', createdAt: 4000 }));
    first.upsertQueue('a', 3, 'permission', 1000);
    first.upsertQueue('c', 2, 'attente', 1000); // c is gone: its queue claim dies with it
    first.close();

    const restarted = open(dbPath);
    try {
      restarted.purge();
      assert.deepEqual(
        restarted.listRestorable().map((r) => r.uuid),
        ['a', 'b']
      );
      assert.equal(restarted.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('c'), undefined);
      assert.equal(restarted.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('d'), undefined);
      assert.deepEqual(restarted.readQueue().map((r) => r.uuid), ['a']);
    } finally {
      restarted.close();
    }
  }, 'fleet-db-');
});

void test('re-registering a restored session refreshes its pane and window but not its creation time', () => {
  withStore((store) => {
    store.insertSession(newSession({ state: 'idle' }));
    store.insertSession(newSession({ paneId: '%9', windowId: '@9', state: 'booting', summary: 'Migration du schéma' }));
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.pane_id, '%9');
    assert.equal(row.window_id, '@9');
    assert.equal(row.summary, 'Migration du schéma');
    // The original creation time orders the next restore pass: it must survive.
    assert.equal(row.created_at, 1000);
  });
});

void test('a session created from the interface keeps its model, prompt, summary and agent', () => {
  withStore((store) => {
    store.insertSession(newSession({ model: 'sonnet', prompt: 'migrate the billing schema', agent: 'opencode' }));
    store.setSummary('a', 'Migration du schéma de facturation');
    const row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.model, 'sonnet');
    assert.equal(row.prompt, 'migrate the billing schema');
    assert.equal(row.summary, 'Migration du schéma de facturation');
    assert.equal(row.agent, 'opencode');
  });
});

void test('the agent of a restorable session comes back with the row', () => {
  withStore((store) => {
    store.insertSession(newSession({ state: 'idle', agent: 'codex' }));
    const [row] = store.listRestorable();
    assert.ok(row);
    assert.equal(row.agent, 'codex', 'the restore pass picks the profile by it');
  });
});

void test('setImportance persists the level on the row', () => {
  withStore((store) => {
    store.insertSession(newSession());
    store.setImportance('a', IMPORTANCE.HIGH);
    let row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.importance, IMPORTANCE.HIGH);
    store.setImportance('a', IMPORTANCE.LOW);
    row = store.db.prepare('SELECT * FROM sessions WHERE uuid = ?').get('a');
    assert.ok(row);
    assert.equal(row.importance, IMPORTANCE.LOW);
  });
});

void test('the importance level survives a restart', () => {
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'fleet.db');
    const first = open(dbPath);
    first.insertSession(newSession({ state: 'idle', importance: IMPORTANCE.HIGH }));
    first.setImportance('a', IMPORTANCE.LOW);
    first.close();

    const restarted = open(dbPath);
    try {
      restarted.purge();
      const [row] = restarted.listRestorable();
      assert.ok(row);
      assert.equal(row.importance, IMPORTANCE.LOW, 'the human-assigned level is restorable');
    } finally {
      restarted.close();
    }
  }, 'fleet-db-');
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
    // The shape `open()` used to create, without the later columns.
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
      assert.equal(row.importance, IMPORTANCE.NORMAL, 'the importance column defaults to normal');
      assert.equal(row.agent, 'claude', 'the agent column defaults to claude');
    } finally {
      store.close();
    }
  }, 'fleet-db-');
});