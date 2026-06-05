const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("windowsAPI", {
  isDesktop: true,
  platform: process.platform,
  scanWifiNetworks: () => ipcRenderer.invoke("scan-wifi")
});