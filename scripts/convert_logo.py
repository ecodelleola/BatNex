"""Build all Batnex logo assets from a source favicon.ico.

Usage: python scripts/convert_logo.py [source.ico]
Default source: assets/source-logo.ico (committed).

The designer's ICO has an opaque near-white background; the exterior white
is flood-removed (threshold) so every output has real transparency while
enclosed interior whites (battery body, bolt highlights) are preserved.

Outputs:
  assets/icon.png      256px (window + taskbar icon)
  assets/icon.ico      multi-size ICO 16/32/48/64/128/256 (exe + installer)
  renderer/logo.png    64px (in-app title bar)
"""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DEFAULT_SRC = os.path.join(ROOT, "assets", "source-logo.ico")

WHITE_FLOOR = 245  # exterior pixels this bright (or brighter) become transparent


def read_ico(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"\x00\x00\x01\x00", "not an .ico file"
    count = struct.unpack("<H", data[4:6])[0]
    entries = []
    for i in range(count):
        o = 6 + i * 16
        w = data[o] or 256
        h = data[o + 1] or 256
        size = struct.unpack("<I", data[o + 8:o + 12])[0]
        off = struct.unpack("<I", data[o + 12:o + 16])[0]
        entries.append((w, h, data[off:off + size]))
    return entries


def decode_bmp_image(blob):
    hs, iw, ih, planes, bpp, comp = struct.unpack("<IiiHHI", blob[:20])
    assert hs == 40 and bpp == 32 and comp == 0, "need 32bpp BI_RGB entry"
    ih //= 2
    px = blob[40:40 + iw * ih * 4]
    assert len(px) == iw * ih * 4, "truncated pixels"
    out = bytearray(iw * ih * 4)
    for y in range(ih):
        for x in range(iw):
            si = ((ih - 1 - y) * iw + x) * 4
            di = (y * iw + x) * 4
            out[di] = px[si + 2]
            out[di + 1] = px[si + 1]
            out[di + 2] = px[si]
            out[di + 3] = px[si + 3]
    return iw, ih, out


def pick_largest(entries):
    best = None
    for w, h, blob in entries:
        is_png = blob[:8] == bytes.fromhex("89504e470d0a1a0a")
        if not is_png:
            if best is None or w * h > best[0] * best[1]:
                best = (w, h, blob)
    if best is None:
        raise ValueError("no BMP entries found (PNG-in-ICO not supported by this tool)")
    return best


def exterior_white_to_transparent(w, h, px):
    n = w * h
    keep = bytearray(n)  # 1 = exterior white
    stack = []
    for x in range(w):
        stack.append(x)
        stack.append((h - 1) * w + x)
    for y in range(h):
        stack.append(y * w)
        stack.append(y * w + w - 1)
    while stack:
        i = stack.pop()
        if i < 0 or i >= n or keep[i]:
            continue
        o = i * 4
        if min(px[o], px[o + 1], px[o + 2]) < WHITE_FLOOR:
            continue
        keep[i] = 1
        x, y = i % w, i // w
        if x > 0:
            stack.append(i - 1)
        if x < w - 1:
            stack.append(i + 1)
        if y > 0:
            stack.append(i - w)
        if y < h - 1:
            stack.append(i + w)
    for i in range(n):
        if keep[i]:
            px[i * 4 + 3] = 0
    return sum(keep)


def downscale(src_w, src_h, src, dst):
    assert src_w == src_h and src_w % dst == 0
    k = src_w // dst
    out = bytearray(4 * dst * dst)
    for y in range(dst):
        for x in range(dst):
            rs = gs = bs = a = 0
            for dy in range(k):
                for dx in range(k):
                    i = (((y * k + dy) * src_w + (x * k + dx)) * 4)
                    rs += src[i]; gs += src[i + 1]; bs += src[i + 2]; a += src[i + 3]
            n = k * k
            j = (y * dst + x) * 4
            out[j:j + 4] = bytes((rs // n, gs // n, bs // n, a // n))
    return out


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


def write_ico(path, pngs):
    # PNG-compressed entries (valid on Vista+).
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    body = b""
    for size, data in pngs:
        entry = struct.pack("<BBBBHHII", size if size < 256 else 0, size if size < 256 else 0,
                            0, 0, 1, 32, len(data), offset)
        header += entry
        offset += len(data)
        body += data
    with open(path, "wb") as f:
        f.write(header + body)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    entries = read_ico(src)
    print(f"{len(entries)} entries")
    w, h, blob = pick_largest(entries)
    print(f"largest: {w}x{h}")
    iw, ih, px = decode_bmp_image(blob)
    assert iw == w and ih == h

    cleared = exterior_white_to_transparent(iw, ih, px)
    frac = cleared / (iw * ih)
    print(f"exterior cleared: {cleared} px ({frac:.1%})")
    assert 0.02 < frac < 0.60, "suspicious clear fraction - aborting"

    white_inside = 0
    for i in range(0, len(px), 4):
        if px[i + 3] and px[i] > 240 and px[i + 1] > 240 and px[i + 2] > 240:
            white_inside += 1
    print(f"opaque near-white pixels kept: {white_inside}")
    assert white_inside > 1000, "interior whites were wiped - aborting"

    write_png(os.path.join(ROOT, "assets", "icon.png"), px, iw)
    write_png(os.path.join(ROOT, "renderer", "logo.png"), downscale(iw, ih, px, 64), 64)
    pngs = []
    for size in (256, 128, 64, 32, 16):
        data = write_png(os.path.join(ROOT, "assets", f"icon-{size}.png"),
                         downscale(iw, ih, px, size) if size != iw else px, size)
        pngs.append((size, data))
    write_ico(os.path.join(ROOT, "assets", "icon.ico"), pngs)
    print("assets written")


main()
