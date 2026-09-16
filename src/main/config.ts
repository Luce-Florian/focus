import { existsSync } from 'node:fs';
import path from 'node:path';

import type { HookEventName } from '../shared/protocol.ts';

export interface SessionSpec {
  readonly label: string;
  readonly cwd: string;
}

/**
 * `dist/main.js` sits one level below the repository root — unlike
 * `src/main/config.js` before it, which sat two levels below (`src/main/`).
 * The bundle's own directory is the root's only child on this path, so ROOT
 * is one `..` away, not two.
 */
export function computeRoot(mainDirname: string): string {
  return path.resolve(mainDirname, '..');
}

/**
 * A wrong ROOT fails silently otherwise: RUN_DIR, DB_PATH and both
 * `workspaces/` entries would just derive from nonsense. Fail fast at
 * startup instead of during whatever unrelated error shows up later.
 */
export function assertProjectRoot(root: string): void {
  if (!existsSync(path.join(root, 'package.json'))) {
    throw new Error(`ROOT does not look like the repository root: ${root} has no package.json`);
  }
}

export const ROOT = computeRoot(import.meta.dirname);

export const RUN_DIR = path.join(ROOT, 'run');
export const DB_PATH = path.join(ROOT, 'run', 'fleet.db');

// Dedicated tmux server: own socket + `-f /dev/null` so the user's tmux.conf
// and existing sessions are never touched.
export const TMUX_SOCKET = 'fleet-poc';
export const TMUX_SESSION = 'fleet';

export const HOOK_HOST = '127.0.0.1';

// The walking skeleton drives exactly two sessions.
export const SESSIONS: readonly SessionSpec[] = [
  { label: 'alpha', cwd: path.join(ROOT, 'workspaces', 'alpha') },
  { label: 'beta', cwd: path.join(ROOT, 'workspaces', 'beta') }
];

// Hook events the arbiter subscribes to.
export const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
];
