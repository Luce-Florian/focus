import { contextBridge, ipcRenderer } from 'electron';

import type { AgentId, CreateSessionSpec, FleetBridge, FleetSnapshot } from './shared/protocol.ts';

const fleet = {
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, state: FleetSnapshot) => { cb(state); }),
  onOutput: (cb) => ipcRenderer.on('pane:output', (_e, paneId: string, bytes: Uint8Array) => { cb(paneId, bytes); }),
  onNotice: (cb) => ipcRenderer.on('fleet:notice', (_e, text: string) => { cb(text); }),
  ready: () => ipcRenderer.invoke('fleet:ready'),
  agents: () => ipcRenderer.invoke('fleet:agents'),
  models: (agent: AgentId) => ipcRenderer.invoke('fleet:models', agent),
  pickDir: () => ipcRenderer.invoke('fleet:pick-dir'),
  create: (spec: CreateSessionSpec) => ipcRenderer.invoke('fleet:create', spec),
  setImportance: (uuid: string, importance: number) => { ipcRenderer.send('fleet:set-importance', uuid, importance); },
  input: (paneId, data) => { ipcRenderer.send('pane:input', paneId, data); },
  focus: (uuid) => { ipcRenderer.send('fleet:focus', uuid); },
  leave: () => { ipcRenderer.send('fleet:leave'); },
  resize: (cols, rows) => { ipcRenderer.send('fleet:resize', cols, rows); }
} satisfies FleetBridge;

contextBridge.exposeInMainWorld('fleet', fleet);