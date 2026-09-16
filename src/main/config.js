'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  ROOT,
  RUN_DIR: path.join(ROOT, 'run'),
  DB_PATH: path.join(ROOT, 'run', 'fleet.db'),

  // Dedicated tmux server: own socket + `-f /dev/null` so the user's tmux.conf
  // and existing sessions are never touched.
  TMUX_SOCKET: 'fleet-poc',
  TMUX_SESSION: 'fleet',

  HOOK_HOST: '127.0.0.1',

  // The walking skeleton drives exactly two sessions.
  SESSIONS: [
    { label: 'alpha', cwd: path.join(ROOT, 'workspaces', 'alpha') },
    { label: 'beta', cwd: path.join(ROOT, 'workspaces', 'beta') }
  ],

  // Hook events the arbiter subscribes to.
  HOOK_EVENTS: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'SessionEnd'
  ]
};
