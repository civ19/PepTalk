require('@smartspectra/node-sdk/preload');
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('demo', {
  getApiKey: () => ipcRenderer.invoke('demo:api-key'),
});
