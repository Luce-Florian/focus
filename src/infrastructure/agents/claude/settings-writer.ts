import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { hookUrl } from '../../../shared/protocol.ts';
import { HOOK_EVENT_NAMES, type HookEventName } from './events.ts';

export interface HttpHook {
  readonly type: 'http';
  readonly url: string;
  readonly timeout: number;
}

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HttpHook[];
}

export interface ClaudeSessionSettings {
  readonly hooks: Partial<Record<HookEventName, readonly HookEntry[]>>;
  readonly permissions: {
    readonly defaultMode: 'default';
  };
}

/**
 * How this adapter names a session's settings file, in one place: the
 * writer below, the teardown of a failed launch and the boot sweep all go
 * through it rather than spelling the name out again.
 */
const SETTINGS_FILE = /^([0-9a-f-]{36})\.settings\.json$/;

export function claudeSettingsFile(runDir: string, uuid: string): string {
  return path.join(runDir, `${uuid}.settings.json`);
}

/** The session a run-directory entry belongs to, or null when it is not ours. */
export function claudeSettingsOwner(fileName: string): string | null {
  return SETTINGS_FILE.exec(fileName)?.[1] ?? null;
}

export interface WriteSessionSettingsOptions {
  readonly runDir: string;
  readonly uuid: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Per-session settings file handed to `claude --settings`. It merges on top
 * of the user's own configuration, so nothing here leaks into normal Claude
 * Code usage outside the fleet.
 */
export function writeSessionSettings({ runDir, uuid, host, port, token }: WriteSessionSettingsOptions): string {
  const httpHook = (event: HookEventName): HttpHook => ({
    type: 'http',
    url: hookUrl(host, port, token, uuid, event),
    timeout: 2
  });

  const hooks: Partial<Record<HookEventName, readonly HookEntry[]>> = {};
  for (const event of HOOK_EVENT_NAMES) {
    // PreToolUse / PostToolUse are matcher-based; the rest are not.
    const entry: HookEntry = event.endsWith('ToolUse')
      ? { matcher: '*', hooks: [httpHook(event)] }
      : { hooks: [httpHook(event)] };
    hooks[event] = [entry];
  }

  const settings: ClaudeSessionSettings = {
    hooks,
    permissions: {
      // The fleet needs real permission prompts, otherwise Notification
      // never fires and there is nothing to arbitrate. Local to these
      // sessions only.
      defaultMode: 'default'
    }
  };

  mkdirSync(runDir, { recursive: true });
  const file = claudeSettingsFile(runDir, uuid);
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}