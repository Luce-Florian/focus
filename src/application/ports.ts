import type { AgentEvent, AgentId, HookPayload, ModelOption } from '../domain/agent.ts';
import type { Importance } from '../domain/attention.ts';
import type { SessionRepository } from '../domain/ports.ts';

/** The slice of the fleet's limits the use cases read. */
export interface FleetConfig {
  readonly RUN_DIR: string;
  // Read at call time, not captured: the ceiling is a mutable knob in tests.
  readonly MAX_SESSIONS: number;
  readonly SESSION_END_MARKER: string;
}

/** Identity of the fleet's hook endpoint, as a session's settings need it. */
export interface HookSink {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface WindowPane {
  readonly windowId: string;
  readonly paneId: string;
}

export interface NewSessionWindowOptions {
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
}

/**
 * The pane multiplexer as the use cases see it: open a window, send input,
 * watch panes. tmux is today's implementation; the port is what the
 * application is allowed to know.
 */
export interface PaneMultiplexer {
  on(event: 'output', listener: (paneId: string, bytes: Buffer) => void): unknown;
  on(event: 'window-closed', listener: (windowId: string) => void): unknown;
  newSessionWindow(options: NewSessionWindowOptions): Promise<WindowPane>;
  sendKeys(paneId: string, data: string): Promise<void>;
  setClientSize(cols: number, rows: number): Promise<unknown>;
  /** One-shot command outside the event stream (teardown, window counting). */
  cli(args: readonly string[]): Promise<string>;
}

/** What an adapter needs to write a session's per-launch settings file. */
export interface WriteAgentSettings {
  readonly runDir: string;
  readonly uuid: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface LaunchArgs {
  readonly uuid: string;
  /** Empty string: the agent's own default model. */
  readonly model: string;
  readonly settingsFile: string;
  /** The initial prompt, or null when the session starts bare. */
  readonly prompt: string | null;
}

export interface ResumeArgs {
  readonly uuid: string;
  readonly model: string;
  readonly settingsFile: string;
}

/**
 * One coding agent the fleet knows how to drive. Everything agent-specific —
 * command line, settings format, hook vocabulary, models, summarising —
 * lives behind this contract. Adding Codex or opencode means implementing
 * it, nothing else in the application or the domain changes.
 */
export interface AgentProfile {
  readonly id: AgentId;
  readonly label: string;
  models(): readonly ModelOption[];
  /** The agent command line for a fresh session, sh-quoted as a whole. */
  launch(args: LaunchArgs): string;
  /** The agent command line resuming an existing conversation. */
  resume(args: ResumeArgs): string;
  writeSettings(args: WriteAgentSettings): string;
  /**
   * Where `writeSettings` puts — or put — this agent's settings file for a
   * session. Naming that file is the adapter's business: a tear-down that
   * spelled the name out itself would leak the file of any agent naming it
   * differently.
   */
  settingsFile(runDir: string, uuid: string): string;
  /**
   * The session a run-directory entry belongs to, or null when the entry is
   * not this agent's settings. What the boot sweep needs to recognise an
   * orphan file without knowing any agent's naming scheme.
   */
  settingsOwner(fileName: string): string | null;
  /** One-line description of a prompt, produced out of band. */
  summarize(prompt: string): Promise<string | null>;
  /**
   * Anti-corruption layer: the agent's raw hook event, translated into the
   * domain's normalised event — or null when it carries no meaning for the
   * attention policy.
   */
  translate(event: string, payload: HookPayload): AgentEvent | null;
}

export interface AgentRegistry {
  get(id: AgentId): AgentProfile | undefined;
  list(): readonly AgentProfile[];
}

/** What the restore pass hands back to a session that survived a restart. */
export interface RestorableSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly agent: AgentId;
  readonly model: string | null;
  readonly prompt: string | null;
  readonly summary: string | null;
  readonly importance: Importance;
}

/** What the fleet needs from the store beyond what the arbiter touches. */
export interface FleetStore extends SessionRepository {
  /** Sessions still alive at the last shutdown, oldest first. */
  listRestorable(): readonly RestorableSession[];
  /** Boot-time cleanup: drop `gone`/`failed` rows and stale queue entries. */
  purge(): void;
  close(): void;
}