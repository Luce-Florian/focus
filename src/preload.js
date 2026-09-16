'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  onState: (cb) => ipcRenderer.on('fleet:state', (_e, state) => cb(state)),
  onOutput: (cb) => ipcRenderer.on('pane:output', (_e, paneId, bytes) => cb(paneId, bytes)),
  ready: () => ipcRenderer.invoke('fleet:ready'),
  input: (paneId, data) => ipcRenderer.send('pane:input', paneId, data),
  focus: (uuid) => ipcRenderer.send('fleet:focus', uuid),
  leave: () => ipcRenderer.send('fleet:leave'),
  pin: (pinned) => ipcRenderer.send('fleet:pin', pinned),
  resize: (cols, rows) => ipcRenderer.send('fleet:resize', cols, rows)
});
