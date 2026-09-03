const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('automaxkg', {
  launch: () => ipcRenderer.invoke('launch-automaxkg'),
});

contextBridge.exposeInMainWorld('app', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-app-version'),
});

contextBridge.exposeInMainWorld('sessionStore', {
  get: () => ipcRenderer.invoke('session-get'),
  set: (data) => ipcRenderer.invoke('session-set', data),
  clear: () => ipcRenderer.invoke('session-clear'),
  touch: () => ipcRenderer.invoke('session-touch'),
});
