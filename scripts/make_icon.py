"""Generate BatNex app icons using only the Python standard library.

Creates in assets/: icon.png (512, window + installer source) and
icon.ico (PNG-compressed ICO for electron-builder / Windows).
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "assets"))
os.makedirs(OUT, exist_ok=True)


def new_canvas(size, color):
    return bytearray(color * size * size)


def set_px(px, size, x, y, c):
    if 0 <= x < size and 0 <= y < size:
        i = (y * size + x) * 4
        px[i:i + 4] = bytes(c)


def fill_rect(px, size, x0, y0, w, h, c):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            set_px(px, size, x, y, c)


def fill_rounded(px, size, x0, y0, w, h, r, c):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            dx = min(x - x0, x0 + w - 1 - x)
            dy = min(y - y0, y0 + h - 1 - y)
            if dx >= r or dy >= r or dx * dx + dy * dy <= r * r:
                set_px(px, size, x, y, c)


def ring(px, size, x0, y0, w, h, r, t, c):
    fill_rounded(px, size, x0, y0, w, h, r, c)
    fill_rounded(px, size, x0 + t, y0 + t, w - 2 * t, h - 2 * t, max(r - t, 0), (0, 0, 0, 0))


def write_png(path, px, size):
    raw = b"".join(b"\x00" + bytes(px[y * size * 4:(y + 1) * size * 4]) for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return png


def draw_icon(size):
    px = new_canvas(size, (0, 0, 0, 0))
    s = size / 512.0

    def R(v):
        return max(1, int(round(v * s)))

    fill_rounded(px, size, 0, 0, size, size, R(112), (13, 22, 41, 255))
    ring(px, size, R(10), R(10), size - R(20), size - R(20), R(100), R(6), (38, 54, 84, 255))

    bx, by, bw, bh = R(96), R(196), R(264), R(120)
    ring(px, size, bx, by, bw, bh, R(28), R(16), (232, 238, 247, 255))
    fill_rounded(px, size, bx + bw - R(4), by + R(34), R(28), R(52), R(10), (232, 238, 247, 255))
    fill_rounded(px, size, bx + R(24), by + R(24), R(176), bh - R(48), R(16), (52, 211, 153, 255))
    fill_rounded(px, size, bx + R(36), by + R(34), R(152), R(16), R(8), (167, 243, 208, 255))

    fill_rounded(px, size, R(176), R(348), R(160), R(26), R(13), (56, 189, 248, 255))
    return px


def write_ico(path, png_bytes):
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_bytes), 6 + 16)
    with open(path, "wb") as f:
        f.write(header + entry + png_bytes)


full = draw_icon(512)
write_png(os.path.join(OUT, "icon.png"), full, 512)

small = draw_icon(256)
with open(os.path.join(OUT, "icon-256.png"), "wb") as f:
    pass
png256 = write_png(os.path.join(OUT, "icon-256.png"), small, 256)
write_ico(os.path.join(OUT, "icon.ico"), png256)

print("icons written to", OUT)
print(sorted(os.listdir(OUT)))
