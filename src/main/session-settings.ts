import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { hookUrl, type HookEventName } from '../shared/protocol.ts';

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

export interface WriteSessionSettingsOptions {
  readonly runDir: string;
  readonly uuid: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly events: readonly HookEventName[];
}

/**
 * Per-session settings file handed to `claude --settings`. It merges on top
 * of the user's own configuration, so nothing here leaks into normal Claude
 * Code usage outside the fleet.
 */
export function writeSessionSettings({ runDir, uuid, host, port, token, events }: WriteSessionSettingsOptions): string {
  const httpHook = (event: HookEventName): HttpHook => ({
    type: 'http',
    url: hookUrl(host, port, token, uuid, event),
    timeout: 2
  });

  const hooks: Partial<Record<HookEventName, readonly HookEntry[]>> = {};
  for (const event of events) {
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
  const file = path.join(runDir, `${uuid}.settings.json`);
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}
