import type { AgentId, HookEventMessage } from '../../domain/agent.ts';
import type { Arbiter } from '../../domain/arbiter.ts';
import type { AgentRegistry } from '../ports.ts';

export interface HandleAgentEventDeps {
  readonly arbiter: Arbiter;
  readonly profiles: AgentRegistry;
  /** Used for hooks whose session is unknown (orphans still get logged). */
  readonly fallback: AgentId;
}

/**
 * Use case: a raw hook arrived. The session's own profile translates it into
 * the domain's normalised event — the anti-corruption layer — then the
 * arbiter observes it: logged, orphan-checked, and applied to the state.
 */
export function createHandleAgentEvent({ arbiter, profiles, fallback }: HandleAgentEventDeps) {
  return function handleAgentEvent({ uuid, event, payload }: HookEventMessage): void {
    const profile = profiles.get(arbiter.get(uuid)?.agent ?? fallback);
    arbiter.handleHook(uuid, profile?.translate(event, payload) ?? null, event, payload);
  };
}