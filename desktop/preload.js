const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('RMDesktop', {
  isDesktop: true,
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
});
