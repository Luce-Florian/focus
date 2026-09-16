import { contextBridge, ipcRenderer } from 'electron';

import type { FleetBridge, FleetSnapshot } from './shared/protocol.ts';

const fleet = {
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, state: FleetSnapshot) => cb(state)),
  onOutput: (cb) => ipcRenderer.on('pane:output', (_e, paneId: string, bytes: ArrayBuffer) => cb(paneId, bytes)),
  ready: () => ipcRenderer.invoke('fleet:ready'),
  input: (paneId, data) => ipcRenderer.send('pane:input', paneId, data),
  focus: (uuid) => ipcRenderer.send('fleet:focus', uuid),
  leave: () => ipcRenderer.send('fleet:leave'),
  pin: (pinned) => ipcRenderer.send('fleet:pin', pinned),
  resize: (cols, rows) => ipcRenderer.send('fleet:resize', cols, rows)
} satisfies FleetBridge;

contextBridge.exposeInMainWorld('fleet', fleet);
