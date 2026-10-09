# <img src="assets/icon.png" width="64" alt="Batnex logo"> Batnex

A Windows desktop app that shows the **battery percentage of your connected
Bluetooth devices** — in a compact window and as **live system-tray icons**
(one icon per device).

![platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![electron](https://img.shields.io/badge/electron-44-blue)
![python](https://img.shields.io/badge/python-3.12%20%28bundled%29-green)

## Features

- **Connected-only list** — paired devices are checked against live Windows
  connection state; nearby strangers never appear.
- **Battery from the same source as Settings** — Windows' own per-device
  battery cache first (instant), direct BLE Battery Service reads as fallback.
- **Per-device tray icons** — the device glyph in its level color
  (100–80 green, 79–50 blue, 49–20 yellow, 19–0 red), with `Name: 85%`
  tooltips. Devices without a reading get no tray icon.
- **Auto-detect** — connections and disconnections appear on their own
  (15s lightweight poll, battery reads only on change); no refresh needed.
- **Fixable device types** — the type label is a dropdown; your pick
  overrides auto-detection everywhere (window + tray) and persists.
- **Run at startup** — tray-menu checkbox; auto-started launches begin
  hidden in the tray.
- **Zero-install dependencies for end users** — the installer bundles a
  private Python runtime; no system Python needed.

## How it works

- `scripts/bt_battery.py` reads the paired-device list from the Windows
  Bluetooth registry, checks each device's **live connection state** via WinRT,
  and keeps only **currently connected** ones. For those it reads, in one
  SetupAPI pass, the OS battery cache (the Settings value), charging flag,
  PnP model string, HID roles and Class of Device — then classifies the type
  (name keywords → HID roles → Class of Device) and drops untracked
  categories (watch, laptop, TV, printer, stylus). `--list` skips battery
  reads for a fast (~1s) connected-devices check. Phase timings go to
  stderr, so a hanging phase is easy to spot.
- `lib/bluetooth.js` runs that script (bundled interpreter → system
  `python` → `py -3`) and parses the JSON report.
- `main.js` (Electron main process) polls the cheap list every 15s and runs
  full battery reads only when the device set changes (or while some
  batteries are still unknown, retried every 60s). It owns the window, the
  per-device tray icons with tooltips/menus, and the persisted type
  overrides (`%AppData%\batnex\type-overrides.json`).
- The UI (`renderer/`, daisyUI + Tailwind compiled locally, heroicons for
  chrome, custom line-style device glyphs) lists connected devices with
  battery bars, charging bolts and low-battery highlighting. Long names show
  in full on hover. The window is frameless with a custom title bar
  (minimize/close only) and a fixed size; closing hides to the tray.

> **Battery sources:** Windows itself tracks connected-device battery (from
> hands-free reports and its own BLE reads) in the system device properties —
> the same value Settings shows — and Batnex reads that first (instant, no
> extra connections). Devices the OS cache doesn't cover fall back to a
> direct BLE Battery Service read. A device with neither appears as
> connected with `n/a`.

## Download

Get the Windows installer (`Batnex Setup x.y.z.exe`) from the
[Releases](https://github.com/ecodelleola/BatNex/releases) page — no Python
or setup needed, just Bluetooth switched on. The installer is unsigned, so
Windows SmartScreen shows an "unknown publisher" prompt: choose
"More info → Run anyway".

## Run it (development)

Prerequisites: Windows 10/11 with Bluetooth on, [Node.js](https://nodejs.org/)
18+, and Python 3.10+ with `bleak` (dev machines only —
`python -m pip install bleak`):

```cmd
cmd /c "npm install"
cmd /c "npm start"
```

> PowerShell blocks `npm` on some machines (`running scripts is disabled`).
> All commands here use `cmd /c "..."` to avoid that.

Renderer assets are prebuilt (`renderer/icons.js`, `renderer/styles.css`);
rebuild after editing with `npm run icons` and `npm run css`.

## Build a Windows installer

```cmd
cmd /c "npm run dist"
```

Find the setup `.exe` under `dist/`. The installer bundles the private
Python 3.12 + `bleak` runtime (`vendor/python`, fetched once with
`python scripts/fetch_python.py`), so end users need nothing but Bluetooth.
The app logo comes from `assets/source-logo.ico` via
`python scripts/convert_logo.py`.

## Project layout

```
main.js               # window, tray icons/menus, IPC, auto-detect loop, overrides
preload.js            # safe renderer bridge (context isolation on)
renderer/
  index.html          # frameless window shell
  renderer.js         # device list, custom type dropdown, title bar buttons
  icons.js            # bundled heroicons (generated — do not edit)
  input.css           # Tailwind + custom theme source
  styles.css          # compiled CSS (generated — do not edit)
lib/
  bluetooth.js        # spawns the scanner (bundled → system Python), parses JSON
  classify.js         # emoji/accent style per device type
  trayIcon.js         # vector device-glyph tray icons (pure-JS PNG)
scripts/
  bt_battery.py       # paired → connected → battery/type report (JSON)
  fetch_python.py     # one-time download of the private runtime into vendor/
  convert_logo.py     # source-logo.ico -> icon.png/.ico + title-bar logo
  build_icons.js      # heroicons package -> renderer/icons.js
assets/
  source-logo.ico     # original artwork (committed source of truth)
  icon.png/.ico       # generated app icons (window, taskbar, installer)
.github/workflows/
  release.yml         # tag-triggered installer build + GitHub Release publish
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Empty list | Only **connected** devices are shown — connect one in Windows Settings → Bluetooth & devices. It appears automatically within ~15s. |
| Device shows but battery is `n/a` | Check the terminal for the `[battery] <name>: <reason>` line: it tells you whether the OS cache, GATT connect, or Battery Service lookup failed. Share that line when reporting the issue. |
| Wrong device icon/type | Change it in the window's type dropdown — the override applies everywhere and persists. The `[type]` terminal line (`name cod=… hid=[…] -> type`) shows what auto-detection decided and why. |
| No tray icon for a listed device | By design: devices without a battery reading get no icon. Hover states read `Name: 85%`; with zero battery icons the fallback tray icon appears so the app stays reachable. |
| Scan times out / nothing updates | Watch the `[scan]` / `[scanner] [bt] …` lines — per-phase timings (`paired` → `status check` → `properties` → `discovery` → `battery reads`) show exactly which phase hangs. A full scan is normally under ~10s; a stalled scan is killed and retried automatically. |
| `Could not start Python` (dev) | Install Python 3.10+ and tick “Add to PATH”, or run `python scripts/fetch_python.py` to use the private runtime. |
| `npm` fails in PowerShell | Use `cmd /c "npm ..."` instead, or run one command per line in Git Bash. |
