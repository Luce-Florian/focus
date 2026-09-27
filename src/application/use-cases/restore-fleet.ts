import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { Arbiter } from '../../domain/arbiter.ts';
import type { AgentRegistry, FleetConfig, FleetStore, HookSink, PaneMultiplexer } from '../ports.ts';
import { createSessionUseCase, type CreatedSession } from './create-session.ts';

export interface RestoreFleetDeps {
  readonly cfg: FleetConfig;
  readonly store: FleetStore;
  readonly arbiter: Arbiter;
  readonly multiplexer: PaneMultiplexer;
  readonly hooks: HookSink;
  readonly profiles: AgentRegistry;
  readonly onRestored?: (session: CreatedSession) => void;
  readonly onRestoreFailed?: (label: string, err: unknown) => void;
}

/**
 * Use case: bring the fleet back after a restart. `gone` and `failed`
 * sessions are never brought back; the queue is derived state and is rebuilt
 * from what survives. A restore that cannot happen (directory gone, agent
 * retired, fleet full) is skipped with a report, not a crash — the rest of
 * the fleet still deserves to come up.
 */
export function createRestoreFleet({ cfg, store, arbiter, multiplexer, hooks, profiles, onRestored, onRestoreFailed }: RestoreFleetDeps) {
  const { restoreSession } = createSessionUseCase({ cfg, multiplexer, arbiter, hooks, profiles });

  return async function restoreFleet(): Promise<void> {
    store.purge();

    for (const row of store.listRestorable()) {
      try {
        const s = await restoreSession(row);
        onRestored?.(s);
      } catch (err: unknown) {
        onRestoreFailed?.(row.label, err);
        store.deleteSession(row.uuid);
      }
    }

    // Settings files whose session is gone — purged rows, restores that
    // rolled back — outlive nothing: hook URLs in them point at a dead port
    // anyway. Which entries are settings, and whose, is each agent's own
    // answer: anything no profile claims is left alone, `fleet.db` included.
    const alive = new Set(arbiter.live().map((s) => s.uuid));
    for (const f of readdirSync(cfg.RUN_DIR)) {
      for (const p of profiles.list()) {
        const owner = p.settingsOwner(f);
        if (owner === null) continue;
        if (!alive.has(owner)) rmSync(path.join(cfg.RUN_DIR, f), { force: true });
        break;
      }
    }
  };
}