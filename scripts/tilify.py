#!/usr/bin/env python3
"""Turn a generated texture into a seamless ground tile.

A tile is not a sprite. The texture fills the whole frame, so there is no chroma
field to key, no subject to crop to and no silhouette to outline — every step
spritify.py performs before the box filter is wrong here. What a tile needs
instead is to *repeat*: `src/render/tilemap.ts` picks one per world coordinate by
hash and draws them edge to edge, so any mismatch between a tile's first and last
row prints a grid across the entire map.

So: centred square, box-sample down with a couple of pixels of overscan, fold that
overscan back over the near edge as a cross-fade, and only then snap to the
canonical palette. Blending after the remap would mix palette entries into colours
the palette does not contain, and the whole point of quantising last is that
nothing downstream can undo it.

Two knobs earn their place because the sources are photographs of a texture rather
than the texture itself. `--crop` picks how much of the frame one tile represents:
the models paint several repeats of a pattern per image, and folding all of them
into sixteen pixels averages the material away. `--gain` sets the ground below the
actors, which the generated art does not do on its own.

    python3 scripts/tilify.py in.png public/assets/tiles/stone.png --size 16 --crop 0.25 --gain 0.72
    python3 scripts/tilify.py in.png out.png --size 32 --preview p.png --preview-repeat 4
    python3 scripts/tilify.py tiles/stone.png tiles/stone_b.png --derive --step 1 --roll 8

The last form derives a variant from a tile that is already converted, so a
tileset can carry two or three faces of the same material without asking the
model for near-duplicates it cannot keep on-palette anyway.

PNG codec, palette and quantiser are spritify's — only the pipeline differs.
Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from spritify import load_palette, quantise, read_png, upscale, write_png

#: Mean luminance a ground tile should stay under, so actors keep popping off it.
BRIGHT_LIMIT = 85.0
#: Value ratio of one palette step, near the spacing of the palette's own dark ramp.
STEP_RATIO = 1.3


def luma(colour: tuple[int, int, int]) -> float:
    """Rec. 601 luminance. Reports how dark a tile reads against the actors on it."""
    return 0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2]


def centre_square(width: int, height: int, fraction: float = 1.0) -> tuple[int, int, int, int]:
    """The largest centred square of the frame, optionally only a fraction of it.

    Full frame is the honest default, but the models paint four to nine repeats
    of a pattern across 1024px, and folding all of them into sixteen pixels is a
    64:1 low-pass that erases precisely the mortar joints and grit that make a
    material read as that material — you get a flat lavender field. Sampling
    about one period of the pattern keeps the detail at the size the game wants
    it, and the wrap fold is what lets a sub-crop still tile.
    """
    span = max(int(min(width, height) * fraction), 1)
    x0, y0 = (width - span) // 2, (height - span) // 2
    return x0, y0, x0 + span - 1, y0 + span - 1


def resample(src: bytearray, width: int, box: tuple[int, int, int, int], size: int) -> bytearray:
    """Box-average the source square down to size x size.

    Unlike a sprite there is no subject and no background, so every source pixel
    counts: no coverage test, no aspect padding, and the result is always fully
    opaque whatever the source alpha said.
    """
    x0, y0, x1, _ = box
    span = x1 - x0 + 1
    if size > span:
        raise SystemExit(f'source square is {span}px, too small to sample {size}px from')
    out = bytearray(size * size * 4)
    for ty in range(size):
        sy0, sy1 = y0 + ty * span // size, y0 + (ty + 1) * span // size
        for tx in range(size):
            sx0, sx1 = x0 + tx * span // size, x0 + (tx + 1) * span // size
            r = g = b = n = 0
            for sy in range(sy0, sy1):
                row = sy * width
                for sx in range(sx0, sx1):
                    o = (row + sx) * 4
                    r, g, b, n = r + src[o], g + src[o + 1], b + src[o + 2], n + 1
            t = (ty * size + tx) * 4
            out[t:t + 4] = bytes((r // n, g // n, b // n, 255))
    return out


def wrap_fold(buf: bytearray, over: int, size: int, band: int) -> bytearray:
    """Fold `band` pixels of overscan back onto the opposite edge, and crop to size.

    `buf` is sampled at `over` = size + band, so the extra rows and columns are
    genuine continuation of the texture rather than a mirror of it. Row `size + i`
    is what would naturally have followed row `size - 1`, so ramping it into row
    `i` gives the join across the tile boundary real content to carry. Averaging
    row 0 against row size-1 instead would make the two identical and leave a
    duplicated line at every seam — swapping one grid artifact for another.

    Rows first, then columns, on the same buffer: the corners end up bilinearly
    blended between all four, which is what a torus wants.
    """
    folded = bytearray(buf)
    for i in range(band):
        w = (i + 1) / (band + 1)
        for x in range(over):
            near, far = (i * over + x) * 4, ((size + i) * over + x) * 4
            for c in range(3):
                folded[near + c] = round(w * buf[near + c] + (1 - w) * buf[far + c])

    rows = bytearray(folded)
    for j in range(band):
        w = (j + 1) / (band + 1)
        for y in range(over):
            near, far = (y * over + j) * 4, (y * over + size + j) * 4
            for c in range(3):
                folded[near + c] = round(w * rows[near + c] + (1 - w) * rows[far + c])

    out = bytearray(size * size * 4)
    for y in range(size):
        src = y * over * 4
        out[y * size * 4:(y + 1) * size * 4] = folded[src:src + size * 4]
    return out


def level(rgba: bytearray, factor: float) -> None:
    """Scale the texture's value, before quantising.

    The models light ground like a daylight photograph; this game wants floor
    that sits *under* its actors, so several sources land near mid-grey and the
    characters stop popping off them. Scaling RGB holds the hue ratios and lets
    the remap decide where each pixel lands, which is exactly why it runs before
    quantise — darkening afterwards could only step along the palette, which
    crushes the spread and walks desaturated greys into saturated indigos.
    """
    if factor == 1.0:
        return
    for idx in range(len(rgba) // 4):
        o = idx * 4
        for c in range(3):
            rgba[o + c] = min(255, round(rgba[o + c] * factor))


def shade(rgba: bytearray, palette: list[tuple[int, int, int]], steps: int) -> None:
    """Move every pixel `steps` entries along the palette: negative darker, positive lighter.

    This is the whole of the variant derivation. "One entry along" deliberately
    goes through a value scale rather than the palette's own index order, because
    the palette is a set of hues and not a ramp: sorting it by luminance puts the
    lone green between two violets, so index arithmetic turns moss into a bruise.
    Scaling the value and re-snapping keeps a pixel where it is when the palette
    has nowhere better to send it, which is exactly the behaviour a variant wants
    — same material, different shade.
    """
    if steps == 0:
        return
    level(rgba, STEP_RATIO ** steps)
    quantise(rgba, palette)


def drop_entries(rgba: bytearray, palette: list[tuple[int, int, int]], dropped: list[str]) -> None:
    """Remap named palette entries out of a tile, each to the nearest survivor.

    One texture can serve as two materials: the blood-soaked grass the model gave
    us is, with its reds pulled, the plain night grass the meadow wants for its
    base. Re-quantising against the reduced palette is the whole trick — pixels
    that were already keepers are their own nearest match and do not move.
    """
    if not dropped:
        return
    gone = {(int(h.lstrip('#')[0:2], 16), int(h.lstrip('#')[2:4], 16), int(h.lstrip('#')[4:6], 16)) for h in dropped}
    keep = [p for p in palette if p not in gone]
    if not keep:
        raise SystemExit('--drop left no palette to quantise against')
    quantise(rgba, keep)


def roll(rgba: bytearray, size: int, shift: int) -> bytearray:
    """Shift the tile diagonally on its own torus.

    A seamless tile is a window onto a torus, so any roll of it is seamless too.
    That makes this the cheapest possible variant: the pattern moves, not one
    colour changes, and the result is in palette by construction.
    """
    out = bytearray(len(rgba))
    for y in range(size):
        for x in range(size):
            src = (((y - shift) % size) * size + ((x - shift) % size)) * 4
            dst = (y * size + x) * 4
            out[dst:dst + 4] = rgba[src:src + 4]
    return out


def lay_out(rgba: bytearray, size: int, times: int) -> tuple[int, bytearray]:
    """Repeat the tile times x times, which is the only way to actually see a seam."""
    dim = size * times
    out = bytearray(dim * dim * 4)
    for y in range(dim):
        for x in range(dim):
            src = ((y % size) * size + (x % size)) * 4
            dst = (y * dim + x) * 4
            out[dst:dst + 4] = rgba[src:src + 4]
    return dim, out


def report(dest: str, size: int, rgba: bytearray) -> None:
    """One line per tile: the three things that can quietly go wrong."""
    pixels = [(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) for i in range(size * size)]
    mean = sum(luma(p) for p in pixels) / len(pixels)
    used = sorted(set(pixels), key=luma)
    holes = sum(1 for i in range(size * size) if rgba[i * 4 + 3] != 255)
    flags = ''
    if mean > BRIGHT_LIMIT:
        flags += f'  BRIGHT (over {BRIGHT_LIMIT:.0f})'
    if holes:
        flags += f'  {holes} NON-OPAQUE px'
    entries = ' '.join('#%02x%02x%02x' % p for p in used)
    print(f'{dest}: {size}x{size}, mean luma {mean:5.1f}, {len(used)} entries [{entries}]{flags}')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source')
    ap.add_argument('dest')
    ap.add_argument('--size', type=int, default=16)
    ap.add_argument('--blend', type=int, default=2, help='wrap cross-fade width, in tile pixels')
    ap.add_argument('--crop', type=float, default=1.0, help='fraction of the centred square to sample; ~one pattern period keeps detail')
    ap.add_argument('--gain', type=float, default=1.0, help='value multiplier applied before quantising; under 1 pushes the ground below the actors')
    ap.add_argument('--derive', action='store_true', help='source is an existing tile: skip resampling, apply --roll/--step/--drop only')
    ap.add_argument('--step', type=int, default=0, help='palette entries to move: -1 darker, 1 lighter')
    ap.add_argument('--roll', type=int, default=0, help='shift the tile on its torus to break up the repeat')
    ap.add_argument('--drop', action='append', default=[], metavar='HEX', help='remap a palette entry out of the tile, nearest survivor wins; repeatable')
    ap.add_argument('--preview', help='also write a nearest-neighbour blow-up for eyeballing')
    ap.add_argument('--preview-repeat', type=int, default=1, help='lay the preview out N x N so seams show')
    ap.add_argument('--preview-scale', type=int, default=8)
    args = ap.parse_args()

    if args.preview_repeat > 1 and not args.preview:
        raise SystemExit('--preview-repeat needs --preview to write to')

    palette = load_palette()

    if args.derive:
        size, height, tile = read_png(Path(args.source))
        if size != height:
            raise SystemExit(f'{args.source}: a tile must be square (got {size}x{height})')
    else:
        size = args.size
        width, height, rgba = read_png(Path(args.source))
        over = size + args.blend
        tile = wrap_fold(resample(rgba, width, centre_square(width, height, args.crop), over), over, size, args.blend)
        level(tile, args.gain)
        quantise(tile, palette)

    if args.roll:
        tile = roll(tile, size, args.roll)
    shade(tile, palette, args.step)
    drop_entries(tile, palette, args.drop)

    write_png(Path(args.dest), size, size, tile)
    report(args.dest, size, tile)

    if args.preview:
        dim, laid = lay_out(tile, size, args.preview_repeat)
        big, blown = upscale(dim, laid, args.preview_scale)
        write_png(Path(args.preview), big, big, blown)
        print(f'{args.preview}: {args.preview_repeat}x{args.preview_repeat} tiles at {big}x{big}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
