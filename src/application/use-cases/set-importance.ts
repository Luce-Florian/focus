import { isImportance } from '../../domain/attention.ts';
import type { Arbiter } from '../../domain/arbiter.ts';

export interface SetImportanceDeps {
  readonly arbiter: Arbiter;
}

/**
 * Use case: the human reassigned a session's importance. Persisted, and
 * re-decided at once under the same guards as an event — a sticky manual pick
 * never yields to a mere bump. Anything that is not a level is ignored.
 */
export function createSetImportance({ arbiter }: SetImportanceDeps) {
  return function setImportance(uuid: string, importance: unknown): void {
    if (!isImportance(importance)) return;
    arbiter.setImportance(uuid, importance);
  };
}