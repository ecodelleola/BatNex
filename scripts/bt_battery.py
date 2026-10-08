"""Report Bluetooth devices paired AND currently connected to this PC.

Pipeline (no admin rights needed):
  1. Read paired device MACs (+registry names) from
     HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices.
  2. For each MAC, query live state via WinRT
     BluetoothLEDevice / BluetoothDevice.FromBluetoothAddressAsync and keep
     only devices whose connection_status is Connected.
  3. Unless --list is given: resolve live BLEDevice objects and read the
     Battery Level characteristic (0x2A19) concurrently for those.

Prints a single JSON object:
  {"ok": true, "devices": [{"address": "AA:BB:..", "name": "...",
                            "battery": 0-100 | null, "batteryError": str | null}]}
  {"ok": false, "error": "..."}

Progress + timings go to stderr so hangs are diagnosable.
"""

import asyncio
import json
import sys
import time
import winreg

BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb"
BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb"
QUERY_TIMEOUT_SECONDS = 8.0
BATTERY_TIMEOUT_SECONDS = 12.0
SCAN_SECONDS = 4.0
OVERALL_TIMEOUT_SECONDS = 100.0
PAIRED_KEY = r"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices"


def log(msg):
    print(f"[bt] {msg}", file=sys.stderr, flush=True)


def paired_devices():
    """Return [(mac12_lowercase, registry_name)] for paired devices."""
    out = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, PAIRED_KEY) as key:
            count, _, _ = winreg.QueryInfoKey(key)
            for i in range(count):
                mac = winreg.EnumKey(key, i)
                name = ""
                try:
                    with winreg.OpenKey(key, mac) as sub:
                        raw, _ = winreg.QueryValueEx(sub, "Name")
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-16-le", errors="replace").rstrip("\x00")
                        name = (raw or "").strip()
                except OSError:
                    pass
                out.append((mac.lower(), name))
    except OSError as e:
        raise RuntimeError(f"could not read paired-device list: {e}")
    return out


def looks_connected(status):
    try:
        return int(status) == 1  # BluetoothConnectionStatus.Connected
    except (TypeError, ValueError):
        return str(status).lower() == "connected"


def live_name(candidate, fallback):
    candidate = (candidate or "").strip()
    if candidate and not candidate.lower().startswith("bluetooth "):
        return candidate
    return fallback or candidate


async def query_device(mac12, reg_name, gate):
    """Return {address, name, ble} if connected, else None.

    ble is True when Windows knows the address as a Bluetooth LE device.
    Classic-only devices (A2DP speakers/headsets) have no BLE radio to read
    a Battery Service from, so callers can skip GATT attempts for them.
    """
    from winrt.windows.devices.bluetooth import BluetoothDevice, BluetoothLEDevice

    addr = int(mac12, 16)
    name = reg_name
    connected = False
    ble = False
    for cls, is_le in ((BluetoothLEDevice, True), (BluetoothDevice, False)):
        try:
            # Serialized: parallel WinRT calls made during a connection
            # transition have been observed to stall the call entirely.
            async with gate:
                dev = await asyncio.wait_for(cls.from_bluetooth_address_async(addr), QUERY_TIMEOUT_SECONDS)
        except Exception:
            continue
        if dev is None:
            continue
        if is_le:
            ble = True
        try:
            name = live_name(dev.name, name)
        except Exception:
            pass
        try:
            if looks_connected(dev.connection_status):
                connected = True
        except Exception:
            pass
    if not connected:
        return None
    pretty = ":".join(mac12[i:i + 2] for i in range(0, 12, 2)).upper()
    return {"address": pretty, "name": name or pretty, "ble": ble}


async def read_battery(target, address):
    """Return (level | None, error_detail | None)."""
    from bleak import BleakClient

    try:
        async with asyncio.timeout(BATTERY_TIMEOUT_SECONDS):
            async with BleakClient(target) as client:
                try:
                    data = await client.read_gatt_char(BATTERY_LEVEL_UUID)
                except Exception as e:
                    return None, await diagnose(client, f"{type(e).__name__}: {e}")
                if data and len(data) >= 1:
                    return int(data[0]), None
                return None, await diagnose(client, "battery value empty")
    except Exception as e:
        return None, f"connect failed: {type(e).__name__}: {e}"
    return None, f"no data for {address}"


async def diagnose(client, read_error):
    """Check whether the Battery Service even exists on this client."""
    try:
        uuids = sorted({str(s.uuid).lower() for s in client.services})
    except Exception:
        return f"{read_error} (service list unavailable)"
    if BATTERY_SERVICE_UUID in uuids:
        return f"{read_error} (battery service present, read rejected)"
    shown = ", ".join(uuids[:8]) if uuids else "none listed"
    return f"device exposes no Battery Service (0x180F); {len(uuids)} service(s): {shown}"


def norm(address):
    return address.replace(":", "").upper()


def classify_device(name, model="", hid=(), cod=None):
    """Device-type key for UI glyphs/labels.

    Precedence: specific name/model keywords, then HID input roles seen on
    child nodes (ground truth for mice/keyboards), then Bluetooth Class of
    Device, then generic bluetooth.
    """
    n = ((name or "") + " " + (model or "")).lower().replace("_", " ")

    def has(keys):
        return any(k in n for k in keys)

    if has(["buds", "earbuds", "airpod", "earphone", "pixel buds", "freebuds", "wf-"]):
        return "earbuds"
    if "headset" in n:
        return "headset"
    if has(["headphone", "wh-1000", "wh-ch", "wh-xb", "qc", "quietcomfort",
            "beats solo", "beats studio", "beats fit", "beats flex", "beatsx",
            "powerbeats", "tune", "momentum", "mdr-", "ath-",
            "px7", "px8"]):
        return "headphones"
    if has(["speaker", "pill", "flip", "charge", "boom", "motion",
            "partybox", "wonderboom", "megaboom", "boombox", "go 3", "srs-"]):
        return "speaker"
    if has(["mouse", "mx master", "mx anywhere", "g502", "g305", "magic mouse", "logi",
            "m350", "m355", "m650", "m720", "m585", "m590", "lift", "ergo"]):
        return "mouse"
    if has(["keyboard", "mx keys", "k380", "k580", "k780", "k850", "magic keyboard", "keychron"]):
        return "keyboard"
    if has(["watch", "band", "fit", "amazfit", "versa", "sense", "gtr", "gts", "galaxy fit"]):
        return "watch"
    if has(["xbox", "dualshock", "dualsense", "controller", "gamepad", "joy-con", "8bitdo"]):
        return "controller"
    if has(["iphone", "galaxy s", "galaxy z", "pixel 6", "pixel 7", "pixel 8", "pixel 9"]):
        return "phone"
    if has(["pen", "pencil", "stylus", "slim pen"]):
        return "stylus"
    if has(["printer"]):
        return "printer"
    if has(["tv", "soundbar"]):
        return "tv"
    if has(["laptop", "notebook", "macbook", "thinkpad", "surface"]):
        return "laptop"

    hid_set = set(hid or ())
    if hid_set == {"mouse"}:
        return "mouse"
    if hid_set == {"keyboard"}:
        return "keyboard"

    if cod is not None:
        major = (cod >> 8) & 0x1F
        minor = (cod >> 2) & 0x3F
        if major == 1:  # Computer
            return "laptop"
        if major == 2:  # Phone
            return "phone"
        if major == 4:  # Audio/Video
            if minor in (5, 7, 8, 0x0A):  # loudspeaker / portable / car / hifi
                return "speaker"
            if minor == 6:  # headphones
                return "headphones"
            return "headset"  # wearable headset / hands-free / mic / unknown
        if major == 5:  # Peripheral
            if minor & 0x30 == 0x10:  # keyboard
                return "keyboard"
            if minor & 0x30 == 0x20:  # pointing device
                return "mouse"
            if minor & 0x30 == 0x30:  # combo
                return "keyboard"
            if minor & 0x0F in (1, 2, 3):  # joystick / gamepad
                return "controller"
        if major == 6 and minor == 4:  # Imaging: printer
            return "printer"
        if major == 7:  # Wearable
            return "watch"
        if major == 8:  # Toy
            return "controller"
    return "bluetooth"


# ---------------------------------------------------------------------------
# OS Bluetooth battery cache + device identity via SetupAPI.
#
# Windows itself tracks connected-device battery (from HFP +BIEV reports and
# its own BLE Battery Service reads) as a PnP device property on the
# device's node(s):
#   {104EA319-6EE2-4701-BD47-8DDBF425BBE5}, pid 2  (Byte 0-100)
# This is the same value Windows Settings displays. The same enumeration
# also yields typing signals: PnP model strings (e.g. 'Pebble_M350s'),
# HID child-node roles (mouse/keyboard), and the classic Class of Device.
# Read via SetupAPI (ctypes) so no extra processes or permissions are needed.

import ctypes
from ctypes import wintypes

_HFP_BATTERY_FMTID = (0x104EA319, 0x6EE2, 0x4701, (0xBD, 0x47, 0x8D, 0xDB, 0xF4, 0x25, 0xBB, 0xE5))
_HFP_BATTERY_PID = 2
_DIGCF_PRESENT = 0x2
_DIGCF_ALLCLASSES = 0x4
_ERROR_NO_MORE_ITEMS = 259


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8),
    ]


class _DEVPROPKEY(ctypes.Structure):
    _fields_ = [("fmtid", _GUID), ("pid", wintypes.DWORD)]


class _SP_DEVINFO_DATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("ClassGuid", _GUID),
        ("DevInst", wintypes.DWORD),
        ("Reserved", ctypes.c_size_t),
    ]


def _setupapi():
    setupapi = ctypes.WinDLL("setupapi")
    setupapi.SetupDiGetClassDevsW.argtypes = [
        ctypes.c_void_p, wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD,
    ]
    setupapi.SetupDiGetClassDevsW.restype = wintypes.HANDLE
    setupapi.SetupDiEnumDeviceInfo.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p]
    setupapi.SetupDiEnumDeviceInfo.restype = wintypes.BOOL
    setupapi.SetupDiGetDeviceInstanceIdW.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    setupapi.SetupDiGetDeviceInstanceIdW.restype = wintypes.BOOL
    setupapi.SetupDiGetDevicePropertyW.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), wintypes.DWORD,
    ]
    setupapi.SetupDiGetDevicePropertyW.restype = wintypes.BOOL
    setupapi.SetupDiDestroyDeviceInfoList.argtypes = [wintypes.HANDLE]
    setupapi.SetupDiDestroyDeviceInfoList.restype = wintypes.BOOL
    return setupapi


def _read_node_u32(setupapi, hdev, did, key, expect_type):
    ptype = wintypes.DWORD(0)
    buf = (ctypes.c_ubyte * 64)()
    need = wintypes.DWORD(0)
    if not setupapi.SetupDiGetDevicePropertyW(
        hdev, ctypes.byref(did), ctypes.byref(key), ctypes.byref(ptype),
        buf, ctypes.sizeof(buf), ctypes.byref(need), 0,
    ):
        return None
    if ptype.value & 0xFFF != expect_type:
        return None
    value = 0
    for i in range(min(need.value, 4)):
        value |= buf[i] << (8 * i)
    return value


def _read_node_string(setupapi, hdev, did, key):
    ptype = wintypes.DWORD(0)
    buf = ctypes.create_unicode_buffer(256)
    need = wintypes.DWORD(0)
    if not setupapi.SetupDiGetDevicePropertyW(
        hdev, ctypes.byref(did), ctypes.byref(key), ctypes.byref(ptype),
        buf, ctypes.sizeof(buf), ctypes.byref(need), 0,
    ):
        return None
    if ptype.value & 0xFFF != 0x12:  # STRING
        return None
    return buf.value


# PnP class GUIDs for HID input roles.
_CLASS_MOUSE = (0x4D36E96F, 0xE325, 0x11CE)
_CLASS_KEYBOARD = (0x4D36E96B, 0xE325, 0x11CE)


def query_pnp(macs):
    """Single-pass SetupAPI query for a set of MACs (12 hex chars, upper).

    Returns {mac: {"cod": int | None, "hfp": int | None, "charging": bool | None,
                   "model": str, "hid": ["mouse"|"keyboard"]}} where:
      cod      = Bluetooth Class of Device (classic nodes only)
      hfp      = battery level 0-100 from the OS battery cache (same as Settings)
      charging = battery charging flag from the same property set
      model    = PnP model string, e.g. 'Pebble_M350s' (great for typing)
      hid      = input roles seen on HID child nodes (ground truth for mice/keys)
    """
    result = {m: {"cod": None, "hfp": None, "charging": None, "model": "", "hid": []} for m in macs}
    if not macs:
        return result
    try:
        setupapi = _setupapi()
    except Exception:
        return result

    def devpropkey(fmtid, pid):
        key = _DEVPROPKEY()
        d1, d2, d3, d4 = fmtid
        key.fmtid.Data1, key.fmtid.Data2, key.fmtid.Data3 = d1, d2, d3
        key.fmtid.Data4[:] = d4
        key.pid = pid
        return key

    cod_key = devpropkey((0x2BD67D8B, 0x8BEB, 0x48D5, (0x87, 0xE0, 0x6C, 0xDA, 0x34, 0x28, 0x04, 0x0A)), 4)
    model_key = devpropkey((0x2BD67D8B, 0x8BEB, 0x48D5, (0x87, 0xE0, 0x6C, 0xDA, 0x34, 0x28, 0x04, 0x0A)), 5)
    hfp_key = devpropkey(_HFP_BATTERY_FMTID, _HFP_BATTERY_PID)
    chg_key = devpropkey(_HFP_BATTERY_FMTID, 3)  # same set, pid 3 (charging flag)

    hdev = setupapi.SetupDiGetClassDevsW(None, None, None, _DIGCF_PRESENT | _DIGCF_ALLCLASSES)
    if not hdev or hdev == wintypes.HANDLE(-1).value:
        return result
    try:
        index = 0
        id_buf = ctypes.create_unicode_buffer(512)
        while True:
            did = _SP_DEVINFO_DATA()
            did.cbSize = ctypes.sizeof(_SP_DEVINFO_DATA)
            if not setupapi.SetupDiEnumDeviceInfo(hdev, index, ctypes.byref(did)):
                break
            index += 1
            req = wintypes.DWORD(0)
            if not setupapi.SetupDiGetDeviceInstanceIdW(
                hdev, ctypes.byref(did), id_buf, len(id_buf), ctypes.byref(req)
            ):
                continue
            iid = id_buf.value.upper().replace(":", "")
            hits = [m for m in macs if m in iid]
            if not hits:
                continue
            guid = did.ClassGuid
            hid = None
            if (guid.Data1, guid.Data2, guid.Data3) == _CLASS_MOUSE:
                hid = "mouse"
            elif (guid.Data1, guid.Data2, guid.Data3) == _CLASS_KEYBOARD:
                hid = "keyboard"
            cod = _read_node_u32(setupapi, hdev, did, cod_key, 0x7)  # UINT32
            model = _read_node_string(setupapi, hdev, did, model_key) or ""
            hfp = _read_node_u32(setupapi, hdev, did, hfp_key, 0x3)  # BYTE
            if hfp is None:
                hfp = _read_node_u32(setupapi, hdev, did, hfp_key, 0x2)  # SBYTE
            charging = _read_node_u32(setupapi, hdev, did, chg_key, 0x11)  # BOOLEAN
            for m in hits:
                if cod is not None and result[m]["cod"] is None:
                    result[m]["cod"] = cod
                if model and not result[m]["model"]:
                    result[m]["model"] = model
                if hid and hid not in result[m]["hid"]:
                    result[m]["hid"].append(hid)
                if hfp is not None and 0 <= hfp <= 100:
                    result[m]["hfp"] = hfp
                if charging is not None and result[m]["charging"] is None:
                    result[m]["charging"] = charging != 0
    except Exception:
        pass
    finally:
        try:
            setupapi.SetupDiDestroyDeviceInfoList(hdev)
        except Exception:
            pass
    return result


async def connected_devices(gate):
    t0 = time.monotonic()
    paired = paired_devices()
    log(f"paired devices: {len(paired)}")
    connected = await asyncio.gather(*(query_device(m, n, gate) for m, n in paired))
    connected = [c for c in connected if c]
    log(f"status check done in {time.monotonic() - t0:.1f}s: {len(connected)} connected")
    return connected


async def with_batteries(connected, pnp):
    t0 = time.monotonic()
    by_mac = {}
    if any(c.get("ble", True) for c in connected):
        try:
            from bleak import BleakScanner

            found = await asyncio.wait_for(
                BleakScanner.discover(timeout=SCAN_SECONDS, return_adv=True), SCAN_SECONDS + 10.0
            )
            for _, (dev, _adv) in found.items():
                by_mac[norm(str(dev.address))] = dev
            log(f"discovery done in {time.monotonic() - t0:.1f}s: {len(by_mac)} advertisers")
        except Exception as e:
            log(f"discovery failed ({type(e).__name__}: {e}); using bare addresses")
    else:
        log("no BLE devices connected, skipping discovery")

    async def read_one(dev):
        # 1) OS battery cache (same value Windows Settings shows). Instant and
        #    local — covers HFP headsets/speakers AND connected LE input
        #    devices, which usually can't take a second GATT connection.
        node = pnp.get(norm(dev["address"]), {})
        hfp = node.get("hfp")
        if hfp is not None:
            dev["battery"] = hfp
            dev["batteryError"] = None
            dev["batterySource"] = "OS"
            dev["charging"] = node.get("charging")
            return dev
        # 2) BLE Battery Service, for devices the OS cache doesn't cover.
        if dev.get("ble", True):
            target = by_mac.get(norm(dev["address"]), dev["address"])
            level, err = await read_battery(target, dev["address"])
            if level is not None:
                dev["battery"] = level
                dev["batteryError"] = None
                dev["batterySource"] = "BLE"
                dev["charging"] = node.get("charging")
                return dev
            dev["batteryError"] = err
        else:
            dev["batteryError"] = (
                "no OS battery report and no BLE Battery Service; "
                "Windows Settings can't show it either"
            )
        dev["battery"] = None
        dev["batterySource"] = None
        dev["charging"] = node.get("charging")
        return dev

    t1 = time.monotonic()
    devices = await asyncio.gather(*(read_one(c) for c in connected))
    log(f"battery reads done in {time.monotonic() - t1:.1f}s")
    return devices


async def main():
    fast = "--list" in sys.argv
    gate = asyncio.Semaphore(4)
    try:
        async with asyncio.timeout(OVERALL_TIMEOUT_SECONDS):
            connected = await connected_devices(gate)
            t0 = time.monotonic()
            macs = {norm(c["address"]) for c in connected}
            pnp = await asyncio.to_thread(query_pnp, macs)
            log(f"device properties read in {time.monotonic() - t0:.1f}s")
            for c in connected:
                info = pnp.get(norm(c["address"]), {})
                cod = info.get("cod")
                c["deviceType"] = classify_device(
                    c["name"], info.get("model", ""), info.get("hid", ()), cod
                )
                cod_repr = f"{cod:#x}" if cod is not None else "none"
                log(f"type: {c['name']} cod={cod_repr} hid={info.get('hid', [])} -> {c['deviceType']}")
            if fast:
                devices = [
                    {**c, "battery": None, "batteryError": None, "batterySource": None,
                     "charging": pnp.get(norm(c["address"]), {}).get("charging")}
                    for c in connected
                ]
            else:
                devices = await with_batteries(connected, pnp)
    except TimeoutError:
        print(json.dumps({"ok": False, "error": f"scan timed out after {OVERALL_TIMEOUT_SECONDS:.0f}s (phase hangs logged above)"}))
        return
    except RuntimeError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return
    print(json.dumps({"ok": True, "devices": devices}))


if __name__ == "__main__":
    asyncio.run(main())
