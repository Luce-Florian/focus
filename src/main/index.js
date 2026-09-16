'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const cfg = require('./config');
const { open } = require('./db');
const { TmuxBridge } = require('./tmux');
const { startHooksServer } = require('./hooks-server');
const { Arbiter } = require('./arbiter');
const { writeSessionSettings } = require('./session-settings');

let win = null;
let store = null;
let bridge = null;
let arbiter = null;
let hooks = null;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function resolveClaude() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('fleet:state', arbiter.snapshot());
}

async function bootFleet() {
  store = open(cfg.DB_PATH);

  hooks = await startHooksServer({
    host: cfg.HOOK_HOST,
    onEvent: (evt) => arbiter.handleHook(evt)
  });
  console.log(`[hooks] listening on http://${cfg.HOOK_HOST}:${hooks.port}`);

  arbiter = new Arbiter({ store });
  arbiter.on('change', pushState);
  arbiter.on('orphan', ({ uuid, event }) =>
    console.warn(`[hooks] ${event} for unknown session ${uuid}`)
  );
  arbiter.on('switch', ({ from, to, reason }) =>
    console.log(`[focus] ${from ? from.slice(0, 8) : 'none'} -> ${to.slice(0, 8)} (${reason})`)
  );

  bridge = new TmuxBridge({ socket: cfg.TMUX_SOCKET, session: cfg.TMUX_SESSION });
  await bridge.createServer();
  bridge.attach();

  bridge.on('output', (paneId, bytes) => {
    if (win && !win.isDestroyed()) win.webContents.send('pane:output', paneId, bytes);
  });
  bridge.on('window-closed', (windowId) => {
    const s = arbiter.byWindow(windowId);
    if (s) arbiter.markGone(s.uuid);
  });
  bridge.on('stderr', (d) => console.error('[tmux]', String(d).trim()));
  bridge.on('control-exit', (r) => console.warn('[tmux] control channel exited', r));

  const claudeBin = resolveClaude();

  for (const spec of cfg.SESSIONS) {
    // The uuid is minted here, before the pane exists: the Claude session and
    // the tmux pane are joined by construction, never discovered afterwards.
    const uuid = crypto.randomUUID();
    const settingsFile = writeSessionSettings({
      runDir: cfg.RUN_DIR,
      uuid,
      host: cfg.HOOK_HOST,
      port: hooks.port,
      token: hooks.token,
      events: cfg.HOOK_EVENTS
    });

    const inner = `${shQuote(claudeBin)} --session-id ${uuid} --settings ${shQuote(settingsFile)}`;
    // Keep the pane alive after Claude exits so the final screen stays readable.
    const command = `${inner}; printf '\\n[session ended]\\n'; exec sleep 86400`;

    const { windowId, paneId } = await bridge.newSessionWindow({
      label: spec.label,
      cwd: spec.cwd,
      command: `sh -c ${shQuote(command)}`
    });

    arbiter.register({ uuid, label: spec.label, cwd: spec.cwd, paneId, windowId });
    console.log(`[fleet] ${spec.label} uuid=${uuid} pane=${paneId} window=${windowId}`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#101014',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js') }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  try {
    await bootFleet();
  } catch (err) {
    console.error('[fleet] boot failed:', err);
  }
});

ipcMain.handle('fleet:ready', () => (arbiter ? arbiter.snapshot() : { sessions: [], queue: [], focused: null }));
ipcMain.on('pane:input', (_e, paneId, data) => {
  const s = arbiter?.byPane(paneId);
  if (s) arbiter.noteInput(s.uuid);
  bridge?.sendKeys(paneId, data).catch((err) => console.error('[tmux] send-keys', err.message));
});
ipcMain.on('fleet:pin', (_e, pinned) => arbiter?.setPinned(pinned));
ipcMain.on('fleet:focus', (_e, uuid) => arbiter?.focus(uuid));
ipcMain.on('fleet:leave', () => arbiter?.leave());
ipcMain.on('fleet:resize', (_e, cols, rows) => {
  bridge?.setClientSize(cols, rows).catch(() => {});
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', async (e) => {
  if (!bridge) return;
  e.preventDefault();
  const b = bridge;
  bridge = null;
  try {
    await b.kill();
  } catch {
    // Nothing left to kill.
  }
  store?.close();
  app.quit();
});
