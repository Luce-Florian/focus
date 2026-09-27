import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentId, HookPayload } from '../../domain/agent.ts';
import { STATES, type Importance, type SessionState } from '../../domain/attention.ts';
import type { SessionRowInput } from '../../domain/ports.ts';
import type { FleetStore, RestorableSession } from '../../application/ports.ts';

export { type SessionRowInput } from '../../domain/ports.ts';

/** `queue` table row: sessions currently claiming attention. */
export interface QueueRow {
  uuid: string;
  class: number;
  reason: string | null;
  enqueued_at: number;
}

/** `hook_events` table row: the append-only log that survives a restart. */
export interface HookEventRow {
  id: number;
  uuid: string;
  event: string;
  payload: string; // JSON-encoded HookPayload
  ts: number;
}

/** The store's full SQLite surface, tests included. */
export interface Store extends FleetStore {
  readonly db: DatabaseSync;
  readQueue(): QueueRow[];
  recentEvents(limit: number): HookEventRow[];
}

/**
 * Columns added after the first schema shipped. `CREATE TABLE IF NOT EXISTS`
 * never revisits an existing table, so they are applied by hand.
 */
const SESSION_COLUMNS: readonly (readonly [string, string])[] = [
  ['model', 'TEXT'],
  ['prompt', 'TEXT'],
  ['summary', 'TEXT'],
  ['importance', 'INTEGER NOT NULL DEFAULT 0'],
  ['agent', "TEXT NOT NULL DEFAULT 'claude'"]
];

function migrateSessions(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[];
  const present = new Set(rows.map((c) => c.name));
  for (const [name, type] of SESSION_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
}

interface SessionDbRow {
  uuid: string;
  label: string;
  cwd: string;
  pane_id: string | null;
  window_id: string | null;
  state: SessionState;
  model: string | null;
  prompt: string | null;
  summary: string | null;
  importance: number;
  agent: string;
  created_at: number;
  updated_at: number;
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
    insertSession(s: SessionRowInput) {
      // Upsert, not insert: a restored session already has its row, and its
      // `created_at` is what orders the next restore pass — it must survive.
      db.prepare(
        `INSERT INTO sessions
           (uuid, label, cwd, pane_id, window_id, state, model, prompt, summary, importance, agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           pane_id = excluded.pane_id,
           window_id = excluded.window_id,
           state = excluded.state,
           model = excluded.model,
           prompt = excluded.prompt,
           summary = excluded.summary,
           importance = excluded.importance,
           agent = excluded.agent,
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
        s.agent,
        s.createdAt,
        s.createdAt
      );
    },
    setSummary(uuid: string, summary: string) {
      db.prepare('UPDATE sessions SET summary = ? WHERE uuid = ?').run(summary, uuid);
    },
    setImportance(uuid: string, importance: Importance) {
      db.prepare('UPDATE sessions SET importance = ? WHERE uuid = ?').run(importance, uuid);
    },
    deleteSession(uuid: string) {
      db.prepare('DELETE FROM sessions WHERE uuid = ?').run(uuid);
    },
    updateSessionState(uuid: string, state: SessionState, ts: number) {
      db.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE uuid = ?').run(state, ts, uuid);
    },
    logHookEvent(uuid: string, event: string, payload: HookPayload, ts: number) {
      db.prepare('INSERT INTO hook_events (uuid, event, payload, ts) VALUES (?, ?, ?, ?)')
        .run(uuid, event, JSON.stringify(payload), ts);
    },
    upsertQueue(uuid: string, cls: number, reason: string, ts: number) {
      // One entry per session: refresh class and reason, keep the original
      // enqueue time so waiting sessions never lose their place.
      db.prepare(
        `INSERT INTO queue (uuid, class, reason, enqueued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET class = excluded.class, reason = excluded.reason`
      ).run(uuid, cls, reason, ts);
    },
    deleteQueue(uuid: string) {
      db.prepare('DELETE FROM queue WHERE uuid = ?').run(uuid);
    },
    readQueue() {
      return db.prepare('SELECT * FROM queue ORDER BY class DESC, enqueued_at ASC').all() as unknown as QueueRow[];
    },
    recentEvents(limit: number) {
      return db.prepare('SELECT * FROM hook_events ORDER BY id DESC LIMIT ?').all(limit) as unknown as HookEventRow[];
    },
    listRestorable() {
      // `created_at ASC`: restoration replays creation order, so the focus
      // "première session" lands on the oldest, as it did at first boot.
      const rows = db
        .prepare('SELECT * FROM sessions ORDER BY created_at ASC')
        .all() as unknown as SessionDbRow[];
      return rows.map((r): RestorableSession => ({
        uuid: r.uuid,
        label: r.label,
        cwd: r.cwd,
        agent: r.agent as AgentId,
        model: r.model,
        prompt: r.prompt,
        summary: r.summary,
        importance: r.importance as Importance
      }));
    },
    close() {
      db.close();
    }
  };
}