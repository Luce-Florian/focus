import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, rmSync, statSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import type { Arbiter } from './arbiter.ts';
import type { HooksServer } from './hooks-server.ts';
import type { TmuxBridge } from './tmux.ts';
import { writeSessionSettings } from './session-settings.ts';
import { shQuote } from '../shared/sh.ts';
import type { CreateSessionSpec, HookEventName, ModelOption } from '../shared/protocol.ts';

/** The slice of `config.ts` the factory reads. Passed in so tests can shrink it. */
export interface FleetConfig {
  readonly RUN_DIR: string;
  readonly HOOK_HOST: string;
  readonly HOOK_EVENTS: readonly HookEventName[];
  readonly SESSION_END_MARKER: string;
  readonly MODELS: readonly ModelOption[];
  readonly SUMMARY_MODEL: string;
  readonly SUMMARY_TIMEOUT_MS: number;
  readonly SUMMARY_MAX_CHARS: number;
  // Read at call time, not captured: the ceiling is a mutable knob in tests.
  readonly MAX_SESSIONS: number;
}

export type FleetErrorCode = 'EFULL' | 'EBADCWD' | 'ELABEL' | 'EMODEL' | 'ETMUX';

export class FleetError extends Error {
  readonly code: FleetErrorCode;

  constructor(code: FleetErrorCode, message: string) {
    super(message);
    this.name = 'FleetError';
    this.code = code;
  }
}

export interface CreatedSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly model: string | null;
  readonly prompt: string | null;
  readonly settingsFile: string;
}

export interface Fleet {
  createSession(spec: CreateSessionSpec): Promise<CreatedSession>;
  discard(uuid: string): Promise<void>;
  observeOutput(paneId: string, bytes: Buffer): void;
  liveCount(): number;
}

export type Summarize = (args: { cfg: FleetConfig; claudeBin: string; prompt: string }) => Promise<string | null>;

export interface FleetOptions {
  readonly cfg: FleetConfig;
  readonly bridge: TmuxBridge;
  readonly arbiter: Arbiter;
  readonly hooks: HooksServer;
  readonly claudeBin?: string;
  readonly summarize?: Summarize;
}

export function resolveClaude(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

/**
 * Session factory. Creating a session at runtime and creating one at boot are
 * the same operation: mint the uuid, write its `--settings` file, open a tmux
 * window on the chosen directory, then hand it to the arbiter. The uuid exists
 * before the pane does, so the join is by construction, never discovered.
 */
export function createFleet({
  cfg,
  bridge,
  arbiter,
  hooks,
  claudeBin = resolveClaude(),
  summarize = defaultSummarize
}: FleetOptions): Fleet {
  function liveCount(): number {
    return arbiter.live().length;
  }

  function validate(spec: CreateSessionSpec): { cwd: string; label: string; model: string } {
    if (liveCount() >= cfg.MAX_SESSIONS) {
      throw new FleetError('EFULL', `la flotte est pleine (${cfg.MAX_SESSIONS} sessions)`);
    }

    const dir = path.resolve(spec.cwd);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      throw new FleetError('EBADCWD', `répertoire introuvable : ${dir}`);
    }
    if (!isDir) throw new FleetError('EBADCWD', `pas un répertoire : ${dir}`);
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
    } catch {
      throw new FleetError('EBADCWD', `répertoire illisible : ${dir}`);
    }

    const name = (spec.label ?? '').trim() || path.basename(dir);
    if (!name) throw new FleetError('ELABEL', 'nom de session vide');

    // Whitelist rather than escape: the model lands on a command line.
    const model = spec.model ?? '';
    if (!cfg.MODELS.some((m) => m.id === model)) throw new FleetError('EMODEL', `modèle inconnu : ${model}`);

    return { cwd: dir, label: name.slice(0, 40), model };
  }

  /**
   * Every step undoes the previous one on failure: no orphan tmux window, no
   * orphan settings file, no orphan row.
   */
  async function createSession(spec: CreateSessionSpec): Promise<CreatedSession> {
    const { cwd, label, model } = validate(spec);
    const prompt = (spec.prompt ?? '').trim();
    const uuid = crypto.randomUUID();

    const settingsFile = writeSessionSettings({
      runDir: cfg.RUN_DIR,
      uuid,
      host: cfg.HOOK_HOST,
      port: hooks.port,
      token: hooks.token,
      events: cfg.HOOK_EVENTS
    });

    const argv = [shQuote(claudeBin), '--session-id', uuid, '--settings', shQuote(settingsFile)];
    if (model) argv.push('--model', shQuote(model));
    // `claude [options] [prompt]`: the initial prompt is a positional argument,
    // so the session starts on it with no keystroke replay.
    if (prompt) argv.push(shQuote(prompt));

    // The pane outlives Claude Code so the final screen stays readable; the
    // marker is what tells the fleet the process is gone.
    const command = `${argv.join(' ')}; printf '\\n%s\\n' ${shQuote(cfg.SESSION_END_MARKER)}; exec sleep 86400`;

    let windowId: string;
    let paneId: string;
    try {
      ({ windowId, paneId } = await bridge.newSessionWindow({
        label,
        cwd,
        command: `sh -c ${shQuote(command)}`
      }));
    } catch (err: unknown) {
      rmSync(settingsFile, { force: true });
      throw new FleetError('ETMUX', `tmux a refusé la fenêtre : ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      arbiter.register({ uuid, label, cwd, paneId, windowId, model: model || null, prompt: prompt || null });
    } catch (err: unknown) {
      await bridge.cli(['kill-window', '-t', windowId]).catch(() => undefined);
      rmSync(settingsFile, { force: true });
      throw err;
    }

    // The human just asked for this session: it takes the floor now, through
    // the manual-pick path, and no incoming claim preempts that.
    arbiter.focus(uuid);

    if (prompt) {
      // Detached on purpose: a tooltip is never worth delaying a session for.
      summarize({ cfg, claudeBin, prompt })
        .then((summary) => {
          if (summary) arbiter.setSummary(uuid, summary);
        })
        .catch(() => undefined);
    }

    return { uuid, label, cwd, paneId, windowId, model: model || null, prompt: prompt || null, settingsFile };
  }

  /**
   * Pane output is the fleet's liveness signal, because `SessionStart` is not
   * observed to fire. The marker is checked first: a launch that fails prints
   * its error and the marker in the same breath, and the marker wins.
   */
  const tails = new Map<string, string>(); // paneId -> trailing bytes, for a marker split across chunks

  function observeOutput(paneId: string, bytes: Buffer): void {
    const s = arbiter.byPane(paneId);
    if (!s) return;
    const marker = cfg.SESSION_END_MARKER;
    const text = (tails.get(paneId) ?? '') + bytes.toString('latin1');
    if (text.includes(marker)) {
      tails.delete(paneId);
      arbiter.noteEnded(s.uuid);
      return;
    }
    tails.set(paneId, text.slice(-marker.length));
    arbiter.noteAlive(s.uuid);
  }

  /** Tear down a session whose launch never came up. */
  async function discard(uuid: string): Promise<void> {
    const s = arbiter.get(uuid);
    arbiter.unregister(uuid);
    if (s) {
      tails.delete(s.paneId);
      await bridge.cli(['kill-window', '-t', s.windowId]).catch(() => undefined);
    }
    rmSync(path.join(cfg.RUN_DIR, `${uuid}.settings.json`), { force: true });
  }

  return { createSession, discard, observeOutput, liveCount };
}

const SUMMARY_INSTRUCTION =
  "Résume en 20 mots maximum l'attendu du prompt ci-dessous. " +
  'Réponds uniquement le résumé, sans préambule ni ponctuation finale.\n\n';

/**
 * Denying the tools keeps this a pure text turn. The fleet's own `--settings`
 * is never handed over: it would POST hook events under the session's identity.
 */
const SUMMARY_SETTINGS = JSON.stringify({
  permissions: { deny: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch'] }
});

export const defaultSummarize: Summarize = ({ cfg, claudeBin, prompt }) =>
  new Promise((resolve) => {
    const args = ['-p', '--model', cfg.SUMMARY_MODEL, '--settings', SUMMARY_SETTINGS, SUMMARY_INSTRUCTION + prompt];
    // Run outside the target directory: no CLAUDE.md of the user's repo to load.
    execFile(
      claudeBin,
      args,
      { cwd: cfg.RUN_DIR, timeout: cfg.SUMMARY_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        resolve(line ? line.slice(0, cfg.SUMMARY_MAX_CHARS) : null);
      }
    );
  });
