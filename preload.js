const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('automaxkg', {
  launch: () => ipcRenderer.invoke('launch-automaxkg'),
});
