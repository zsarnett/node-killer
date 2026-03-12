const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nodeKillerPrefs', {
  get: () => ipcRenderer.invoke('prefs:get'),
  setAutoLaunch: (value) => ipcRenderer.invoke('prefs:set-autoLaunch', value),
  setRefresh: (value) => ipcRenderer.invoke('prefs:set-refresh', value),
  setAllUsers: (value) => ipcRenderer.invoke('prefs:set-allUsers', value),
  setIncludeNonListening: (value) => ipcRenderer.invoke('prefs:set-includeNonListening', value),
  setDisplayMode: (value) => ipcRenderer.invoke('prefs:set-display', value),
  setProcessType: (typeName, enabled) => ipcRenderer.invoke('prefs:set-processType', typeName, enabled),
  setProcessTypes: (types) => ipcRenderer.invoke('prefs:set-processTypes', types),
  openExternal: (url) => ipcRenderer.invoke('prefs:openExternal', url),
});
