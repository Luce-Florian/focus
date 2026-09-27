import { execFileSync } from 'node:child_process';

import type { AgentEvent, HookPayload, ModelOption } from '../../../domain/agent.ts';
import { shQuote } from '../../../shared/sh.ts';
import type {
  AgentProfile,
  LaunchArgs,
  ResumeArgs,
  WriteAgentSettings
} from '../../../application/ports.ts';
import { translate } from './events.ts';
import { MODELS } from './models.ts';
import { claudeSettingsFile, claudeSettingsOwner, writeSessionSettings } from './settings-writer.ts';
import { createSummarize } from './summarize.ts';

export function resolveClaudeBin(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

export interface ClaudeProfileOptions {
  /** Resolved `claude` binary; tests inject a stub here. */
  readonly bin?: string;
  /** Where the detached summary pass runs, away from any user repo. */
  readonly runDir: string;
  /** Tests stub the model round-trip; production never passes this. */
  readonly summarize?: (prompt: string) => Promise<string | null>;
}

/**
 * Claude Code adapter. Everything the rest of the fleet must never care
 * about — the CLI's flags, the settings file format, the hook vocabulary,
 * the model names — lives behind this profile.
 */
export function claudeProfile({ bin = resolveClaudeBin(), runDir, summarize }: ClaudeProfileOptions): AgentProfile {
  return {
    id: 'claude',
    label: 'Claude Code',
    models: (): readonly ModelOption[] => MODELS,
    /**
     * `claude [options] [prompt]`: the initial prompt is a positional
     * argument, so the session starts on it with no keystroke replay. The
     * `--settings` flag sits after the options and before it, exactly where
     * `claude` reads them.
     */
    launch: ({ uuid, model, settingsFile, prompt }: LaunchArgs): string => {
      const argv = [shQuote(bin)];
      argv.push('--session-id', shQuote(uuid));
      if (model) argv.push('--model', shQuote(model));
      argv.push('--settings', shQuote(settingsFile));
      if (prompt) argv.push(shQuote(prompt));
      return argv.join(' ');
    },
    // `claude --resume <uuid>` reuses the original session id, so the hooks
    // rejoin by URL routing alone, with no handshake.
    resume: ({ uuid, model, settingsFile }: ResumeArgs): string => {
      const argv = [shQuote(bin), '--resume', shQuote(uuid)];
      if (model) argv.push('--model', shQuote(model));
      argv.push('--settings', shQuote(settingsFile));
      return argv.join(' ');
    },
    writeSettings: ({ runDir: dir, uuid, host, port, token }: WriteAgentSettings): string =>
      writeSessionSettings({ runDir: dir, uuid, host, port, token }),
    settingsFile: (dir: string, uuid: string): string => claudeSettingsFile(dir, uuid),
    settingsOwner: (fileName: string): string | null => claudeSettingsOwner(fileName),
    summarize: summarize ?? createSummarize({ bin, runDir }),
    translate: (event: string, payload: HookPayload): AgentEvent | null => translate(event, payload)
  };
}