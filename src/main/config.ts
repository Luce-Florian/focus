import { existsSync } from 'node:fs';
import path from 'node:path';

import type { HookEventName } from '../shared/protocol.ts';

export interface SessionSpec {
  readonly label: string;
  readonly cwd: string;
}

/**
 * The repository root is the nearest ancestor holding a `package.json`,
 * starting from the directory the running bundle sits in.
 *
 * Counting `..` would only be correct for one output depth. esbuild emits
 * `dist/main.js` one level below the root but also one bundle per test file
 * under `dist/test/**`, each carrying its own inlined copy of this module and
 * its own `import.meta.dirname` — so a fixed `..` silently resolved ROOT to
 * `dist/test` there, and every path derived from it (RUN_DIR, DB_PATH, both
 * `workspaces/` entries) pointed at directories that do not exist. Walking up
 * is correct at every depth.
 */
export function computeRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json in any directory above ${startDir}`);
    dir = parent;
  }
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
