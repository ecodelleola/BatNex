"use strict";

// Exposes a minimal, safe API to the renderer (context isolation stays on).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("batnex", {
  /** Full re-scan (slow). Returns { devices, error }. */
  refresh: () => ipcRenderer.invoke("batnex:refresh"),
  /** Last scan results without re-scanning (instant). */
  cached: () => ipcRenderer.invoke("batnex:cached"),
  /** Minimize the frameless window. */
  minimize: () => ipcRenderer.invoke("batnex:minimize"),
  /** Close the frameless window (hides to tray). */
  close: () => ipcRenderer.invoke("batnex:close"),
  /** Pushed by the main process after background scans. */
  onDevices: (cb) => ipcRenderer.on("batnex:devices", (_event, payload) => cb(payload)),
});
