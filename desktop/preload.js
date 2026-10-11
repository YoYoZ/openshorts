// The dashboard's only door into the desktop shell: folder settings and
// opening folders in Explorer. window.desktop is undefined in a plain browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseFolder: (current) => ipcRenderer.invoke('config:choose-folder', current),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  openProjectFolder: (jobId) => ipcRenderer.invoke('folder:open-project', jobId),
  openFolder: (which) => ipcRenderer.invoke('folder:open', which),
});
