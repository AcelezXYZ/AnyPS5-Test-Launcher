'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const events = ['log', 'runtime', 'game-state', 'gpus', 'app-update'];

contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('state:get'),
  scan: () => ipcRenderer.invoke('library:scan'),
  addRoot: () => ipcRenderer.invoke('roots:add'),
  removeRoot: (dir) => ipcRenderer.invoke('roots:remove', dir),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  checkRuntime: () => ipcRenderer.invoke('runtime:check'),
  checkAppUpdate: () => ipcRenderer.invoke('app:update-check'),
  installAppUpdate: () => ipcRenderer.invoke('app:update-install'),
  play: (id) => ipcRenderer.invoke('game:play', id),
  stop: (id) => ipcRenderer.invoke('game:stop', id),
  rebuild: (id) => ipcRenderer.invoke('game:rebuild', id),
  setExecutable: (id, executable) => ipcRenderer.invoke('game:executable', id, executable),
  openFolder: (id, which) => ipcRenderer.invoke('game:open', id, which),
  on: (name, callback) => {
    if (!events.includes(name)) throw new Error(`Unknown event ${name}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
