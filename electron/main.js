const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const ROOT = path.join(__dirname, "..");

app.commandLine.appendSwitch("enable-features", "WebBluetooth,WebBluetoothNewPermissionsBackend");
app.commandLine.appendSwitch("enable-web-bluetooth");

function createWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 860,
    minWidth: 380,
    minHeight: 640,
    title: "Walkie Talkie | M-OS",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(ROOT, "walkie.html"));
}

function parseWifiNetworks(stdout) {
  const names = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*SSID \d+\s*:\s*(.+)\s*$/);
    if (match) {
      const name = match[1].trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

async function scanWifiWindows() {
  if (process.platform !== "win32") {
    return { ok: false, networks: [], message: "WiFi scan runs on Windows only." };
  }
  try {
    const { stdout } = await execAsync("netsh wlan show networks mode=Bssid", {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000
    });
    const networks = parseWifiNetworks(stdout);
    let connected = "";
    try {
      const iface = await execAsync("netsh wlan show interfaces", {
        encoding: "utf8",
        windowsHide: true
      });
      const ssid = iface.stdout.match(/^\s*SSID\s*:\s*(.+)\s*$/m);
      if (ssid) connected = ssid[1].trim();
    } catch {
      /* ignore */
    }
    return { ok: true, networks, connected, message: "" };
  } catch (err) {
    return { ok: false, networks: [], message: err.message || "WiFi scan failed" };
  }
}

ipcMain.handle("scan-wifi", scanWifiWindows);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});