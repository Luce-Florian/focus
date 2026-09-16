import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { HookPayload, QueueRow, SessionState, HookEventRow } from '../shared/protocol.ts';

export interface NewSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string | null;
  readonly windowId: string | null;
  readonly state: SessionState;
  readonly createdAt: number;
}

/** The subset of the store the arbiter depends on; see `test/main/arbiter.test.ts`'s fake. */
export interface ArbiterStore {
  insertSession(session: NewSession): void;
  updateSessionState(uuid: string, state: SessionState, ts: number): void;
  logHookEvent(uuid: string, event: string, payload: HookPayload, ts: number): void;
  upsertQueue(uuid: string, cls: number, reason: string, ts: number): void;
  deleteQueue(uuid: string): void;
}

export interface Store extends ArbiterStore {
  readonly db: DatabaseSync;
  readQueue(): QueueRow[];
  recentEvents(limit: number): HookEventRow[];
  close(): void;
}

export function open(dbPath: string): Store {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      uuid       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      pane_id    TEXT,
      window_id  TEXT,
      state      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid    TEXT NOT NULL,
      event   TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hook_events_uuid_ts ON hook_events (uuid, ts);

    CREATE TABLE IF NOT EXISTS queue (
      uuid        TEXT PRIMARY KEY,
      class       INTEGER NOT NULL,
      reason      TEXT,
      enqueued_at INTEGER NOT NULL
    );
  `);

  // Electron owns the tmux lifecycle in this skeleton: every launch starts from
  // a clean fleet. The append-only event log survives across runs.
  db.exec('DELETE FROM sessions; DELETE FROM queue;');

  return {
    db,
    insertSession(s) {
      db.prepare(
        `INSERT INTO sessions (uuid, label, cwd, pane_id, window_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(s.uuid, s.label, s.cwd, s.paneId, s.windowId, s.state, s.createdAt, s.createdAt);
    },
    updateSessionState(uuid, state, ts) {
      db.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE uuid = ?').run(state, ts, uuid);
    },
    logHookEvent(uuid, event, payload, ts) {
      db.prepare('INSERT INTO hook_events (uuid, event, payload, ts) VALUES (?, ?, ?, ?)')
        .run(uuid, event, JSON.stringify(payload), ts);
    },
    upsertQueue(uuid, cls, reason, ts) {
      // One entry per session: refresh class and reason, keep the original
      // enqueue time so waiting sessions never lose their place.
      db.prepare(
        `INSERT INTO queue (uuid, class, reason, enqueued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET class = excluded.class, reason = excluded.reason`
      ).run(uuid, cls, reason, ts);
    },
    deleteQueue(uuid) {
      db.prepare('DELETE FROM queue WHERE uuid = ?').run(uuid);
    },
    readQueue() {
      return db.prepare('SELECT * FROM queue ORDER BY class DESC, enqueued_at ASC').all() as unknown as QueueRow[];
    },
    recentEvents(limit) {
      return db.prepare('SELECT * FROM hook_events ORDER BY id DESC LIMIT ?').all(limit) as unknown as HookEventRow[];
    },
    close() {
      db.close();
    }
  };
}
