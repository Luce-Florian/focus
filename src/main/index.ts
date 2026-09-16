import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { Arbiter } from './arbiter.ts';
import * as cfg from './config.ts';
import { open, type Store } from './db.ts';
import { startHooksServer, type HooksServer } from './hooks-server.ts';
import { writeSessionSettings } from './session-settings.ts';
import { TmuxBridge } from './tmux.ts';
import type { FleetSnapshot } from '../shared/protocol.ts';

// A wrong ROOT would otherwise fail silently, one directory join at a time.
cfg.assertProjectRoot(cfg.ROOT);

let win: BrowserWindow | null = null;
let store: Store | null = null;
let bridge: TmuxBridge | null = null;
let arbiter: Arbiter | null = null;
let hooks: HooksServer | null = null;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveClaude(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

function pushState(): void {
  if (win && !win.isDestroyed() && arbiter) win.webContents.send('fleet:state', arbiter.snapshot());
}

async function bootFleet(): Promise<void> {
  store = open(cfg.DB_PATH);

  hooks = await startHooksServer({
    host: cfg.HOOK_HOST,
    onEvent: (evt) => arbiter?.handleHook(evt)
  });
  console.log(`[hooks] listening on http://${cfg.HOOK_HOST}:${hooks.port}`);

  arbiter = new Arbiter({ store });
  arbiter.on('change', pushState);
  arbiter.on('orphan', ({ uuid, event }) => {
    console.warn(`[hooks] ${event} for unknown session ${uuid}`);
  });
  arbiter.on('switch', ({ from, to, reason }) => {
    console.log(`[focus] ${from ? from.slice(0, 8) : 'none'} -> ${to.slice(0, 8)} (${reason})`);
  });

  bridge = new TmuxBridge({ socket: cfg.TMUX_SOCKET, session: cfg.TMUX_SESSION });
  await bridge.createServer();
  bridge.attach();

  bridge.on('output', (paneId, bytes) => {
    if (win && !win.isDestroyed()) win.webContents.send('pane:output', paneId, bytes);
  });
  bridge.on('window-closed', (windowId) => {
    const s = arbiter?.byWindow(windowId);
    if (s) arbiter?.markGone(s.uuid);
  });
  bridge.on('stderr', (d) => {
    console.error('[tmux]', d.trim());
  });
  bridge.on('control-exit', (r) => {
    console.warn('[tmux] control channel exited', r);
  });

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#101014',
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs') }
  });
  void win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
}

void app.whenReady().then(async () => {
  createWindow();
  try {
    await bootFleet();
  } catch (err) {
    console.error('[fleet] boot failed:', err);
  }
});

ipcMain.handle('fleet:ready', (): FleetSnapshot =>
  arbiter ? arbiter.snapshot() : { sessions: [], focused: null, pinned: false, lastSwitch: null }
);
ipcMain.on('pane:input', (_e, paneId: string, data: string) => {
  const s = arbiter?.byPane(paneId);
  if (s) arbiter?.noteInput(s.uuid);
  bridge?.sendKeys(paneId, data).catch((err: unknown) => {
    console.error('[tmux] send-keys', err instanceof Error ? err.message : err);
  });
});
ipcMain.on('fleet:pin', (_e, pinned: boolean) => arbiter?.setPinned(pinned));
ipcMain.on('fleet:focus', (_e, uuid: string) => arbiter?.focus(uuid));
ipcMain.on('fleet:leave', () => arbiter?.leave());
ipcMain.on('fleet:resize', (_e, cols: number, rows: number) => {
  bridge?.setClientSize(cols, rows).catch(() => undefined);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (e) => {
  if (!bridge) return;
  e.preventDefault();
  const b = bridge;
  bridge = null;
  // Electron's listener must stay synchronous: the cleanup itself is async
  // (killing the tmux control channel, closing the store), so it runs as an
  // explicitly-unhandled promise rather than as the listener's own return value.
  void (async () => {
    try {
      await b.kill();
    } catch {
      // Nothing left to kill.
    }
    store?.close();
    app.quit();
  })();
});
