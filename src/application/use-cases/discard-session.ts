import { rmSync } from 'node:fs';

import type { Arbiter } from '../../domain/arbiter.ts';
import type { AgentRegistry, FleetConfig, PaneMultiplexer } from '../ports.ts';

export interface DiscardSessionDeps {
  readonly cfg: FleetConfig;
  readonly arbiter: Arbiter;
  readonly multiplexer: PaneMultiplexer;
  readonly profiles: AgentRegistry;
  /** Drops what the liveness watcher kept for that pane; it will never draw again. */
  readonly forgetPane: (paneId: string) => void;
}

/**
 * Use case: tear down a session whose launch never came up — its window, its
 * settings file, its row. Failure to kill the window is swallowed: a dead
 * pane is not worth a crash over.
 */
export function createDiscardSession({ cfg, arbiter, multiplexer, profiles, forgetPane }: DiscardSessionDeps) {
  return async function discardSession(uuid: string): Promise<void> {
    const s = arbiter.get(uuid);
    arbiter.unregister(uuid);
    if (s) {
      forgetPane(s.paneId);
      await multiplexer.cli(['kill-window', '-t', s.windowId]).catch(() => undefined);
    }
    // Every profile is asked, not just the row's: the row may already be
    // gone, and a uuid belongs to one session, so no other agent owns a file
    // under that name. Removing a path that was never written is a no-op.
    for (const p of profiles.list()) {
      rmSync(p.settingsFile(cfg.RUN_DIR, uuid), { force: true });
    }
  };
}
