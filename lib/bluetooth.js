"use strict";

// Runs scripts/bt_battery.py and parses its JSON report.
// { batteries: true } does the full scan incl. GATT battery reads;
// { batteries: false } passes --list for a fast connected-devices check.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT = (() => {
  const bundled = path.join(__dirname, "..", "scripts", "bt_battery.py");
  // In the installed app, files live inside app.asar, which Python cannot
  // read from. electron-builder extracts asarUnpack entries next to it.
  return bundled.includes("app.asar")
    ? bundled.replace("app.asar", "app.asar.unpacked")
    : bundled;
})();

// Python interpreters to try, in order: the private runtime shipped with the
// installer (works with no system Python), then any system Python.
function interpreters() {
  const list = [];
  try {
    // Packaged app: extraResources land next to app.asar.
    const bundled = path.join(process.resourcesPath, "python", "python.exe");
    list.push([bundled, []]);
    // Dev checkout: vendor/ folder in the project root.
    const vendored = path.join(__dirname, "..", "vendor", "python", "python.exe");
    list.push([vendored, []]);
  } catch { /* process.resourcesPath unavailable (plain node) */ }
  list.push(["python", []]);
  list.push(["py", ["-3"]]);
  return list;
}
const SCAN_TIMEOUT_MS = 120000;
// If the scanner goes silent this long (no stdout/stderr), it is wedged
// (e.g. a WinRT call stalled mid-transition) — kill it so the next poll
// retries instead of hanging forever.
const STALL_TIMEOUT_MS = 45000;

function runScanner(cmd, args, onStderr) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let lastOutput = Date.now();
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      resolve(value);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err), spawnFailed: true });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, error: "Bluetooth scan timed out after 120s. Scanner log above shows which phase hung." });
    }, SCAN_TIMEOUT_MS);

    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput > STALL_TIMEOUT_MS) {
        try { child.kill(); } catch { /* already exited */ }
        finish({ ok: false, error: `Bluetooth scan stalled (no output for ${STALL_TIMEOUT_MS / 1000}s, likely mid-transition). Retrying automatically.` });
      }
    }, 5000);

    child.on("error", (err) => {
      finish({ ok: false, error: String((err && err.message) || err), spawnFailed: true });
    });
    child.stdout.on("data", (d) => { stdout += d.toString(); lastOutput = Date.now(); });
    child.stderr.on("data", (d) => {
      lastOutput = Date.now();
      const text = d.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) onStderr(line.trim());
      }
    });
    child.on("close", (code) => {
      const text = stdout.trim().split("\n").filter(Boolean).pop() || "";
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "ok" in parsed) {
          finish(parsed);
          return;
        }
        finish({ ok: false, error: "Unexpected scanner output." });
      } catch {
        const hint = stderr.trim()
          ? ` Scanner said: ${stderr.trim().split("\n").pop()}`
          : code !== 0
            ? " Scanner exited with an error. Is 'bleak' installed? Run: python -m pip install bleak"
            : "";
        finish({ ok: false, error: `Could not read scanner output.${hint}` });
      }
    });
  });
}

async function runOnce(batteries) {
  const extra = batteries ? [] : ["--list"];
  const forward = (line) => console.log(`[scanner] ${line}`);
  console.log(`[scan] starting ${batteries ? "full" : "list"} scan`);
  for (const [cmd, prefix] of interpreters()) {
    if ((cmd.includes("/") || cmd.includes("\\")) && !fs.existsSync(cmd)) continue;
    console.log(`[scan] using interpreter: ${cmd}`);
    const result = await runScanner(cmd, [...prefix, SCRIPT, ...extra], forward);
    if (result.ok) return stripInternal(result);
    if (!result.spawnFailed) return stripInternal(result); // interpreter ran; report its answer
    console.log(`[scan] interpreter '${cmd}' unavailable, trying next`);
  }
  return { ok: false, error: "Could not start Python (tried bundled runtime, 'python' and 'py -3'). Reinstall Batnex or install Python 3.10+." };
}

function stripInternal(result) {
  delete result.spawnFailed;
  return result;
}

async function scanDevices(opts = {}) {
  const t0 = Date.now();
  const result = await runOnce(opts.batteries !== false);
  console.log(`[scanner] ${opts.batteries !== false ? "full" : "list"} scan finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, ok=${result.ok}`);
  return result;
}

module.exports = { scanDevices };
