import type { AgentId, HookPayload } from './agent.ts';
import type { Importance, SessionState } from './attention.ts';

/** A registered session as the repository writes it. */
export interface SessionRowInput {
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
  readonly agent: AgentId;
  readonly createdAt: number;
}

/**
 * The subset of persistence the arbiter depends on. Deliberately narrow:
 * everything the arbiter touches is here, and a fake in the tests can
 * implement it in one object literal.
 */
export interface SessionRepository {
  insertSession(session: SessionRowInput): void;
  updateSessionState(uuid: string, state: SessionState, ts: number): void;
  logHookEvent(uuid: string, event: string, payload: HookPayload, ts: number): void;
  upsertQueue(uuid: string, cls: number, reason: string, ts: number): void;
  deleteQueue(uuid: string): void;
  setSummary(uuid: string, summary: string): void;
  setImportance(uuid: string, importance: Importance): void;
  deleteSession(uuid: string): void;
}

/** Injectable time: the arbiter's only clock. */
export type Clock = () => number;

/** Injectable scheduler: the arbiter's only timer, unref'd when possible. */
export interface Timer {
  unref?(): void;
}

export type Schedule = (fn: () => void, ms: number) => Timer;