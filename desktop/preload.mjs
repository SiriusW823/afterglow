// Sandboxed Electron preloads execute as plain JavaScript and receive Electron's
// restricted `require` shim, even when the filename ends in `.mjs`.
const { contextBridge, ipcRenderer } = require("electron");

const platform = ["win32", "linux", "darwin"].includes(process.platform)
  ? process.platform
  : "linux";

contextBridge.exposeInMainWorld("afterglowDesktop", Object.freeze({
  platform,
  storage: Object.freeze({
    read: (key) => ipcRenderer.invoke("afterglow:storage:read", key),
    write: (key, value) => ipcRenderer.invoke("afterglow:storage:write", key, value),
    remove: (key) => ipcRenderer.invoke("afterglow:storage:remove", key),
  }),
  sync: Object.freeze({
    fetch: (request) => ipcRenderer.invoke("afterglow:sync:fetch", request),
  }),
}));
