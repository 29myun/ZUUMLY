const { contextBridge, ipcRenderer } = require("electron");

// Expose a minimal IPC surface to renderer code via window.screenAssist.
contextBridge.exposeInMainWorld("screenAssist", {
  listSources: () => ipcRenderer.invoke("list-sources"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  restoreWindow: () => ipcRenderer.invoke("restore-window"),
  onScreenSelection: (callback) =>
    ipcRenderer.on("screen-selection", (_event, rect) => callback(rect)),
  openOverlay: () => ipcRenderer.send("open-overlay"),
  saveSnapshot: (dataUrl) => ipcRenderer.invoke("save-snapshot", dataUrl),
  readSnapshot: (filePath) => ipcRenderer.invoke("read-snapshot", filePath),
  deleteSnapshot: (filePath) => ipcRenderer.invoke("delete-snapshot", filePath),
});
