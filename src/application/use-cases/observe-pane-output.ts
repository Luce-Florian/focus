import type { Arbiter } from '../../domain/arbiter.ts';

export interface ObservePaneOutputDeps {
  readonly arbiter: Arbiter;
  readonly sessionEndMarker: string;
}

export interface PaneOutputObserver {
  /** One `%output` chunk for one pane. */
  readonly observe: (paneId: string, bytes: Buffer) => void;
  /** The pane is gone: drop the bytes kept for a marker split across chunks. */
  readonly forget: (paneId: string) => void;
}

/**
 * Use case: pane output is the fleet's liveness signal. The marker is
 * checked first: a launch that fails prints its error and the marker in the
 * same breath, and the marker wins. Everything else drawn is proof the
 * process came up.
 */
export function createObservePaneOutput({ arbiter, sessionEndMarker }: ObservePaneOutputDeps): PaneOutputObserver {
  // paneId -> trailing bytes, for a marker split across chunks
  const tails = new Map<string, string>();

  return {
    observe: (paneId: string, bytes: Buffer): void => {
      const s = arbiter.byPane(paneId);
      if (!s) return;
      const text = (tails.get(paneId) ?? '') + bytes.toString('latin1');
      if (text.includes(sessionEndMarker)) {
        tails.delete(paneId);
        arbiter.noteEnded(s.uuid);
        return;
      }
      tails.set(paneId, text.slice(-sessionEndMarker.length));
      arbiter.noteAlive(s.uuid);
    },
    // A discarded or closed pane never draws again: its tail is dead weight.
    forget: (paneId: string): void => {
      tails.delete(paneId);
    }
  };
}
