import { contextBridge, ipcRenderer } from 'electron';

import type { CreateSessionSpec, FleetBridge, FleetSnapshot } from './shared/protocol.ts';

const fleet = {
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, state: FleetSnapshot) => { cb(state); }),
  onOutput: (cb) => ipcRenderer.on('pane:output', (_e, paneId: string, bytes: Uint8Array) => { cb(paneId, bytes); }),
  onNotice: (cb) => ipcRenderer.on('fleet:notice', (_e, text: string) => { cb(text); }),
  ready: () => ipcRenderer.invoke('fleet:ready'),
  models: () => ipcRenderer.invoke('fleet:models'),
  pickDir: () => ipcRenderer.invoke('fleet:pick-dir'),
  create: (spec: CreateSessionSpec) => ipcRenderer.invoke('fleet:create', spec),
  input: (paneId, data) => { ipcRenderer.send('pane:input', paneId, data); },
  focus: (uuid) => { ipcRenderer.send('fleet:focus', uuid); },
  leave: () => { ipcRenderer.send('fleet:leave'); },
  pin: (pinned) => { ipcRenderer.send('fleet:pin', pinned); },
  resize: (cols, rows) => { ipcRenderer.send('fleet:resize', cols, rows); }
} satisfies FleetBridge;

contextBridge.exposeInMainWorld('fleet', fleet);
