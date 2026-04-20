const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onUsage: (cb) => ipcRenderer.on('usage', (_e, data) => cb(data)),
  openUsage: () => ipcRenderer.invoke('open-usage'),
  refresh: () => ipcRenderer.invoke('request-refresh'),
});
