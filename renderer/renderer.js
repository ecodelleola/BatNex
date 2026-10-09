"use strict";

/* global window */

// Device glyphs in a line-icon style (heroicons has no mouse/headphone
// glyphs). Window chrome (refresh/min/close/bolt) uses heroicons.
const GLYPHS = {
  mouse: '<rect x="8" y="2.5" width="8" height="19" rx="4"/><path d="M12 6v4.5"/>',
  headphones:
    '<path d="M4 16v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="13.5" width="4" height="7" rx="2"/><rect x="17" y="13.5" width="4" height="7" rx="2"/>',
  earbuds:
    '<circle cx="8.5" cy="9" r="3"/><path d="M8.5 12v8.5"/><circle cx="15.5" cy="9" r="3"/><path d="M15.5 12v8.5"/>',
  keyboard:
    '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M6.5 10.5h2M11 10.5h2M15.5 10.5h2M6.5 14h11"/>',
  speaker:
    '<rect x="7.5" y="2.5" width="9" height="19" rx="2"/><circle cx="12" cy="14.5" r="3"/><circle cx="12" cy="7.5" r="1"/>',
  watch:
    '<rect x="8" y="7" width="8" height="10" rx="2.5"/><path d="M10 7V4h4v3M10 17v3h4v-3M12 10.5V12l1.5 1"/>',
  controller:
    '<rect x="2.5" y="8" width="19" height="9" rx="4.5"/><path d="M8 11v3M6.5 12.5h3"/><circle cx="15.5" cy="11.8" r="1"/><circle cx="17.5" cy="14" r="1"/>',
  phone: '<rect x="8" y="2.5" width="8" height="19" rx="2"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="5" y="4.5" width="14" height="9.5" rx="1.5"/><path d="M2.5 17.5h19"/>',
  tv: '<rect x="3" y="5.5" width="18" height="12" rx="2"/><path d="M12 17.5V21M8.5 21h7"/>',
  printer: '<path d="M7 8V3.5h10V8M7 17H4.5v-6.5h15V17H17M7 14h10v6.5H7z"/>',
  bluetooth: '<path d="M12 4v16M12 4l7 4.2-7 4.2M12 20l7-4.2-7-4.2"/>',
};

const TYPE_GLYPH = {
  headphones: "headphones",
  headset: "headphones",
  earbuds: "earbuds",
  speaker: "speaker",
  mouse: "mouse",
  keyboard: "keyboard",
  controller: "controller",
  phone: "phone",
  bluetooth: "bluetooth",
};

const TYPE_LABEL = {
  headphones: "Headphones",
  headset: "Headset",
  earbuds: "Earbuds",
  speaker: "Speaker",
  mouse: "Mouse",
  keyboard: "Keyboard",
  controller: "Gamepad",
  phone: "Phone",
  bluetooth: "Device",
};

const GREEN = "#3ddc84";
const AMBER = "#fbbf24";
const RED = "#f87171";

let devices = [];
let lastError = null;
let scanning = false;

const app = document.getElementById("app");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function svgWrap(inner, width) {
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="${width}" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function hero(name) {
  const inner = (window.HEROICONS && window.HEROICONS[name]) || "";
  return svgWrap(inner, 1.5);
}

function glyph(name) {
  if (GLYPHS[name]) return svgWrap(GLYPHS[name], 1.8);
  return hero(name);
}

function levelColor(p) {
  if (p === null || p === undefined) return "#8a938e";
  if (p <= 20) return RED;
  if (p <= 50) return AMBER;
  return GREEN;
}

function logoMark() {
  return `<img class="tb-logo" src="./logo.png" alt="Batnex logo" draggable="false" />`;
}

function typeMenuItems(d) {
  return Object.entries(TYPE_LABEL)
    .map(([value, label]) => `
      <li>
        <button class="type-item${value === d.deviceType ? " current" : ""}" data-id="${esc(d.id)}" data-type="${value}">
          <span class="type-item-icon">${glyph(TYPE_GLYPH[value] || "bluetooth")}</span><span>${esc(label)}</span>
        </button>
      </li>`)
    .join("");
}

function row(d) {
  const known = d.batteryPercent !== null && d.batteryPercent !== undefined;
  const pct = d.batteryPercent ?? 0;
  const color = levelColor(d.batteryPercent);
  const low = known && d.batteryPercent <= 20;
  const filled = known ? Math.round(Math.min(100, d.batteryPercent) / 10) : 0;
  const segs = Array.from({ length: 10 }, (_, i) =>
    `<span class="seg" style="${i < filled ? `background:${color}` : ""}"></span>`
  ).join("");
  const pctLabel = known
    ? `<span class="inline-flex items-center gap-1">${d.charging ? `<span class="inline-block h-4 w-4">${hero("bolt")}</span>` : ""}${d.batteryPercent}%</span>`
    : "n/a";
  return `
  <li class="dev-card ${low ? "low" : ""}">
    <div class="tile dev-glyph" style="color:${color}">${glyph(TYPE_GLYPH[d.deviceType] || "bluetooth")}</div>
    <div class="min-w-0 flex-1">
      <div class="dev-name truncate" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="dev-type">
        <button class="type-btn" data-id="${esc(d.id)}" title="Change device type"><span>${esc(TYPE_LABEL[d.deviceType] || "Device")}</span><span class="type-chev">${hero("chevron-down")}</span></button>
        <ul class="type-menu hidden">${typeMenuItems(d)}</ul>
      </div>
    </div>
    <div class="shrink-0">
      <div class="dev-pct" style="color:${color}">${pctLabel}</div>
      <div class="segs">${segs}</div>
    </div>
  </li>`;
}

function render() {
  const count = String(devices.length).padStart(2, "0");
  const err = lastError
    ? `<div role="alert" class="err">${esc(lastError)}</div>`
    : "";
  const body = devices.length
    ? `<ul class="dev-list">${devices.map(row).join("")}</ul>`
    : `<div class="empty">
         <div class="empty-glyph">${hero("signal-slash")}</div>
         <h2>No connected devices</h2>
         <p>Connect a Bluetooth device in Windows Settings.<br/>It appears here automatically.</p>
       </div>`;

  app.innerHTML = `
    <div class="shell">
      <header id="titlebar">
        <div class="tb-left">${logoMark()}<span class="tb-title">BATNEX</span></div>
        <div class="tb-btns">
          <button id="minBtn" title="Minimize" class="winbtn">${hero("minus")}</button>
          <button id="closeBtn" title="Close" class="winbtn close">${hero("x-mark")}</button>
        </div>
      </header>
      <main class="content">
        <div class="dev-head">
          <div class="dev-head-left">DEVICES <span class="dev-count">${count}</span></div>
          <button id="refreshBtn" title="Refresh now" class="iconbtn ${scanning ? "spinning" : ""}">${hero("arrow-path")}</button>
        </div>
        ${err}
        ${body}
      </main>
    </div>`;

  document.getElementById("minBtn").addEventListener("click", () => void window.batnex.minimize());
  document.getElementById("closeBtn").addEventListener("click", () => void window.batnex.close());
  document.getElementById("refreshBtn").addEventListener("click", () => void manualRefresh());
}

function applyPayload(payload) {
  devices = payload.devices || [];
  lastError = payload.error || null;
  render();
}

function closeTypeMenus() {
  app.querySelectorAll(".type-menu").forEach((m) => m.classList.add("hidden"));
}

async function changeType(id, type) {
  try {
    applyPayload(await window.batnex.setType(id, type));
  } catch (e) {
    console.error(e);
    lastError = String((e && e.message) || e);
    render();
  }
}

async function manualRefresh() {
  if (scanning) return;
  scanning = true;
  render();
  try {
    applyPayload(await window.batnex.refresh());
  } catch (e) {
    console.error(e);
    lastError = String((e && e.message) || e);
    render();
  } finally {
    scanning = false;
    render();
  }
}

async function init() {
  console.log("Batnex renderer ready");
  // Type-menu interaction is delegated (rows re-render often).
  document.addEventListener("click", (e) => {
    const item = e.target.closest(".type-item");
    if (item) {
      closeTypeMenus();
      void changeType(item.dataset.id, item.dataset.type);
      return;
    }
    const btn = e.target.closest(".type-btn");
    if (btn) {
      const menu = btn.parentElement.querySelector(".type-menu");
      const wasHidden = menu.classList.contains("hidden");
      closeTypeMenus();
      if (wasHidden) menu.classList.remove("hidden");
      return;
    }
    closeTypeMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTypeMenus();
  });
  render();
  window.batnex.onDevices((payload) => applyPayload(payload));
  try {
    applyPayload(await window.batnex.cached());
  } catch (e) {
    console.error(e);
  }
}

void init();
