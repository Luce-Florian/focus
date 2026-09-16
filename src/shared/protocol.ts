/**
 * Shapes shared by the three processes (Electron main, the sandboxed
 * preload, and the renderer): attention classes and session state, hook
 * event payloads, and the pieces `db.ts` and `contextBridge` build on top of
 * them. Nothing here is process-specific.
 */

/**
 * Attention classes. Focus always goes to the highest class on screen.
 * Class 0 means "this session needs nothing from the human": it is
 * background work and must never occupy the foreground while something else
 * is waiting.
 */
export const CLS = {
  GONE: -1,
  RUNNING: 0, // working on its own
  IDLE: 1, // turn finished, awaiting the next instruction
  WAIT_INPUT: 2, // Notification: idle nudge
  WAIT_PERM: 3 // Notification: blocking permission prompt
} as const;

export type AttentionClass = (typeof CLS)[keyof typeof CLS];

export const STATES = {
  BOOTING: 'booting',
  RUNNING: 'running',
  WAITING_PERM: 'waiting_perm',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  GONE: 'gone'
} as const;

export type SessionState = (typeof STATES)[keyof typeof STATES];

export const STATE_CLASS: Record<SessionState, AttentionClass> = {
  [STATES.BOOTING]: CLS.RUNNING,
  [STATES.RUNNING]: CLS.RUNNING,
  [STATES.IDLE]: CLS.IDLE,
  [STATES.WAITING_INPUT]: CLS.WAIT_INPUT,
  [STATES.WAITING_PERM]: CLS.WAIT_PERM,
  [STATES.GONE]: CLS.GONE
};

export const CLASS_LABEL: Record<AttentionClass, string> = {
  [CLS.WAIT_PERM]: 'permission',
  [CLS.WAIT_INPUT]: 'attente',
  [CLS.IDLE]: 'tour terminé',
  [CLS.RUNNING]: 'travaille',
  [CLS.GONE]: 'terminée'
};

/** Hook events the arbiter can subscribe a session to. */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Hook payloads are arbitrary JSON handed over by Claude Code. The arbiter
 * only ever reads well-known fields off them (`message` for `Notification`),
 * everything else is stored as-is in `hook_events.payload`.
 */
export type HookPayload = Record<string, unknown>;

export interface HookEventMessage {
  uuid: string;
  // Whatever the URL's last segment is: the HTTP endpoint never validates it
  // against HOOK_EVENT_NAMES, it only routes on `uuid` and the auth token.
  event: string;
  payload: HookPayload;
}

/** `sessions` table row (`src/main/db.ts`). */
export interface SessionRow {
  uuid: string;
  label: string;
  cwd: string;
  pane_id: string | null;
  window_id: string | null;
  state: SessionState;
  created_at: number;
  updated_at: number;
}

/** `hook_events` table row: the append-only log that survives a restart. */
export interface HookEventRow {
  id: number;
  uuid: string;
  event: string;
  payload: string; // JSON-encoded HookPayload
  ts: number;
}

/** `queue` table row: sessions currently claiming attention. */
export interface QueueRow {
  uuid: string;
  class: AttentionClass;
  reason: string | null;
  enqueued_at: number;
}
