import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { Arbiter } from './arbiter.ts';
import * as cfg from './config.ts';
import { open, type Store } from './db.ts';
import { createFleet, resolveClaude, type Fleet } from './fleet.ts';
import { startHooksServer, type HooksServer } from './hooks-server.ts';
import { TmuxBridge } from './tmux.ts';
import { isImportance, type CreateResult, type CreateSessionSpec, type FleetSnapshot, type ModelOption } from '../shared/protocol.ts';

// A wrong ROOT would otherwise fail silently, one directory join at a time.
// Packaged, the bundle sits inside a read-only `app.asar` and derives nothing
// from ROOT: the check only means something when running from the repository.
if (!app.isPackaged) cfg.assertProjectRoot(cfg.ROOT);

/**
 * Launched from the Finder, a macOS application inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing more. Both binaries the fleet
 * spawns — `tmux` and `claude` — live where only the login shell looks
 * (Homebrew, nvm, `~/.local/bin`), so `which claude` would fail on an
 * installed build while working in development. Ask the login shell once,
 * rather than guessing a list of prefixes.
 */
function adoptLoginPath(): void {
  const shell = process.env.SHELL ?? '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    if (out) process.env.PATH = out;
  } catch (err: unknown) {
    console.warn('[env] login PATH unavailable:', err instanceof Error ? err.message : err);
  }
}

let win: BrowserWindow | null = null;
let store: Store | null = null;
let bridge: TmuxBridge | null = null;
let arbiter: Arbiter | null = null;
let hooks: HooksServer | null = null;
let fleet: Fleet | null = null;

function pushState(): void {
  if (win && !win.isDestroyed() && arbiter) win.webContents.send('fleet:state', arbiter.snapshot());
}

function notify(text: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('fleet:notice', text);
}

async function bootFleet(): Promise<void> {
  // Installed, the application lives inside a read-only `app.asar`: the run
  // directory cannot sit next to the bundle. `userData` is the writable
  // per-user location macOS hands the app; from the repository, `run/` keeps
  // settings files and the database under the developer's eyes.
  const runDir = app.isPackaged ? path.join(app.getPath('userData'), 'run') : cfg.RUN_DIR;
  mkdirSync(runDir, { recursive: true });

  store = open(path.join(runDir, 'fleet.db'));

  hooks = await startHooksServer({
    host: cfg.HOOK_HOST,
    onEvent: (evt) => arbiter?.handleHook(evt)
  });
  console.log(`[hooks] listening on http://${cfg.HOOK_HOST}:${hooks.port}`);

  arbiter = new Arbiter({ store, options: { bootTimeoutMs: cfg.BOOT_TIMEOUT_MS } });
  arbiter.on('change', pushState);
  arbiter.on('orphan', ({ uuid, event }) => {
    console.warn(`[hooks] ${event} for unknown session ${uuid}`);
  });
  arbiter.on('switch', ({ from, to, reason }) => {
    console.log(`[focus] ${from ? from.slice(0, 8) : 'none'} -> ${to.slice(0, 8)} (${reason})`);
  });
  // A launch that never draws leaves a pane stuck on `booting`: the arbiter
  // times it out, the fleet takes the window and the settings file down.
  arbiter.on('failed', ({ uuid, label }) => {
    console.warn(`[fleet] ${label} never came up, discarding ${uuid}`);
    notify(`${label} n'a pas démarré`);
    fleet?.discard(uuid).catch((err: unknown) => {
      console.error('[fleet] discard', err instanceof Error ? err.message : err);
    });
  });

  bridge = new TmuxBridge({ socket: cfg.TMUX_SOCKET, session: cfg.TMUX_SESSION });
  await bridge.createServer();
  bridge.attach();

  bridge.on('output', (paneId, bytes) => {
    // The renderer draws every pane, focused or not; the fleet reads the same
    // stream for the only liveness signal it has.
    if (win && !win.isDestroyed()) win.webContents.send('pane:output', paneId, bytes);
    fleet?.observeOutput(paneId, bytes);
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

  fleet = createFleet({
    cfg: { ...cfg, RUN_DIR: runDir },
    bridge,
    arbiter,
    hooks,
    claudeBin: resolveClaude()
  });

  // `gone` and `failed` sessions are never brought back; the queue is derived
  // state and is rebuilt from what survives.
  store.purge();

  // Sessions that were alive at the last shutdown come back on their own:
  // same uuid, fresh pane, conversation resumed. A restore that cannot happen
  // (directory gone, model retired, fleet full) is skipped with a log, not a
  // crash — the rest of the fleet still deserves to come up.
  for (const row of store.listRestorable()) {
    try {
      const s = await fleet.restoreSession(row);
      console.log(`[fleet] restored ${s.label} uuid=${s.uuid} pane=${s.paneId} window=${s.windowId}`);
    } catch (err: unknown) {
      console.error(`[fleet] restore ${row.label} failed:`, err instanceof Error ? err.message : err);
      store.deleteSession(row.uuid);
    }
  }

  // Settings files whose session is gone — purged rows, restores that rolled
  // back — outlive nothing: hook URLs in them point at a dead port anyway.
  const alive = new Set(arbiter.live().map((s) => s.uuid));
  for (const f of readdirSync(runDir)) {
    const m = /^([0-9a-f-]{36})\.settings\.json$/.exec(f);
    if (m?.[1] && !alive.has(m[1])) rmSync(path.join(runDir, f), { force: true });
  }

  // The fleet can also be seeded from config.ts; the human creates the rest
  // from the interface, on the directories they choose.
  for (const spec of cfg.SESSIONS) {
    try {
      const s = await fleet.createSession(spec);
      console.log(`[fleet] ${s.label} uuid=${s.uuid} pane=${s.paneId} window=${s.windowId}`);
    } catch (err: unknown) {
      console.error(`[fleet] seed ${spec.label} failed:`, err instanceof Error ? err.message : err);
    }
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
  if (app.isPackaged) adoptLoginPath();
  createWindow();
  try {
    await bootFleet();
  } catch (err) {
    console.error('[fleet] boot failed:', err);
  }
});

ipcMain.handle('fleet:ready', (): FleetSnapshot =>
  arbiter ? arbiter.snapshot() : { sessions: [], focused: null, lastSwitch: null }
);
ipcMain.handle('fleet:models', (): readonly ModelOption[] => cfg.MODELS);

ipcMain.handle('fleet:pick-dir', async (): Promise<string | null> => {
  if (!win || win.isDestroyed()) return null;
  const r = await dialog.showOpenDialog(win, {
    title: 'Répertoire de travail de la session',
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

ipcMain.handle('fleet:create', async (_e, spec: CreateSessionSpec): Promise<CreateResult> => {
  if (!fleet) return { ok: false, error: "la flotte n'est pas prête" };
  try {
    const s = await fleet.createSession(spec);
    console.log(`[fleet] ${s.label} uuid=${s.uuid} pane=${s.paneId} window=${s.windowId}`);
    return { ok: true, uuid: s.uuid };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[fleet] create failed:', error);
    return { ok: false, error };
  }
});

ipcMain.on('pane:input', (_e, paneId: string, data: string) => {
  const s = arbiter?.byPane(paneId);
  if (s) arbiter?.noteInput(s.uuid);
  bridge?.sendKeys(paneId, data).catch((err: unknown) => {
    console.error('[tmux] send-keys', err instanceof Error ? err.message : err);
  });
});
ipcMain.on('fleet:focus', (_e, uuid: string) => arbiter?.focus(uuid));
ipcMain.on('fleet:set-importance', (_e, uuid: string, importance: unknown) => {
  if (isImportance(importance)) arbiter?.setImportance(uuid, importance);
});
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
