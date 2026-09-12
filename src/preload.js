const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("tactix", {
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  state: () => ipcRenderer.invoke("state:get"),
  detectGame: () => ipcRenderer.invoke("game:detect"),
  inspect: (folder) => ipcRenderer.invoke("game:inspect", folder),
  pickFolder: (title) => ipcRenderer.invoke("dialog:folder", title),
  pickArchives: () => ipcRenderer.invoke("dialog:archives"),
  clipboardPaths: () => ipcRenderer.invoke("clipboard:paths"),
  saveSetup: (payload) => ipcRenderer.invoke("setup:save", payload),
  createSandbox: () => ipcRenderer.invoke("sandbox:create"),
  analyze: (archivePath) => ipcRenderer.invoke("mods:analyze", archivePath),
  installAuto: (sourcePath) => ipcRenderer.invoke("mods:installAuto", sourcePath),
  commit: (planId) => ipcRenderer.invoke("mods:commit", planId),
  cancelPlan: (planId) => ipcRenderer.invoke("mods:cancel", planId),
  uninstall: (id) => ipcRenderer.invoke("mods:uninstall", id),
  setEnabled: (id, enabled) => ipcRenderer.invoke("mods:setEnabled", { id, enabled }),
  smartAnalyze: (sourcePath) => ipcRenderer.invoke("smart:analyze", sourcePath),
  smartCommit: (planId) => ipcRenderer.invoke("smart:commit", planId),
  smartCancel: (planId) => ipcRenderer.invoke("smart:cancel", planId),
  smartList: () => ipcRenderer.invoke("smart:list"),
  smartUninstall: (id) => ipcRenderer.invoke("smart:uninstall", id),
  smartSetEnabled: (id, enabled) => ipcRenderer.invoke("smart:setEnabled", { id, enabled }),
  launchLspdfr: () => ipcRenderer.invoke("launch:lspdfr"),
  launchOnline: () => ipcRenderer.invoke("launch:online"),
  openFolder: (which) => ipcRenderer.invoke("folder:open", which),
  openPath: (target) => ipcRenderer.invoke("folder:openPath", target),
  runTests: () => ipcRenderer.invoke("health:run"),
  crashReports: () => ipcRenderer.invoke("health:crashes"),
  fixBattlEye: () => ipcRenderer.invoke("health:fixBattlEye"),
  onLog: (fn) => {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  onProgress: (fn) => {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
});
