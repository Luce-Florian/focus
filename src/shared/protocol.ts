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
  GONE: 'gone',
  // Registered, but the pane never drew anything: the launch did not take.
  FAILED: 'failed'
} as const;

export type SessionState = (typeof STATES)[keyof typeof STATES];

export const STATE_CLASS: Record<SessionState, AttentionClass> = {
  [STATES.BOOTING]: CLS.RUNNING,
  [STATES.RUNNING]: CLS.RUNNING,
  [STATES.IDLE]: CLS.IDLE,
  [STATES.WAITING_INPUT]: CLS.WAIT_INPUT,
  [STATES.WAITING_PERM]: CLS.WAIT_PERM,
  [STATES.GONE]: CLS.GONE,
  [STATES.FAILED]: CLS.GONE
};

export const CLASS_LABEL: Record<AttentionClass, string> = {
  [CLS.WAIT_PERM]: 'permission',
  [CLS.WAIT_INPUT]: 'attente',
  [CLS.IDLE]: 'tour terminé',
  [CLS.RUNNING]: 'travaille',
  [CLS.GONE]: 'terminée'
};

/**
 * States whose own name says more than their attention class. `booting` and
 * `failed` both sit at a class that says nothing useful on a chip.
 */
export const STATE_LABEL: Partial<Record<SessionState, string>> = {
  [STATES.BOOTING]: 'démarrage',
  [STATES.FAILED]: 'démarrage échoué'
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

/**
 * The hook endpoint's path layout, `/h/<token>/<uuid>/<Event>`. Joining a
 * Claude session to its pane is URL routing, so the builder and the parser
 * have to agree byte for byte — they live together here rather than being
 * restated in `session-settings.ts`, `hooks-server.ts` and the smoke test.
 */
export const HOOK_PATH_PREFIX = 'h';

export function hookPath(token: string, uuid: string, event: string): string {
  return `/${HOOK_PATH_PREFIX}/${token}/${uuid}/${event}`;
}

export function hookUrl(host: string, port: number, token: string, uuid: string, event: string): string {
  return `http://${host}:${port}${hookPath(token, uuid, event)}`;
}

/** The identity a request URL carries, or null when it is not a hook path. */
export function parseHookPath(url: string): { token: string; uuid: string; event: string } | null {
  const parts = url.split('/').filter(Boolean);
  if (parts.length !== 4) return null;
  const [prefix, token, uuid, event] = parts;
  if (prefix !== HOOK_PATH_PREFIX || !token || !uuid || !event) return null;
  return { token, uuid, event };
}

/** `sessions` table row (`src/main/db.ts`). */
export interface SessionRow {
  uuid: string;
  label: string;
  cwd: string;
  pane_id: string | null;
  window_id: string | null;
  state: SessionState;
  // Chosen at creation; null for a session created without one.
  model: string | null;
  prompt: string | null;
  // One-line description of `prompt`, produced out of band after the launch.
  summary: string | null;
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

/** One focus move: `Arbiter#lastSwitch`, replayed by the renderer as a toast. */
export interface SwitchInfo {
  from: string | null;
  to: string;
  reason: string;
  at: number;
}

/** A session as the renderer sees it: `Arbiter#snapshot()`'s per-session shape. */
export interface SessionSnapshot {
  uuid: string;
  label: string;
  cwd: string;
  paneId: string;
  model: string | null;
  prompt: string | null;
  summary: string | null;
  state: SessionState;
  cls: AttentionClass;
  clsLabel: string;
  reason: string;
  lastEvent: string | null;
  since: number;
  updatedAt: number;
  rank: number;
}

/** `Arbiter#snapshot()`: the whole fleet, pushed to the renderer over `fleet:state`. */
export interface FleetSnapshot {
  focused: string | null;
  lastSwitch: SwitchInfo | null;
  sessions: SessionSnapshot[];
}

/** A model offered at session creation. The empty id means "no --model flag". */
export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

/** What the human fills in to start a session. Only `cwd` is required. */
export interface CreateSessionSpec {
  readonly cwd: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly model?: string;
}

/**
 * A creation either produced a session or explained why it could not. The
 * renderer shows `error` in the form rather than treating it as a crash.
 */
export type CreateResult = { ok: true; uuid: string } | { ok: false; error: string };

/** The `contextBridge` API the sandboxed preload exposes as `window.fleet`. */
export interface FleetBridge {
  onState(cb: (state: FleetSnapshot) => void): void;
  // `tmux.ts` emits a Buffer and Electron's structured clone hands the
  // renderer a Uint8Array — never a bare ArrayBuffer.
  onOutput(cb: (paneId: string, bytes: Uint8Array) => void): void;
  // Out-of-band message for the human: a session that failed to start.
  onNotice(cb: (text: string) => void): void;
  ready(): Promise<FleetSnapshot>;
  models(): Promise<ModelOption[]>;
  // Native directory picker, or null when the human cancelled.
  pickDir(): Promise<string | null>;
  create(spec: CreateSessionSpec): Promise<CreateResult>;
  input(paneId: string, data: string): void;
  focus(uuid: string): void;
  leave(): void;
  resize(cols: number, rows: number): void;
}
