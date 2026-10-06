const { contextBridge, ipcRenderer } = require('electron');
const initial = ipcRenderer.sendSync('desktop:initial');
contextBridge.exposeInMainWorld('desktop', {
  initialTheme: initial.theme,
  setTheme: theme => ipcRenderer.invoke('desktop:theme', theme),
  exportLog: (text, name) => ipcRenderer.invoke('desktop:export-log', { text, name }),
  copyPluginPath: () => ipcRenderer.invoke('desktop:plugin-path'),
  openPluginFolder: () => ipcRenderer.invoke('desktop:plugin-folder'),
});
