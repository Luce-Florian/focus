import type { AgentEvent, HookPayload } from '../../../domain/agent.ts';

/** The hook events a Claude Code session is subscribed to. */
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

// Proof that the session moved on by itself: its claim on the human is stale.
const PROGRESS_EVENTS = new Set<string>(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

/**
 * Anti-corruption layer: Claude Code's raw hook events, translated into the
 * domain's normalised attention events. The `Notification` message text is
 * what tells an idle nudge from a blocking permission prompt.
 */
export function translate(event: string, payload: HookPayload): AgentEvent | null {
  if (PROGRESS_EVENTS.has(event)) return { kind: 'progress', reason: 'travaille' };
  if (event === 'Notification') {
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (/waiting for your input/i.test(message)) {
      return { kind: 'waiting-input', reason: message || 'en attente de saisie' };
    }
    return { kind: 'waiting-perm', reason: message || 'permission demandée' };
  }
  if (event === 'Stop') return { kind: 'stop', reason: 'tour terminé' };
  if (event === 'SessionEnd') return { kind: 'ended', reason: 'session terminée' };
  return null;
}