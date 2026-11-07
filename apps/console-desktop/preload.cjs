const { contextBridge, ipcRenderer } = require('electron');
const initial = ipcRenderer.sendSync('desktop:initial');
contextBridge.exposeInMainWorld('desktop', {
  shutdownOnExit: true,
  initialTheme: initial.theme,
  initialAppearance: initial.appearance,
  initialPreset: initial.preset,
  chooseBackground: () => ipcRenderer.invoke('desktop:appearance-choose'),
  setBackgroundStrength: strength => ipcRenderer.invoke('desktop:appearance-strength', strength),
  resetBackground: () => ipcRenderer.invoke('desktop:appearance-reset'),
  setTheme: theme => ipcRenderer.invoke('desktop:theme', theme),
  setPreset: preset => ipcRenderer.invoke('desktop:preset', preset),
  exportLog: (text, name) => ipcRenderer.invoke('desktop:export-log', { text, name }),
  copyPluginPath: () => ipcRenderer.invoke('desktop:plugin-path'),
  openPluginFolder: () => ipcRenderer.invoke('desktop:plugin-folder'),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url),
  onQuitCheck: callback => {if(typeof callback==='function')ipcRenderer.on('desktop:check-unsaved',(_event,id)=>ipcRenderer.send('desktop:unsaved-answer',id,Boolean(callback())));},
  onShutdownState: callback => {if(typeof callback==='function')ipcRenderer.on('desktop:shutdown-state',(_event,state)=>callback(state));},
});
