const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('automaxkg', {
  launch: () => ipcRenderer.invoke('launch-automaxkg'),
});

contextBridge.exposeInMainWorld('app', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
