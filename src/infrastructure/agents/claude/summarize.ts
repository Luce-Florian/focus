import { execFile } from 'node:child_process';

import { SUMMARY_MAX_CHARS, SUMMARY_MODEL, SUMMARY_TIMEOUT_MS } from './models.ts';

const SUMMARY_INSTRUCTION =
  "Résume en 20 mots maximum l'attendu du prompt ci-dessous. " +
  'Réponds uniquement le résumé, sans préambule ni ponctuation finale.\n\n';

/**
 * Denying the tools keeps this a pure text turn. The fleet's own per-session
 * settings are never handed over: they would POST hook events under the
 * session's identity.
 */
const SUMMARY_SETTINGS = JSON.stringify({
  permissions: { deny: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch'] }
});

export interface SummarizeOptions {
  readonly bin: string;
  /** Run outside the target directory: no CLAUDE.md of the user's repo to load. */
  readonly runDir: string;
}

/**
 * The out-of-band prompt summary, for the session chip's tooltip. Never
 * delays the session, never fails it: any error resolves to null.
 */
export function createSummarize({ bin, runDir }: SummarizeOptions) {
  return (prompt: string): Promise<string | null> =>
    new Promise((resolve) => {
      const args = ['-p', '--model', SUMMARY_MODEL, '--settings', SUMMARY_SETTINGS, SUMMARY_INSTRUCTION + prompt];
      execFile(
        bin,
        args,
        { cwd: runDir, timeout: SUMMARY_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
          resolve(line ? line.slice(0, SUMMARY_MAX_CHARS) : null);
        }
      );
    });
}