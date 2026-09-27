import type { AgentId } from './agent.ts';
import type { AttentionClass, Importance, SessionState } from './attention.ts';

/** What the fleet learns about a session the moment it is registered. */
export interface RegisterSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly agent: AgentId;
  readonly model?: string | null;
  readonly prompt?: string | null;
  // Restore path: the tooltip survives the restart, no need to re-summarise.
  readonly summary?: string | null;
  // A resumed session waits for its next instruction: it is not working, no
  // matter that it was created with an initial prompt.
  readonly resumed?: boolean;
  // Human-assigned weight, `NORMAL` unless said otherwise.
  readonly importance?: Importance;
}

export interface SessionRecord {
  uuid: string;
  label: string;
  cwd: string;
  paneId: string;
  windowId: string;
  agent: AgentId;
  model: string | null;
  prompt: string | null;
  summary: string | null;
  importance: Importance;
  // Not persisted: only meaningful between `register` and the first pane draw.
  resumed: boolean;
  state: SessionState;
  reason: string;
  since: number;
  lastEvent: string | null;
  updatedAt: number;
}

/** One focus move: `Arbiter#lastSwitch`, replayed by the renderer as a toast. */
export interface SwitchInfo {
  from: string | null;
  to: string;
  reason: string;
  at: number;
}

/** A session as the UI sees it: `Arbiter#snapshot()`'s per-session shape. */
export interface SessionSnapshot {
  uuid: string;
  label: string;
  cwd: string;
  paneId: string;
  agent: AgentId;
  model: string | null;
  prompt: string | null;
  summary: string | null;
  state: SessionState;
  cls: AttentionClass;
  clsLabel: string;
  importance: Importance;
  importanceLabel: string;
  reason: string;
  lastEvent: string | null;
  since: number;
  updatedAt: number;
  rank: number;
}

/** `Arbiter#snapshot()`: the whole fleet, pushed to the UI on every change. */
export interface FleetSnapshot {
  focused: string | null;
  lastSwitch: SwitchInfo | null;
  sessions: SessionSnapshot[];
}