"use strict";

// 64x64 tray icons in pure JS: per-device vector glyphs in the battery-level
// color. Returns a PNG Buffer for nativeImage.createFromBuffer().

const zlib = require("node:zlib");

const SIZE = 64;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba) {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function setPx(px, x, y, c) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = c.length > 3 ? c[3] : 255;
}

function fillCircle(px, cx, cy, r, c) {
  const rr = Math.ceil(r);
  for (let dy = -rr; dy <= rr; dy++) {
    for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy <= r * r) setPx(px, cx + dx, cy + dy, c);
    }
  }
}

function levelColor(p) {
  // 100-80 green (full), 79-50 blue (medium), 49-20 yellow (low), 19-0 red.
  if (p >= 80) return [52, 211, 153];
  if (p >= 50) return [59, 130, 246];
  if (p >= 20) return [251, 191, 36];
  return [248, 113, 113];
}

// --- vector device glyphs (same artwork as the app UI, 24-unit grid) ---

// (Grid transform is computed per glyph in drawGlyph so each icon fills
// the canvas; see K0/O0 there.)

// Same artwork as the app UI (24-unit grid). r = outline rect [x,y,w,h,radius],
// c = filled circle [cx,cy,r], p = stroked path (w = px stroke width).
const SHAPES = {
  mouse: [{ r: [8, 2.5, 8, 19, 4] }, { p: "M12 6v4.5" }],
  headphones: [{ p: "M4 16v-3a8 8 0 0 1 16 0v2" }, { r: [3, 13.5, 4, 7, 2] }, { r: [17, 13.5, 4, 7, 2] }],
  earbuds: [{ c: [8.5, 9, 3] }, { p: "M8.5 12v8.5" }, { c: [15.5, 9, 3] }, { p: "M15.5 12v8.5" }],
  keyboard: [{ r: [2.5, 7, 19, 10, 2] }, { p: "M6.5 10.5h2M11 10.5h2M15.5 10.5h2M6.5 14h11" }],
  speaker: [{ r: [7.5, 2.5, 9, 19, 2] }, { c: [12, 14.5, 3] }, { c: [12, 7.5, 1] }],
  controller: [{ r: [2.5, 8, 19, 9, 4.5] }, { p: "M8 11v3M6.5 12.5h3" }, { c: [15.5, 11.8, 1] }, { c: [17.5, 14, 1] }],
  phone: [{ r: [8, 2.5, 8, 19, 2] }, { p: "M11 18.5h2" }],
  bluetooth: [{ p: "M12 4v16M12 4l7 4.2-7 4.2M12 20l7-4.2-7-4.2" }],
};

function arcPoints(x0, y0, rx, ry, rot, large, sweep, x1, y1) {
  const rad = rot * (Math.PI / 180);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  let rxs = rx, rys = ry;
  const lam = (x1p * x1p) / (rxs * rxs) + (y1p * y1p) / (rys * rys);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rxs *= s;
    rys *= s;
  }
  const num = rxs * rxs * rys * rys - rxs * rxs * y1p * y1p - rys * rys * x1p * x1p;
  const den = rxs * rxs * y1p * y1p + rys * rys * x1p * x1p;
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rxs * y1p) / rys, cyp = (-co * rys * x1p) / rxs;
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rxs, (y1p - cyp) / rys);
  let dt = ang((x1p - cxp) / rxs, (y1p - cyp) / rys, (-x1p - cxp) / rxs, (-y1p - cyp) / rys);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const pts = [];
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 36)));
  for (let i = 0; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rxs * Math.cos(t), ey = rys * Math.sin(t);
    pts.push([cx + cos * ex - sin * ey, cy + sin * ex + cos * ey]);
  }
  return pts;
}

function parsePath(d) {
  const tokens = d.match(/[MmLlHhVvZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const lines = [];
  let cur = [];
  let cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0;
  const flush = () => {
    if (cur.length > 1) lines.push(cur);
    cur = [];
  };
  const lineTo = (nx, ny) => {
    if (!cur.length) cur.push([sx, sy]);
    cur.push([nx, ny]);
    x = nx;
    y = ny;
  };
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    if (/[MmLlHhVvZzAa]/.test(t)) {
      if (t === "Z" || t === "z") {
        lineTo(sx, sy);
        flush();
        continue;
      }
      cmd = t;
      if (cmd === "M" || cmd === "m") {
        flush();
        const nx = num(), ny = num();
        x = cmd === "M" ? nx : x + nx;
        y = cmd === "M" ? ny : y + ny;
        sx = x;
        sy = y;
        cur.push([x, y]);
        cmd = cmd === "M" ? "L" : "l";
      }
      continue;
    }
    i--;
    if (cmd === "L") lineTo(num(), num());
    else if (cmd === "l") lineTo(x + num(), y + num());
    else if (cmd === "H") lineTo(num(), y);
    else if (cmd === "h") lineTo(x + num(), y);
    else if (cmd === "V") lineTo(x, num());
    else if (cmd === "v") lineTo(x, y + num());
    else if (cmd === "A" || cmd === "a") {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
      let ex = num(), ey = num();
      if (cmd === "a") {
        ex += x;
        ey += y;
      }
      for (const [ax, ay] of arcPoints(x, y, rx, ry, rot, large, sweep, ex, ey)) {
        lineTo(ax, ay);
      }
      x = ex;
      y = ey;
    }
  }
  flush();
  return lines;
}

function strokePolyline(px, pts, w, color) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const steps = Math.max(1, Math.ceil(dist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      fillCircle(px, p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, w / 2, color);
    }
  }
}

function fillRoundedRect(px, x, y, w, h, r, c) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
  for (let py = y0; py < y1; py++) {
    for (let qx = x0; qx < x1; qx++) {
      const dx = Math.min(qx - x, x + w - 1 - qx);
      const dy = Math.min(py - y, y + h - 1 - py);
      if (dx >= r || dy >= r || (dx - r) * (dx - r) + (dy - r) * (dy - r) <= r * r) {
        setPx(px, qx, py, c);
      }
    }
  }
}

function strokeRoundedRect(px, x, y, w, h, r, bw, c) {
  const CLEAR = [0, 0, 0, 0];
  fillRoundedRect(px, x, y, w, h, r, c);
  fillRoundedRect(px, x + bw, y + bw, w - 2 * bw, h - 2 * bw, Math.max(r - bw, 0), CLEAR);
}

function drawShapes(px, shapes, color, K, Ox, Oy, stroke) {
  const X = (v) => Ox + v * K;
  const Y = (v) => Oy + v * K;
  for (const s of shapes) {
    if (s.r) {
      const b = s.r;
      strokeRoundedRect(px, X(b[0]), Y(b[1]), b[2] * K, b[3] * K, b[4] * K, stroke, color);
    } else if (s.c) {
      fillCircle(px, X(s.c[0]), Y(s.c[1]), s.c[2] * K, color);
    } else if (s.p) {
      for (const line of parsePath(s.p)) {
        strokePolyline(
          px,
          line.map((pt) => [X(pt[0]), Y(pt[1])]),
          stroke,
          color
        );
      }
    }
  }
}

function inkBbox(px) {
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (px[(y * SIZE + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 };
}

function drawGlyph(px, name, color) {
  const shapes = SHAPES[name] || SHAPES.bluetooth;
  // Pass 1: render with the base transform, measure the ink bbox.
  const K0 = 2, O0 = 8;
  const tmp = Buffer.alloc(SIZE * SIZE * 4);
  drawShapes(tmp, shapes, [255, 255, 255], K0, O0, O0, 1.8 * K0);
  const box = inkBbox(tmp);
  if (!box) return;
  // Pass 2: uniform re-scale so the ink fills 6..58 (maximized, aspect kept).
  // Final canvas for grid g: 6 + margin + (O0 + K0*g - box) * s.
  const s = Math.min(52 / (box.x1 - box.x0 + 1), 52 / (box.y1 - box.y0 + 1));
  const K = K0 * s;
  const Ox = 6 + (52 - (box.x1 - box.x0 + 1) * s) / 2 + (O0 - box.x0) * s;
  const Oy = 6 + (52 - (box.y1 - box.y0 + 1) * s) / 2 + (O0 - box.y0) * s;
  drawShapes(px, shapes, color, K, Ox, Oy, 1.8 * K);
}

function addHalo(px) {
  const halo = [10, 14, 24];
  const setMask = new Uint8Array(SIZE * SIZE);
  for (let cy = 0; cy < SIZE; cy++) {
    for (let cx = 0; cx < SIZE; cx++) {
      setMask[cy * SIZE + cx] = px[(cy * SIZE + cx) * 4 + 3] !== 0 ? 1 : 0;
    }
  }
  const isSet = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) return false;
    return setMask[cy * SIZE + cx] === 1;
  };
  for (let cy = 0; cy < SIZE; cy++) {
    for (let cx = 0; cx < SIZE; cx++) {
      if (!isSet(cx, cy) && (isSet(cx - 1, cy) || isSet(cx + 1, cy) || isSet(cx, cy - 1) || isSet(cx, cy + 1))) {
        setPx(px, cx, cy, halo);
      }
    }
  }
}
const TYPE_SHAPES = {
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
function batteryIconPng(battery, deviceType) {
  const px = Buffer.alloc(SIZE * SIZE * 4); // transparent
  // Device glyph in the battery-level color. Unknown battery -> gray glyph.
  const known = battery !== null && battery !== undefined;
  const pct = known ? Math.max(0, Math.min(100, battery)) : 0;
  const color = known ? levelColor(pct) : [148, 163, 184];
  drawGlyph(px, TYPE_SHAPES[deviceType] || "bluetooth", color);
  addHalo(px);
  return encodePng(px);
}

module.exports = { batteryIconPng };
