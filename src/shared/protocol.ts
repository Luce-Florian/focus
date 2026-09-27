/**
 * The façade the two sandboxed processes (preload, renderer) are allowed to
 * see. Domain types are re-exported from their real homes — `src/domain` —
 * and everything else here is the `contextBridge` contract itself. The UI
 * never imports a layer directly.
 */
export {
  CLS,
  IMPORTANCE,
  IMPORTANCE_LABEL,
  isImportance,
  STATES,
  STATE_CLASS,
  CLASS_LABEL,
  STATE_LABEL
} from '../domain/attention.ts';
export type { AttentionClass, Importance, SessionState } from '../domain/attention.ts';

export { isAgentId } from '../domain/agent.ts';
export type { AgentId, AgentEvent, HookPayload, ModelOption } from '../domain/agent.ts';

export type { SwitchInfo, SessionSnapshot, FleetSnapshot } from '../domain/session.ts';

import type { FleetSnapshot } from '../domain/session.ts';
import type { AgentId, ModelOption } from '../domain/agent.ts';
import type { Importance } from '../domain/attention.ts';

/** An agent the create form offers, as the registry advertises it. */
export interface AgentOption {
  readonly id: AgentId;
  readonly label: string;
}

/** What the human fills in to start a session. Only `cwd` is required. */
export interface CreateSessionSpec {
  readonly cwd: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly model?: string;
  /** Defaults to the first registered agent (`claude`). */
  readonly agent?: AgentId;
  readonly importance?: Importance;
}

/**
 * A creation either produced a session or explained why it could not. The
 * renderer shows `error` in the form rather than treating it as a crash.
 */
export type CreateResult = { ok: true; uuid: string } | { ok: false; error: string };

/**
 * The hook endpoint's path layout, `/h/<token>/<uuid>/<Event>`. Joining a
 * session to its pane is URL routing, so the builder and the parser have to
 * agree byte for byte — they live together here rather than being restated
 * in the adapter, the endpoint and the smoke test.
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

/** The `contextBridge` API the sandboxed preload exposes as `window.fleet`. */
export interface FleetBridge {
  onState(cb: (state: FleetSnapshot) => void): void;
  // The bridge emits a Buffer and Electron's structured clone hands the
  // renderer a Uint8Array — never a bare ArrayBuffer.
  onOutput(cb: (paneId: string, bytes: Uint8Array) => void): void;
  // Out-of-band message for the human: a session that failed to start.
  onNotice(cb: (text: string) => void): void;
  ready(): Promise<FleetSnapshot>;
  /** The agents the create form can pick from. */
  agents(): Promise<readonly AgentOption[]>;
  /** The models the chosen agent offers; the empty id means "no model flag". */
  models(agent: AgentId): Promise<readonly ModelOption[]>;
  // Native directory picker, or null when the human cancelled.
  pickDir(): Promise<string | null>;
  create(spec: CreateSessionSpec): Promise<CreateResult>;
  setImportance(uuid: string, importance: Importance): void;
  input(paneId: string, data: string): void;
  focus(uuid: string): void;
  leave(): void;
  resize(cols: number, rows: number): void;
}