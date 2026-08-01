#!/usr/bin/env python3
"""Snap an existing sprite or strip to the canonical palette, in place.

For art that arrived outside the pipeline. The character strips were extracted
from generated sheets and carry thousands of near-duplicate colours — the same
violet written thirty ways — which is invisible on one sprite and corrosive
across a set: every new batch that goes through `spritify.py` lands on the
palette exactly, and the ones that did not drift a little further away.

This is deliberately the narrowest possible tool: same dimensions, same alpha,
same silhouette, every opaque pixel moved to its nearest palette entry. It does
not resize, crop, key or outline — if a sprite needs that, it needs
`spritify.py` instead.

    python3 scripts/repalette.py public/assets/player/morrigan_idle.png
    python3 scripts/repalette.py 'public/assets/player/*.png' --dry-run

Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from spritify import load_palette, quantise, read_png, upscale, write_png  # noqa: E402


def distinct_colours(rgba: bytearray) -> int:
    return len({tuple(rgba[i * 4:i * 4 + 3]) for i in range(len(rgba) // 4) if rgba[i * 4 + 3]})


def mean_shift(before: bytearray, after: bytearray) -> float:
    """Average distance a pixel moved, so a silent disaster cannot pass as a success."""
    total = moved = 0
    for i in range(len(before) // 4):
        if before[i * 4 + 3] == 0:
            continue
        moved += max(abs(before[i * 4 + c] - after[i * 4 + c]) for c in range(3))
        total += 1
    return moved / total if total else 0.0


def side_by_side(width: int, height: int, before: bytearray, after: bytearray, factor: int) -> tuple[int, int, bytearray]:
    """One strip over the other, blown up, so the shift can be judged by eye."""
    gap = 2
    out_w, out_h = width, height * 2 + gap
    sheet = bytearray(out_w * out_h * 4)
    for y in range(height):
        for x in range(width):
            s = (y * width + x) * 4
            sheet[(y * out_w + x) * 4:(y * out_w + x) * 4 + 4] = before[s:s + 4]
            d = ((y + height + gap) * out_w + x) * 4
            sheet[d:d + 4] = after[s:s + 4]
    big = bytearray(out_w * factor * out_h * factor * 4)
    for y in range(out_h * factor):
        for x in range(out_w * factor):
            s = ((y // factor) * out_w + (x // factor)) * 4
            big[(y * out_w * factor + x) * 4:(y * out_w * factor + x) * 4 + 4] = sheet[s:s + 4]
    return out_w * factor, out_h * factor, big


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('paths', nargs='+', help='files or globs')
    ap.add_argument('--dry-run', action='store_true', help='report what would change, write nothing')
    ap.add_argument('--compare', help='write a before/after blow-up of the first file here')
    ap.add_argument('--compare-scale', type=int, default=4)
    args = ap.parse_args()

    palette = load_palette()
    targets = sorted({p for pattern in args.paths for p in glob.glob(pattern)})
    if not targets:
        raise SystemExit('no files matched')

    first = None
    for path in targets:
        width, height, rgba = read_png(Path(path))
        before = bytearray(rgba)
        quantise(rgba, palette)
        print(f'{path}: {width}x{height}, {distinct_colours(before)} -> {distinct_colours(rgba)} colours, '
              f'mean shift {mean_shift(before, rgba):.1f}/255')
        if first is None:
            first = (width, height, before, bytearray(rgba))
        if not args.dry_run:
            write_png(Path(path), width, height, rgba)

    if args.compare and first:
        width, height, before, after = first
        w, h, sheet = side_by_side(width, height, before, after, args.compare_scale)
        write_png(Path(args.compare), w, h, sheet)
        print(f'{args.compare}: {w}x{h} before/after')
    if args.dry_run:
        print('dry run — nothing written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
