"use strict";

// 64x64 tray icons in pure JS: just the battery percentage as large digits
// (plus "%"), centered. Returns a PNG Buffer for nativeImage.createFromBuffer().

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
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = 255;
}

// 3x5 bitmap font for '0'-'9' and '?'. Each row is 3 bits, MSB left.
function glyph(ch) {
  switch (ch) {
    case "0": return [0b111, 0b101, 0b101, 0b101, 0b111];
    case "1": return [0b010, 0b110, 0b010, 0b010, 0b111];
    case "2": return [0b111, 0b001, 0b111, 0b100, 0b111];
    case "3": return [0b111, 0b001, 0b111, 0b001, 0b111];
    case "4": return [0b101, 0b101, 0b111, 0b001, 0b001];
    case "5": return [0b111, 0b100, 0b111, 0b001, 0b111];
    case "6": return [0b111, 0b100, 0b111, 0b101, 0b111];
    case "7": return [0b111, 0b001, 0b001, 0b010, 0b010];
    case "8": return [0b111, 0b101, 0b111, 0b101, 0b111];
    case "9": return [0b111, 0b101, 0b111, 0b001, 0b111];
    case "?": return [0b111, 0b001, 0b011, 0b000, 0b010];
    default: return null;
  }
}

function drawText(px, text, color, scale, gap) {
  const GLYPH_W = 3 * scale;
  const GAP = gap === undefined ? scale : gap;
  const chars = [...text];
  const total = chars.length * GLYPH_W + (chars.length - 1) * GAP;
  let x = Math.round((SIZE - total) / 2);
  const y = Math.round((SIZE - 5 * scale) / 2);
  // Phase 1: bold glyph cores.
  for (const ch of chars) {
    const rows = glyph(ch);
    if (rows) {
      for (let dy = 0; dy < 5; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          if (rows[dy] & (1 << (2 - dx))) {
            // Bold core: each pixel plus its right neighbour.
            for (let oy = 0; oy < scale; oy++) {
              for (let ox = 0; ox < scale + 1; ox++) {
                setPx(px, x + dx * scale + ox, y + dy * scale + oy, color);
              }
            }
          }
        }
      }
    }
    x += GLYPH_W + GAP;
  }
  // Phase 2: dark halo on transparent pixels touching a colored one, so the
  // number stays readable on both dark and light taskbars. The mask is
  // snapshotted first so halo pixels can't chain into a flood fill.
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

function batteryIconPng(battery) {
  const px = Buffer.alloc(SIZE * SIZE * 4); // transparent
  // Number only (no % sign): largest scale that fits the digit count.
  const text = battery === null || battery === undefined ? "?" : String(Math.min(100, battery));
  const [scale, gap] =
    text.length <= 1 ? [10, 10] : text.length === 2 ? [8, 8] : [6, 2];
  drawText(px, text, [235, 235, 240], scale, gap);
  return encodePng(px);
}

module.exports = { batteryIconPng };
