#!/usr/bin/env python3
"""Cut a generated multi-pose sheet into one aligned game-ready animation strip.

    python3 scripts/sheetify.py sheet.png out_strip.png --frames 4 --size 32 [--preview big.png]

`spritify.py` brings a *single* generated figure down to one frame. It is the
wrong tool for a sheet, and not because of the slicing: it crops each subject to
its own bounding box and rescales it to fill the frame. Run per pose that gives
every frame its own scale and its own baseline, and the result jitters — the
character grows, shrinks and hops between frames, which reads far worse than no
animation at all.

So this measures every pose first and then commits to numbers shared by all of
them:

  * one scale, from the tallest pose, so nobody changes size;
  * one baseline, so the feet stay on the floor;
  * horizontal alignment by the *centroid* of the opaque pixels rather than the
    bounding-box centre, because a single outstretched leg moves the box a long
    way and the body barely at all.

Poses are found by looking for fully transparent columns rather than by assuming
equal cells — generators space figures unevenly, and slicing a sheet into equal
thirds when the art is not in equal thirds decapitates two of them.

Everything after placement is `spritify`'s own pipeline, imported rather than
reimplemented, so a strip that comes out of here obeys exactly the same palette
and outline rules as every hand-drawn sprite in the repo.

Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from spritify import (  # noqa: E402
    key_background,
    load_palette,
    outline,
    quantise,
    read_png,
    write_png,
)


def alpha_at(rgba: bytearray, width: int, x: int, y: int) -> int:
    return rgba[(y * width + x) * 4 + 3]


def find_poses(width: int, height: int, rgba: bytearray, min_gap: int) -> list[tuple[int, int]]:
    """Column runs holding art, split on gaps of at least `min_gap` empty columns."""
    filled = [any(alpha_at(rgba, width, x, y) for y in range(height)) for x in range(width)]

    runs: list[tuple[int, int]] = []
    start: int | None = None
    gap = 0
    for x in range(width):
        if filled[x]:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                runs.append((start, x - gap))
                start = None
    if start is not None:
        runs.append((start, width - 1))
    return runs


def measure(rgba: bytearray, width: int, x0: int, x1: int) -> tuple[int, int, float] | None:
    """Vertical bounds and the horizontal centroid of one pose."""
    top, bottom, sum_x, count = None, None, 0, 0
    for x in range(x0, x1 + 1):
        for y in range(len(rgba) // 4 // width):
            if not alpha_at(rgba, width, x, y):
                continue
            if top is None or y < top:
                top = y
            if bottom is None or y > bottom:
                bottom = y
            sum_x += x
            count += 1
    if count == 0 or top is None or bottom is None:
        return None
    return top, bottom, sum_x / count


def sample(src: bytearray, src_w: int, sx0: int, sy0: int, sx1: int, sy1: int,
           dst: bytearray, dst_w: int, ox: int, oy: int, dw: int, dh: int) -> None:
    """Box-average a source rect into a dw x dh block at (ox, oy) of `dst`.

    Opaque pixels only, exactly as spritify.downsample does it: averaging the
    transparent field in would drag every edge toward the background colour, so
    the opaque share of a cell becomes its coverage and a mostly-empty cell drops
    out rather than smearing.
    """
    span_x = max(1, sx1 - sx0 + 1)
    span_y = max(1, sy1 - sy0 + 1)
    for j in range(dh):
        ay0 = sy0 + (j * span_y) // dh
        ay1 = sy0 + ((j + 1) * span_y) // dh
        for i in range(dw):
            ax0 = sx0 + (i * span_x) // dw
            ax1 = sx0 + ((i + 1) * span_x) // dw
            r = g = b = n = 0
            total = 0
            for y in range(ay0, max(ay0 + 1, ay1)):
                for x in range(ax0, max(ax0 + 1, ax1)):
                    total += 1
                    o = (y * src_w + x) * 4
                    if src[o + 3] == 0:
                        continue
                    r += src[o]
                    g += src[o + 1]
                    b += src[o + 2]
                    n += 1
            if n == 0 or n * 2 < total:
                continue
            dx, dy = ox + i, oy + j
            if not (0 <= dx < dst_w and 0 <= dy < dst_w):
                continue
            d = (dy * dst_w + dx) * 4
            dst[d] = r // n
            dst[d + 1] = g // n
            dst[d + 2] = b // n
            dst[d + 3] = 255


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('dest')
    ap.add_argument('--frames', type=int, required=True, help='poses expected on the sheet')
    ap.add_argument('--size', type=int, default=32, help='output frame size, px')
    ap.add_argument('--margin', type=int, default=1,
                    help='empty rows kept under the feet, for the outline ring')
    ap.add_argument('--min-gap', type=int, default=8,
                    help='empty columns that count as a break between poses')
    ap.add_argument('--preview', help='also write a nearest-neighbour blow-up of the strip')
    ap.add_argument('--preview-scale', type=int, default=8)
    args = ap.parse_args()

    width, height, rgba = read_png(Path(args.source))
    key_background(width, height, rgba)

    runs = find_poses(width, height, rgba, args.min_gap)
    poses = [(x0, x1, m) for x0, x1 in runs if (m := measure(rgba, width, x0, x1)) is not None]
    # Generators leave specks of keyed fringe behind; anything far narrower than
    # the real poses is noise, not a frame.
    if poses:
        widest = max(x1 - x0 + 1 for x0, x1, _ in poses)
        poses = [p for p in poses if (p[1] - p[0] + 1) * 4 >= widest]

    print(f'{args.source}: found {len(poses)} pose(s)')
    for i, (x0, x1, (top, bottom, cx)) in enumerate(poses):
        print(f'  {i}: x {x0}-{x1} ({x1 - x0 + 1}px), y {top}-{bottom} ({bottom - top + 1}px)')
    if len(poses) != args.frames:
        raise SystemExit(f'expected {args.frames} poses, found {len(poses)} — '
                         f'adjust --min-gap, or fix the sheet')

    size = args.size
    usable = size - args.margin
    tallest = max(bottom - top + 1 for _, _, (top, bottom, _) in poses)
    # One scale for every pose, so the character never changes size mid-stride.
    scale = (usable - args.margin) / tallest

    palette = load_palette()
    ink = min(palette, key=lambda c: c[0] + c[1] + c[2])

    frames: list[bytearray] = []
    for x0, x1, (top, bottom, cx) in poses:
        cell = bytearray(size * size * 4)
        pw = max(1, round((x1 - x0 + 1) * scale))
        ph = max(1, round((bottom - top + 1) * scale))
        # Bottom-anchored: a shared floor is what stops the walk from bouncing.
        oy = usable - ph
        # Centroid-aligned: the bounding box lurches when one leg swings out.
        ox = round(size / 2 - (cx - x0) * scale)
        sample(rgba, width, x0, top, x1, bottom, cell, size, ox, oy, pw, ph)
        quantise(cell, palette)
        outline(size, cell, ink)
        frames.append(cell)

    strip = bytearray(size * args.frames * size * 4)
    row = size * args.frames * 4
    for n, frame in enumerate(frames):
        for y in range(size):
            d = y * row + n * size * 4
            strip[d:d + size * 4] = frame[y * size * 4:(y + 1) * size * 4]
    write_png(Path(args.dest), size * args.frames, size, strip)

    solid = [sum(1 for i in range(size * size) if f[i * 4 + 3]) for f in frames]
    print(f'{args.dest}: {size * args.frames}x{size}, {args.frames} frames, '
          f'solid px {min(solid)}-{max(solid)}')
    if min(solid) == 0:
        print('  WARNING: blank frame in the strip')

    if args.preview:
        z = args.preview_scale
        w, h = size * args.frames * z, size * z
        blown = bytearray(w * h * 4)
        for y in range(h):
            for x in range(w):
                s = ((y // z) * size * args.frames + x // z) * 4
                blown[(y * w + x) * 4:(y * w + x) * 4 + 4] = strip[s:s + 4]
        write_png(Path(args.preview), w, h, blown)
        print(f'  {args.preview}: {w}x{h} preview')

    return 0


if __name__ == '__main__':
    sys.exit(main())
