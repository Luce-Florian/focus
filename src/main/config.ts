import { existsSync } from 'node:fs';
import path from 'node:path';

import type { HookEventName, ModelOption } from '../shared/protocol.ts';

export interface SessionSpec {
  readonly label: string;
  readonly cwd: string;
  readonly prompt?: string;
  readonly model?: string;
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

/**
 * The fleet starts empty: sessions are created from the user interface, on a
 * working directory the human picks. Anything listed here is only a seed.
 */
export const SESSIONS: readonly SessionSpec[] = [];

/**
 * One Claude process, one tmux pane rendered continuously and one live
 * xterm.js instance per session: the ceiling is a resource decision.
 */
export const MAX_SESSIONS = 8;

/**
 * Printed in the pane when Claude Code exits. The pane deliberately outlives
 * the process, so this marker is what tells a live session from a dead one.
 * ASCII only: pane output is matched byte for byte, one char per byte.
 */
export const SESSION_END_MARKER = '[fleet] session ended';

/**
 * Backstop for a launch that draws nothing at all: past this delay a session
 * still stuck on `booting` is declared failed and torn down.
 */
export const BOOT_TIMEOUT_MS = 15000;

/** Models offered at creation. The empty id means "no --model flag". */
export const MODELS: readonly ModelOption[] = [
  { id: '', label: 'défaut' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
];

// The initial prompt is summarised out of band, for the session tooltip.
export const SUMMARY_MODEL = 'haiku';
export const SUMMARY_TIMEOUT_MS = 20000;
export const SUMMARY_MAX_CHARS = 120;

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
