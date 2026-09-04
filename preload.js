const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('automaxkg', {
  launch: () => ipcRenderer.invoke('launch-automaxkg'),
  status: () => ipcRenderer.invoke('automaxkg-status'),
  download: (files) => ipcRenderer.invoke('automaxkg-download', { files }),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('automaxkg-download-progress', (_event, data) => callback(data));
  },
});

contextBridge.exposeInMainWorld('app', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  setAdminMode: (isAdmin) => ipcRenderer.invoke('set-admin-mode', isAdmin),
});

contextBridge.exposeInMainWorld('sessionStore', {
  get: () => ipcRenderer.invoke('session-get'),
  set: (data) => ipcRenderer.invoke('session-set', data),
  clear: () => ipcRenderer.invoke('session-clear'),
  touch: () => ipcRenderer.invoke('session-touch'),
});
