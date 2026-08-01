#!/usr/bin/env python3
"""Turn a generated pixel-art image into a game-ready sprite frame.

The models cannot draw at 32x32, so we ask for one big frame on a chroma-green
field and bring it down here: key out the background, crop to the subject,
box-sample to the target size, then snap every surviving pixel to the canonical
palette. Quantising last is what actually holds the style together across
batches — the prompt only nudges the model, the remap is binding.

    python3 scripts/spritify.py in.png out.png --size 32 [--preview out8x.png]

Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

PALETTE_FILE = Path(__file__).resolve().parent.parent / 'docs' / 'art' / 'palette.md'


def read_png(path: Path) -> tuple[int, int, bytearray]:
    """Decode an 8-bit RGB/RGBA PNG into a flat RGBA bytearray."""
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path}: not a PNG')
    pos, idat, width, height, depth, colour, palette = 8, b'', 0, 0, 0, 0, None
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b'IHDR':
            width, height, depth, colour = struct.unpack('>IIBB', body[:10])
        elif kind == b'PLTE':
            palette = body
        elif kind == b'IDAT':
            idat += body
    if depth != 8:
        raise SystemExit(f'{path}: only 8-bit PNGs are supported (got {depth})')

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
    stride, bpp = width * channels, channels
    raw = zlib.decompress(idat)
    out, prev, i = bytearray(), bytearray(stride), 0
    for _ in range(height):
        filt, line, i = raw[i], bytearray(raw[i + 1:i + 1 + stride]), i + 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if filt == 1:
                line[x] = (line[x] + a) & 255
            elif filt == 2:
                line[x] = (line[x] + b) & 255
            elif filt == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif filt == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += line
        prev = line

    rgba = bytearray(width * height * 4)
    for idx in range(width * height):
        src = idx * channels
        if colour == 6:
            rgba[idx * 4:idx * 4 + 4] = out[src:src + 4]
        elif colour == 2:
            rgba[idx * 4:idx * 4 + 3] = out[src:src + 3]
            rgba[idx * 4 + 3] = 255
        elif colour == 3 and palette:
            p = out[src] * 3
            rgba[idx * 4:idx * 4 + 3] = palette[p:p + 3]
            rgba[idx * 4 + 3] = 255
        else:
            grey = out[src]
            rgba[idx * 4:idx * 4 + 3] = bytes((grey, grey, grey))
            rgba[idx * 4 + 3] = 255
    return width, height, rgba


def write_png(path: Path, width: int, height: int, rgba: bytearray) -> None:
    raw = b''.join(b'\x00' + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))

    def chunk(kind: bytes, body: bytes) -> bytes:
        payload = kind + body
        return struct.pack('>I', len(body)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)

    path.write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def load_palette() -> list[tuple[int, int, int]]:
    """Read the hexes out of the palette table so there is one source of truth."""
    colours = []
    for line in PALETTE_FILE.read_text().splitlines():
        if line.startswith('| `#'):
            hex_part = line.split('`')[1].lstrip('#')
            colours.append((int(hex_part[0:2], 16), int(hex_part[2:4], 16), int(hex_part[4:6], 16)))
    if not colours:
        raise SystemExit(f'{PALETTE_FILE}: no palette entries found')
    return colours


def key_background(width: int, height: int, rgba: bytearray, tolerance: int = 90) -> None:
    """Clear the chroma field, sampled from the corners rather than assumed."""
    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    samples = [rgba[(y * width + x) * 4:(y * width + x) * 4 + 3] for x, y in corners]
    bg = tuple(sum(s[c] for s in samples) // len(samples) for c in range(3))
    for idx in range(width * height):
        o = idx * 4
        if rgba[o + 3] < 128:
            rgba[o + 3] = 0
            continue
        d = abs(rgba[o] - bg[0]) + abs(rgba[o + 1] - bg[1]) + abs(rgba[o + 2] - bg[2])
        # Green screens leave a fringe, so anything greener than it is red/blue goes too.
        greenish = rgba[o + 1] > rgba[o] + 40 and rgba[o + 1] > rgba[o + 2] + 40
        if d < tolerance or greenish:
            rgba[o + 3] = 0


def content_box(width: int, height: int, rgba: bytearray) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            if rgba[(y * width + x) * 4 + 3] > 0:
                x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
    if x1 < 0:
        raise SystemExit('nothing left after keying the background')
    return x0, y0, x1, y1


def downsample(src: bytearray, width: int, box: tuple[int, int, int, int], size: int) -> bytearray:
    """Box-average each target cell over opaque source pixels only.

    Averaging transparent pixels in would drag the edges toward black; instead
    the opaque share of a cell becomes its coverage, and a cell that is mostly
    background drops out entirely.
    """
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    # Keep the subject's aspect ratio, centred in the square frame.
    span = max(bw, bh)
    pad_x, pad_y = (span - bw) / 2, (span - bh) / 2
    out = bytearray(size * size * 4)
    for ty in range(size):
        for tx in range(size):
            sx0 = x0 - pad_x + (tx / size) * span
            sx1 = x0 - pad_x + ((tx + 1) / size) * span
            sy0 = y0 - pad_y + (ty / size) * span
            sy1 = y0 - pad_y + ((ty + 1) / size) * span
            r = g = b = opaque = total = 0
            for sy in range(max(y0, int(sy0)), min(y1 + 1, max(int(sy1) + 1, int(sy0) + 1))):
                for sx in range(max(x0, int(sx0)), min(x1 + 1, max(int(sx1) + 1, int(sx0) + 1))):
                    o = (sy * width + sx) * 4
                    total += 1
                    if src[o + 3] > 0:
                        r, g, b, opaque = r + src[o], g + src[o + 1], b + src[o + 2], opaque + 1
            t = (ty * size + tx) * 4
            if opaque and opaque * 2 >= max(total, 1):
                out[t:t + 4] = bytes((r // opaque, g // opaque, b // opaque, 255))
    return out


def quantise(rgba: bytearray, palette: list[tuple[int, int, int]]) -> None:
    cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    for idx in range(len(rgba) // 4):
        o = idx * 4
        if rgba[o + 3] == 0:
            continue
        key = (rgba[o], rgba[o + 1], rgba[o + 2])
        hit = cache.get(key)
        if hit is None:
            # Weighted RGB distance: eyes weight green most, blue least.
            hit = min(palette, key=lambda p: 2 * (p[0] - key[0]) ** 2 + 4 * (p[1] - key[1]) ** 2 + 3 * (p[2] - key[2]) ** 2)
            cache[key] = hit
        rgba[o:o + 3] = bytes(hit)


def outline(size: int, rgba: bytearray, colour: tuple[int, int, int]) -> int:
    """Draw the mandatory 1px silhouette keyline into the empty ring around the subject.

    The obvious implementation recolours the subject's own perimeter pixels, and
    it ruins small round shapes: a 9px coin has about two pixels of arc per
    octant to describe its curvature with, so spending them on black collapses
    the disc into a rounded square. Growing outward instead costs the subject
    nothing at any size. A subject already touching the frame simply loses the
    keyline on that side, which is why downsample() leaves a margin.

    Returns the number of pixels drawn, so callers can see when a cramped frame
    swallowed part of the keyline.
    """
    ring = []
    for y in range(size):
        for x in range(size):
            if rgba[(y * size + x) * 4 + 3] != 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < size and 0 <= ny < size and rgba[(ny * size + nx) * 4 + 3] != 0:
                    ring.append((x, y))
                    break
    for x, y in ring:
        o = (y * size + x) * 4
        rgba[o:o + 4] = bytes((*colour, 255))
    return len(ring)


def upscale(size: int, rgba: bytearray, factor: int) -> tuple[int, bytearray]:
    big = size * factor
    out = bytearray(big * big * 4)
    for y in range(big):
        for x in range(big):
            s = ((y // factor) * size + (x // factor)) * 4
            out[(y * big + x) * 4:(y * big + x) * 4 + 4] = rgba[s:s + 4]
    return big, out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source')
    ap.add_argument('dest')
    ap.add_argument('--size', type=int, default=32)
    ap.add_argument('--preview', help='also write a nearest-neighbour blow-up for eyeballing')
    ap.add_argument('--preview-scale', type=int, default=8)
    ap.add_argument('--no-outline', action='store_true')
    args = ap.parse_args()

    palette = load_palette()
    width, height, rgba = read_png(Path(args.source))
    key_background(width, height, rgba)
    frame = downsample(rgba, width, content_box(width, height, rgba), args.size)
    quantise(frame, palette)
    if not args.no_outline:
        outline(args.size, frame, palette[0])
    write_png(Path(args.dest), args.size, args.size, frame)

    solid = sum(1 for i in range(args.size * args.size) if frame[i * 4 + 3])
    used = len({tuple(frame[i * 4:i * 4 + 3]) for i in range(args.size * args.size) if frame[i * 4 + 3]})
    print(f'{args.dest}: {args.size}x{args.size}, {solid} solid px, {used} palette entries used')

    if args.preview:
        big, blown = upscale(args.size, frame, args.preview_scale)
        write_png(Path(args.preview), big, big, blown)
        print(f'{args.preview}: {big}x{big} preview')
    return 0


if __name__ == '__main__':
    sys.exit(main())
