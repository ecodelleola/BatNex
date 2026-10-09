"use strict";

// BatNex — Bluetooth battery monitor (Electron).
// Window + one system-tray icon per device, each showing its battery %.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");

const { scanDevices } = require("./lib/bluetooth");
const { styleFor } = require("./lib/classify");
const { batteryIconPng } = require("./lib/trayIcon");

const MAIN_TRAY_ID = "batnex-main";
const MAX_DEVICE_TRAYS = 8;
const QUICK_POLL_MS = 15000; // cheap connected-list check; battery reads only on change
const BATTERY_RETRY_MS = 60000; // re-attempt unread batteries this often
const SELF_TEST = process.argv.includes("--self-test");
const VALID_TYPES = ["headphones", "headset", "earbuds", "speaker", "mouse", "keyboard", "controller", "phone", "bluetooth"];

let win = null;
let quitting = false;
let scanning = false;
let lastDevices = [];
let lastError = null;
let lastBatteryAttempt = 0;
// User-chosen device types (device id -> type), persisted across restarts.
let typeOverrides = {};

function overridesPath() {
  return path.join(app.getPath("userData"), "type-overrides.json");
}

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesPath(), "utf8"));
    typeOverrides = {};
    for (const [id, type] of Object.entries(raw || {})) {
      if (typeof id === "string" && VALID_TYPES.includes(type)) typeOverrides[id] = type;
    }
  } catch {
    typeOverrides = {};
  }
}

function saveOverrides() {
  try {
    fs.writeFileSync(overridesPath(), JSON.stringify(typeOverrides));
  } catch (e) {
    console.error(`[tray] saving type overrides failed: ${(e && e.message) || e}`);
  }
}
/** @type {Map<string, Electron.Tray>} */
const trays = new Map();

function deviceId(address) {
  return String(address).replace(/[^a-zA-Z0-9]/g, "");
}

function enrich(raw) {
  // Device type comes from the scanner (name + Bluetooth Class of Device),
  // unless the user overrode it. baseType preserves the auto-detected value
  // so overrides never stack and a cleared override restores it.
  const id = deviceId(raw.address);
  const baseType = raw.deviceType || "bluetooth";
  const type = typeOverrides[id] || baseType;
  const s = styleFor(type);
  return {
    id,
    name: raw.name,
    address: raw.address,
    deviceType: type,
    baseType,
    emoji: s.emoji,
    accent: s.accent,
    connected: true, // the scanner only returns connected devices
    batteryPercent: raw.battery === null || raw.battery === undefined ? null : raw.battery,
    batteryError: raw.batteryError || null,
    batterySource: raw.batterySource || null,
    charging: raw.charging === true,
  };
}

function deviceLabel(d) {
  return d.batteryPercent === null
    ? `${d.emoji} ${d.name}: battery n/a`
    : `${d.emoji} ${d.name}: ${d.batteryPercent}%`;
}

function iconFor(battery, deviceType) {
  return nativeImage.createFromBuffer(batteryIconPng(battery, deviceType));
}

function isLaunchAtLogin() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLaunchAtLogin(on) {
  try {
    // --hidden makes auto-started launches begin in the tray, not the face.
    app.setLoginItemSettings(on ? { openAtLogin: true, args: ["--hidden"] } : { openAtLogin: false });
  } catch (e) {
    console.error(`[tray] run-at-startup failed: ${(e && e.message) || e}`);
  }
}

function startupMenuItem() {
  return {
    label: "Run at startup",
    type: "checkbox",
    checked: isLaunchAtLogin(),
    click: (item) => {
      setLaunchAtLogin(item.checked);
      updateTrays(lastDevices); // refresh checkmarks immediately
    },
  };
}

function mainMenuTemplate(devices) {
  const tpl = [
    { label: "Show Batnex", click: () => showWindow() },
    { label: "Refresh now", click: () => void refreshAll() },
    { type: "separator" },
    ...devices.map((d, i) => ({ id: `batnex-dev-${i}`, label: deviceLabel(d), enabled: false })),
  ];
  if (devices.length) tpl.push({ type: "separator" });
  tpl.push(startupMenuItem());
  tpl.push({ label: "Quit Batnex", click: () => { quitting = true; app.quit(); } });
  return tpl;
}

function deviceMenuTemplate(d) {
  const batt = d.batteryPercent === null ? "battery n/a" : `${d.batteryPercent}%`;
  return [
    { label: `${d.emoji} ${d.name}: ${batt}`, enabled: false },
    { type: "separator" },
    { label: "Show Batnex", click: () => showWindow() },
    { label: "Refresh now", click: () => void refreshAll() },
    { type: "separator" },
    startupMenuItem(),
    { label: "Quit Batnex", click: () => { quitting = true; app.quit(); } },
  ];
}

function hasBattery(d) {
  return d.batteryPercent !== null && d.batteryPercent !== undefined;
}

function updateTrays(devices) {
  // One tray icon per device that reports a battery level. Devices without
  // battery info get no icon. The manager icon only exists while no battery
  // icons exist, so the app stays reachable from the tray.
  const charged = devices.filter(hasBattery).slice(0, MAX_DEVICE_TRAYS);
  if (charged.length === 0) {
    let main = trays.get(MAIN_TRAY_ID);
    if (!main) {
      main = new Tray(iconFor(null));
      main.on("click", () => showWindow());
      trays.set(MAIN_TRAY_ID, main);
    }
    main.setImage(iconFor(null));
    main.setToolTip(devices.length ? "Batnex: no battery info" : "Batnex: no connected devices");
    main.setContextMenu(Menu.buildFromTemplate(mainMenuTemplate(devices)));
  } else {
    const main = trays.get(MAIN_TRAY_ID);
    if (main) {
      try { main.destroy(); } catch { /* already gone */ }
      trays.delete(MAIN_TRAY_ID);
    }
  }

  // One circular battery icon per device, with its own menu.
  const seen = new Set();
  for (const d of charged) {
    const id = `batnex-dev-${d.id}`;
    seen.add(id);
    const img = iconFor(d.batteryPercent, d.deviceType);
    const tip = `${d.name}: ${d.batteryPercent}%`;
    let tray = trays.get(id);
    if (!tray) {
      tray = new Tray(img);
      tray.on("click", () => showWindow());
      trays.set(id, tray);
    }
    tray.setImage(img);
    tray.setToolTip(tip);
    tray.setContextMenu(Menu.buildFromTemplate(deviceMenuTemplate(d)));
  }

  // Remove icons for devices that disappeared.
  for (const [id, tray] of trays) {
    if (id !== MAIN_TRAY_ID && !seen.has(id)) {
      try { tray.destroy(); } catch { /* already gone */ }
      trays.delete(id);
    }
  }
}

function applyOverride(d) {
  const type = typeOverrides[d.id] || d.baseType || "bluetooth";
  const s = styleFor(type);
  return { ...d, deviceType: type, emoji: s.emoji, accent: s.accent };
}

function pushUpdate() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("batnex:devices", { devices: lastDevices, error: lastError });
  }
}

async function fullRefresh() {
  const result = await scanDevices({ batteries: true });
  lastBatteryAttempt = Date.now();
  if (result.ok) {
    lastDevices = result.devices.map(enrich);
    lastError = null;
    for (const d of lastDevices) {
      if (d.batteryPercent === null && d.batteryError) {
        console.log(`[battery] ${d.name} (${d.address}): ${d.batteryError}`);
      } else if (d.batteryPercent !== null && d.batterySource === "OS") {
        console.log(`[battery] ${d.name} (${d.address}): ${d.batteryPercent}% via OS report (same as Settings)`);
      }
    }
  } else {
    lastError = result.error;
  }
  updateTrays(lastDevices);
  pushUpdate();
  return lastDevices;
}

async function refreshAll() {
  if (scanning) return lastDevices;
  scanning = true;
  try {
    await fullRefresh();
  } finally {
    scanning = false;
  }
  return lastDevices;
}

function sameSet(a, b) {
  const ids = (list) => list.map((d) => d.address).sort().join(",");
  return ids(a) === ids(b);
}

// Auto-detect: cheap connected-list poll; only GATT-read batteries when the
// set changes (or periodically while some batteries are still unknown).
async function quickPoll() {
  if (scanning) return;
  scanning = true;
  try {
    const result = await scanDevices({ batteries: false });
    if (!result.ok) {
      if (result.error !== lastError) {
        lastError = result.error;
        pushUpdate();
      }
      return;
    }
    lastError = null;
    const fresh = result.devices.map(enrich);
    if (!sameSet(fresh, lastDevices)) {
      console.log("[tray] device set changed, reading batteries…");
      await fullRefresh();
      return;
    }
    // Same devices: refresh names in place (cheap, no GATT reads).
    const names = new Map(fresh.map((d) => [d.address, d.name]));
    let renamed = false;
    for (const d of lastDevices) {
      const n = names.get(d.address);
      if (n && n !== d.name) {
        d.name = n;
        renamed = true;
      }
    }
    if (renamed) {
      updateTrays(lastDevices);
      pushUpdate();
    }
    const needsBatteries = lastDevices.some((d) => d.batteryPercent === null);
    if (needsBatteries && Date.now() - lastBatteryAttempt > BATTERY_RETRY_MS) {
      console.log("[tray] retrying unread batteries…");
      await fullRefresh();
    }
  } finally {
    scanning = false;
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  win.show();
  win.focus();
}

function wasOpenedAtLogin() {
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

function createWindow(startShown = true) {
  win = new BrowserWindow({
    width: 460,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    title: "BATNEX",
    backgroundColor: "#0a0e0c",
    autoHideMenuBar: true,
    show: startShown,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Surface renderer errors in the main-process log for easier debugging.
  win.webContents.on("console-message", (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // closing hides to the tray instead of quitting
    }
  });
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Auto-started launches (login item with --hidden) begin in the tray.
  const startHidden = !SELF_TEST && (process.argv.includes("--hidden") || wasOpenedAtLogin());
  if (startHidden) console.log("[app] auto-start detected, beginning hidden in tray");
  loadOverrides();
  createWindow(!startHidden);

  ipcMain.handle("batnex:refresh", async () => {
    const devices = await refreshAll();
    return { devices, error: lastError };
  });
  ipcMain.handle("batnex:cached", () => ({ devices: lastDevices, error: lastError }));
  ipcMain.handle("batnex:set-type", (_event, id, type) => {
    if (typeof id !== "string" || !VALID_TYPES.includes(type)) {
      return { devices: lastDevices, error: lastError };
    }
    typeOverrides[id] = type;
    saveOverrides();
    lastDevices = lastDevices.map((d) => (d.id === id ? applyOverride(d) : d));
    updateTrays(lastDevices);
    pushUpdate();
    return { devices: lastDevices, error: lastError };
  });
  ipcMain.handle("batnex:minimize", () => {
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });
  ipcMain.handle("batnex:close", () => {
    if (win && !win.isDestroyed()) win.close(); // 'close' handler hides to tray
    return true;
  });

  // First full scan shortly after launch, then cheap auto-detect polling.
  // Battery GATT reads happen only when the device set changes (or while
  // some batteries are still unknown), so connects/disconnects appear alone.
  setTimeout(() => void refreshAll(), SELF_TEST ? 500 : 3000);
  if (!SELF_TEST) {
    setInterval(() => void quickPoll(), QUICK_POLL_MS);
  } else {
    // Smoke-test mode: report state, then quit ~25s after launch
    // (covers window + first scan + trays).
    setTimeout(() => {
      console.log(
        `SELF-TEST devices=${lastDevices.length} trays=${trays.size} ` +
          `error=${lastError === null ? "none" : JSON.stringify(lastError)}`
      );
    }, 20000);
    setTimeout(() => { quitting = true; app.quit(); }, 25000);
  }

  app.on("activate", () => showWindow());
});

app.on("window-all-closed", () => {
  // Keep running in the tray; quit explicitly via the tray menu.
});
