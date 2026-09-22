import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { STATES, type HookPayload, type Importance, type QueueRow, type SessionRow, type SessionState, type HookEventRow } from '../shared/protocol.ts';

export interface NewSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string | null;
  readonly windowId: string | null;
  readonly state: SessionState;
  readonly model: string | null;
  readonly prompt: string | null;
  readonly summary: string | null;
  readonly importance: Importance;
  readonly createdAt: number;
}

/** The subset of the store the arbiter depends on; see `test/main/arbiter.test.ts`'s fake. */
export interface ArbiterStore {
  insertSession(session: NewSession): void;
  updateSessionState(uuid: string, state: SessionState, ts: number): void;
  logHookEvent(uuid: string, event: string, payload: HookPayload, ts: number): void;
  upsertQueue(uuid: string, cls: number, reason: string, ts: number): void;
  deleteQueue(uuid: string): void;
  setSummary(uuid: string, summary: string): void;
  setImportance(uuid: string, importance: Importance): void;
  deleteSession(uuid: string): void;
}

export interface Store extends ArbiterStore {
  readonly db: DatabaseSync;
  readQueue(): QueueRow[];
  recentEvents(limit: number): HookEventRow[];
  /** Sessions still alive at the last shutdown, oldest first. */
  listRestorable(): SessionRow[];
  /** Boot-time cleanup: drop `gone`/`failed` rows and stale queue entries. */
  purge(): void;
  close(): void;
}

/**
 * Columns added after the first schema shipped. `CREATE TABLE IF NOT EXISTS`
 * never revisits an existing table, so they are applied by hand.
 */
const SESSION_COLUMNS: readonly (readonly [string, string])[] = [
  ['model', 'TEXT'],
  ['prompt', 'TEXT'],
  ['summary', 'TEXT'],
  ['importance', 'INTEGER NOT NULL DEFAULT 0']
];

function migrateSessions(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[];
  const present = new Set(rows.map((c) => c.name));
  for (const [name, type] of SESSION_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
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
  migrateSessions(db);

  return {
    db,
    purge() {
      // `gone` and `failed` sessions are never brought back: the restore pass
      // reads what is left. The queue is derived state, so it is rebuilt from
      // the surviving rows' claims.
      db.prepare('DELETE FROM sessions WHERE state IN (?, ?)').run(STATES.GONE, STATES.FAILED);
      db.prepare('DELETE FROM queue WHERE uuid NOT IN (SELECT uuid FROM sessions)').run();
    },
    insertSession(s) {
      // Upsert, not insert: a restored session already has its row, and its
      // `created_at` is what orders the next restore pass — it must survive.
      db.prepare(
        `INSERT INTO sessions
           (uuid, label, cwd, pane_id, window_id, state, model, prompt, summary, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           pane_id = excluded.pane_id,
           window_id = excluded.window_id,
           state = excluded.state,
           model = excluded.model,
           prompt = excluded.prompt,
           summary = excluded.summary,
           importance = excluded.importance,
           updated_at = excluded.updated_at`
      ).run(
        s.uuid,
        s.label,
        s.cwd,
        s.paneId,
        s.windowId,
        s.state,
        s.model,
        s.prompt,
        s.summary,
        s.importance,
        s.createdAt,
        s.createdAt
      );
    },
    setSummary(uuid, summary) {
      db.prepare('UPDATE sessions SET summary = ? WHERE uuid = ?').run(summary, uuid);
    },
    setImportance(uuid, importance) {
      db.prepare('UPDATE sessions SET importance = ? WHERE uuid = ?').run(importance, uuid);
    },
    deleteSession(uuid) {
      db.prepare('DELETE FROM sessions WHERE uuid = ?').run(uuid);
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
    listRestorable() {
      // `created_at ASC`: restoration replays creation order, so the focus
      // "première session" lands on the oldest, as it did at first boot.
      return db
        .prepare('SELECT * FROM sessions ORDER BY created_at ASC')
        .all() as unknown as SessionRow[];
    },
    close() {
      db.close();
    }
  };
}
