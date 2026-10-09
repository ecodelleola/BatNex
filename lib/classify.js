"use strict";

// Visual style per device type (tray tooltips/menus). The device type itself
// is determined by scripts/bt_battery.py from the name + Bluetooth Class of
// Device; this only maps it to presentation.
const STYLES = {
  headphones: { emoji: "🎧", accent: "#38bdf8" },
  headset: { emoji: "🎧", accent: "#38bdf8" },
  earbuds: { emoji: "🎧", accent: "#38bdf8" },
  speaker: { emoji: "🔊", accent: "#fbbf24" },
  mouse: { emoji: "🖱️", accent: "#a78bfa" },
  keyboard: { emoji: "⌨️", accent: "#a78bfa" },
  controller: { emoji: "🎮", accent: "#f472b6" },
  phone: { emoji: "📱", accent: "#34d399" },
  bluetooth: { emoji: "🔷", accent: "#94a3b8" },
};

function styleFor(type) {
  return STYLES[type] || STYLES.bluetooth;
}

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [148, 163, 184];
}

module.exports = { styleFor, hexToRgb };
