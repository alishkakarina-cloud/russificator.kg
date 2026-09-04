const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('automaxkg', {
  status: () => ipcRenderer.invoke('automaxkg-status'),
  getCleanupResult: () => ipcRenderer.invoke('automaxkg-cleanup-result'),
  download: (files) => ipcRenderer.invoke('automaxkg-download', { files }),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('automaxkg-download-progress', (_event, data) => callback(data));
  },
  startTerminal: (cols, rows) => ipcRenderer.invoke('automaxkg-terminal-start', { cols, rows }),
  sendInput: (data) => ipcRenderer.send('automaxkg-terminal-input', data),
  resizeTerminal: (cols, rows) => ipcRenderer.send('automaxkg-terminal-resize', { cols, rows }),
  killTerminal: () => ipcRenderer.invoke('automaxkg-terminal-kill'),
  onTerminalData: (callback) => {
    ipcRenderer.on('automaxkg-terminal-data', (_event, data) => callback(data));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on('automaxkg-terminal-exit', (_event, info) => callback(info));
  },
});

contextBridge.exposeInMainWorld('app', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  setAdminMode: (isAdmin) => ipcRenderer.invoke('set-admin-mode', isAdmin),
  setTerminalMode: (isTerminal) => ipcRenderer.invoke('set-terminal-mode', isTerminal),
});

contextBridge.exposeInMainWorld('sessionStore', {
  get: () => ipcRenderer.invoke('session-get'),
  set: (data) => ipcRenderer.invoke('session-set', data),
  clear: () => ipcRenderer.invoke('session-clear'),
  touch: () => ipcRenderer.invoke('session-touch'),
});
