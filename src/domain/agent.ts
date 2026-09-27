/**
 * Agent-facing domain vocabulary. A session runs *some* coding agent — today
 * Claude Code, tomorrow Codex or opencode — and the domain only ever reasons
 * about the normalised event kinds below, never about an agent's raw hook
 * names. Translating raw → normalised is the adapter's job.
 */

/** The coding agents the fleet knows how to drive. */
export type AgentId = 'claude' | 'codex' | 'opencode';

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}

/** A model offered at session creation. The empty id means "no model flag". */
export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

/**
 * What an agent is doing, as far as the attention policy cares. Every
 * adapter maps its own raw events onto this union; anything that does not
 * map is ignored (still logged, never fatal).
 */
export type AgentEvent =
  | { readonly kind: 'progress'; readonly reason: string }
  | { readonly kind: 'waiting-input'; readonly reason: string }
  | { readonly kind: 'waiting-perm'; readonly reason: string }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'ended'; readonly reason: string };

/**
 * Hook payloads are arbitrary JSON handed over by the agent. The domain
 * only ever reads well-known fields off them, everything else is stored
 * as-is in the append-only `hook_events` log.
 */
export type HookPayload = Record<string, unknown>;

/** A raw hook as it arrived from an agent: identity in, payload along. */
export interface HookEventMessage {
  uuid: string;
  // Whatever the URL's last segment is: the HTTP endpoint never validates
  // it against a known list, it only routes on `uuid` and the auth token.
  event: string;
  payload: HookPayload;
}