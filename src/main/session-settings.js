'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Per-session settings file handed to `claude --settings`. It merges on top of
 * the user's own configuration, so nothing here leaks into normal Claude Code
 * usage outside the fleet.
 */
function writeSessionSettings({ runDir, uuid, host, port, token, events }) {
  const url = (event) => `http://${host}:${port}/h/${token}/${uuid}/${event}`;
  const httpHook = (event) => ({ type: 'http', url: url(event), timeout: 2 });

  const hooks = {};
  for (const event of events) {
    // PreToolUse / PostToolUse are matcher-based; the rest are not.
    const entry = event.endsWith('ToolUse')
      ? { matcher: '*', hooks: [httpHook(event)] }
      : { hooks: [httpHook(event)] };
    hooks[event] = [entry];
  }

  const settings = {
    hooks,
    permissions: {
      // The fleet needs real permission prompts, otherwise Notification never
      // fires and there is nothing to arbitrate. Local to these sessions only.
      defaultMode: 'default'
    }
  };

  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, `${uuid}.settings.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

module.exports = { writeSessionSettings };
