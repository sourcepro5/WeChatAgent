const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loading', { onProgress: callback => ipcRenderer.on('deployment:progress', (_event, message) => callback(String(message))) });
