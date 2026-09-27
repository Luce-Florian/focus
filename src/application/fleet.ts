import type { CreateSessionSpec } from '../shared/protocol.ts';
import type { Arbiter } from '../domain/arbiter.ts';
import type { AgentRegistry, FleetConfig, HookSink, PaneMultiplexer } from './ports.ts';
import type { CreatedSession, RestorableSession } from './use-cases/create-session.ts';
import { createSessionUseCase } from './use-cases/create-session.ts';
import { createDiscardSession } from './use-cases/discard-session.ts';
import { createObservePaneOutput } from './use-cases/observe-pane-output.ts';

/** The fleet's public surface, as the composition root drives it. */
export interface Fleet {
  createSession(spec: CreateSessionSpec): Promise<CreatedSession>;
  restoreSession(row: RestorableSession): Promise<CreatedSession>;
  discard(uuid: string): Promise<void>;
  observeOutput(paneId: string, bytes: Buffer): void;
  liveCount(): number;
}

export interface FleetOptions {
  readonly cfg: FleetConfig;
  readonly multiplexer: PaneMultiplexer;
  readonly arbiter: Arbiter;
  readonly hooks: HookSink;
  readonly profiles: AgentRegistry;
}

/**
 * Orchestrator: composes the use cases over the injected ports. Nothing
 * here knows tmux, SQLite, HTTP or any particular coding agent.
 */
export function createFleet({ cfg, multiplexer, arbiter, hooks, profiles }: FleetOptions): Fleet {
  const { createSession, restoreSession } = createSessionUseCase({ cfg, multiplexer, arbiter, hooks, profiles });
  const paneOutput = createObservePaneOutput({ arbiter, sessionEndMarker: cfg.SESSION_END_MARKER });
  const discard = createDiscardSession({ cfg, arbiter, multiplexer, profiles, forgetPane: paneOutput.forget });

  return {
    createSession,
    restoreSession,
    discard,
    observeOutput: paneOutput.observe,
    liveCount: () => arbiter.live().length
  };
}