#!/usr/bin/env python3
"""Draw the geometric weapon effects — beads, bursts, rings, crescents, pools.

    python3 scripts/drawfx.py [--check]
    python3 scripts/drawfx.py --preview out.png

Character and enemy art comes down from generated images through `spritify.py`,
which keys the background, downsamples and quantises. That pipeline is wrong for
this handful of sprites: a shockwave ring is a circle of a stated radius, a
tether bead is a disc, a crescent is one disc subtracted from another. Painting
them and then quantising back to a circle loses the one property they have to
keep — the drawn edge is the collider, and `spriteScaleForRadius` fits the two
together by width, so a ring whose stroke wanders by a pixel reads as a
mis-sized hitbox.

So these are drawn in code, from the same `docs/art/palette.md` every other
sprite is quantised into (loaded through spritify, never re-listed here). The
output goes through `validate-art.py` exactly like hand-drawn art does: nothing
here is exempt from the palette or the frame rules, and `--check` re-renders
into memory and diffs against what is committed, so an edit to this file that
was never run shows up as a failure rather than as art that silently disagrees
with its source.

Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

from spritify import load_palette, write_png

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'public' / 'assets'

# Palette roles, by the names docs/art/palette.md gives them. Every value is
# asserted to be in the palette before anything is written.
VOID = '#040109'
CRYPT_SHADOW = '#110c1a'
DEEP_INDIGO = '#1a0d39'
WINE_SHADOW = '#311d35'
ROYAL_VIOLET_DARK = '#34264f'
DRIED_BLOOD = '#802331'
ROYAL_VIOLET = '#443569'
DUSK_VIOLET = '#555073'
ASH_VIOLET = '#6a6980'
PALE_VIOLET = '#867797'
MOONLIT_STEEL = '#aab7c9'
BONE = '#d0c2ad'
COLD_HIGHLIGHT = '#d1d8e2'
FRESH_BLOOD = '#d94a5e'
TORCH_ORANGE = '#ff8c42'
TARNISHED_GOLD = '#d4a15a'
DEEP_GOLD = '#8a6a34'


def snap(v: float) -> int:
    """Round half away from zero, unlike round(), which rounds half to even.

    Bankers' rounding puts the left arm of a star one row above the right arm,
    because the two sides land on either side of a .5 — visible as a jog in a
    shape that is supposed to be symmetric.
    """
    return math.floor(v + 0.5)


def rgb(hex_colour: str) -> tuple[int, int, int]:
    h = hex_colour.lstrip('#')
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


class Canvas:
    """A square RGBA buffer with the few primitives these shapes are made of.

    Coordinates are pixel centres, so a disc of radius r drawn at the centre of
    an even-sized canvas is symmetric about the seam rather than one pixel off.
    """

    def __init__(self, size: int) -> None:
        self.size = size
        self.px = bytearray(size * size * 4)
        self.mid = (size - 1) / 2

    def put(self, x: int, y: int, colour: str) -> None:
        if not (0 <= x < self.size and 0 <= y < self.size):
            return
        o = (y * self.size + x) * 4
        r, g, b = rgb(colour)
        self.px[o] = r
        self.px[o + 1] = g
        self.px[o + 2] = b
        self.px[o + 3] = 255

    def at(self, x: int, y: int) -> tuple[int, int, int, int]:
        o = (y * self.size + x) * 4
        return self.px[o], self.px[o + 1], self.px[o + 2], self.px[o + 3]

    def disc(self, cx: float, cy: float, radius: float, colour: str) -> None:
        for y in range(self.size):
            for x in range(self.size):
                if math.hypot(x - cx, y - cy) <= radius:
                    self.put(x, y, colour)

    def annulus(self, cx: float, cy: float, inner: float, outer: float, colour: str) -> None:
        for y in range(self.size):
            for x in range(self.size):
                d = math.hypot(x - cx, y - cy)
                if inner <= d <= outer:
                    self.put(x, y, colour)

    def erase_disc(self, cx: float, cy: float, radius: float) -> None:
        for y in range(self.size):
            for x in range(self.size):
                if math.hypot(x - cx, y - cy) <= radius:
                    o = (y * self.size + x) * 4
                    self.px[o:o + 4] = b'\x00\x00\x00\x00'

    def ray(self, cx: float, cy: float, angle: float, length: float, colours: list[str]) -> None:
        """A one-pixel spoke whose colour walks `colours` from centre to tip."""
        steps = max(1, int(length * 2))
        # Trig noise at the cardinals is a full pixel of asymmetry once snapped.
        dx = math.cos(angle)
        dy = math.sin(angle)
        if abs(dx) < 1e-9:
            dx = 0.0
        if abs(dy) < 1e-9:
            dy = 0.0
        for i in range(steps + 1):
            t = i / steps
            band = min(len(colours) - 1, int(t * len(colours)))
            self.put(snap(cx + dx * length * t), snap(cy + dy * length * t), colours[band])

    def outline(self, colour: str) -> None:
        """Wraps every opaque run in `colour`, the way spritify.outline does."""
        edges = []
        for y in range(self.size):
            for x in range(self.size):
                if self.at(x, y)[3] != 0:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < self.size and 0 <= ny < self.size and self.at(nx, ny)[3] != 0:
                        edges.append((x, y))
                        break
        for x, y in edges:
            self.put(x, y, colour)


# A fixed lumpiness table, indexed by angle: a blood pool that is a perfect
# circle reads as a bubble. Handwritten rather than random so the art is a pure
# function of this file — the same reason gameplay never touches Math.random.
POOL_WOBBLE = [1.0, 0.92, 1.06, 0.88, 1.0, 1.1, 0.9, 0.97, 1.08, 0.86, 1.0, 1.04]


def pool(canvas: Canvas, radius: float, rim: str, body: str, glint: str) -> None:
    """A squashed, lumpy puddle: wider than tall, since it lies on the ground."""
    cx = cy = canvas.mid
    for y in range(canvas.size):
        for x in range(canvas.size):
            dx = (x - cx)
            dy = (y - cy) * 1.45
            d = math.hypot(dx, dy)
            if d == 0:
                canvas.put(x, y, body)
                continue
            angle = math.atan2(dy, dx) % (2 * math.pi)
            wobble = POOL_WOBBLE[int(angle / (2 * math.pi) * len(POOL_WOBBLE)) % len(POOL_WOBBLE)]
            edge = radius * wobble
            if d <= edge * 0.72:
                canvas.put(x, y, body)
            elif d <= edge:
                canvas.put(x, y, rim)
    # Two glints, offset up-left, where a wet surface would catch the moon.
    canvas.put(snap(cx - radius * 0.35), snap(cy - radius * 0.3), glint)
    canvas.put(snap(cx - radius * 0.2), snap(cy - radius * 0.3), glint)
    canvas.put(snap(cx + radius * 0.3), snap(cy + radius * 0.12), glint)


def bead(size: int, rim: str, body: str, core: str, spark: str | None) -> Canvas:
    """A droplet of blood: the tether is a line of these."""
    c = Canvas(size)
    r = size / 2 - 0.5
    c.disc(c.mid, c.mid, r, rim)
    c.disc(c.mid, c.mid, r * 0.66, body)
    c.disc(c.mid, c.mid, r * 0.3, core)
    if spark:
        c.put(snap(c.mid - r * 0.35), snap(c.mid - r * 0.35), spark)
    return c


def burst(size: int, core: str, mid: str, tip: str) -> Canvas:
    """A leaping spark: long cardinal spokes, short diagonals, bright middle."""
    c = Canvas(size)
    reach = size / 2 - 1
    for i in range(16):
        angle = i * math.pi / 8
        # Cardinals reach furthest, then the half-diagonals, then the corners:
        # the silhouette stays a star instead of collapsing into a disc.
        length = reach * (1.0 if i % 4 == 0 else 0.55 if i % 2 == 0 else 0.34)
        c.ray(c.mid, c.mid, angle, length, [core, mid, tip])
    c.disc(c.mid, c.mid, max(1.5, size * 0.11), core)
    return c


def ring(size: int, stroke: float, outer_edge: str, body: str, inner_edge: str, echo: str) -> Canvas:
    """A shockwave: one heavy ring, plus a thin echo inside it."""
    c = Canvas(size)
    outer = size / 2 - 0.5
    c.annulus(c.mid, c.mid, outer - stroke, outer, outer_edge)
    c.annulus(c.mid, c.mid, outer - stroke + 1, outer - 1, body)
    c.annulus(c.mid, c.mid, outer - stroke + 1.5, outer - stroke + 2.9, inner_edge)
    echo_r = outer * 0.6
    c.annulus(c.mid, c.mid, echo_r - 1, echo_r, echo)
    return c


def crescent(size: int, edge: str, body: str, shade: str, rim: str | None) -> Canvas:
    """A curved blade: one disc with a second bitten out of it."""
    c = Canvas(size)
    r = size / 2 - 1
    c.disc(c.mid, c.mid, r, shade)
    c.disc(c.mid - 0.6, c.mid - 0.6, r - 1, body)
    c.disc(c.mid - 1.2, c.mid - 1.2, r - 2.2, edge)
    # The bite is offset down-right, leaving the cutting edge up-left. It is
    # nearly as wide as the blade itself, so what survives is a thin arc.
    c.erase_disc(c.mid + r * 0.52, c.mid + r * 0.52, r * 1.02)
    if rim:
        for y in range(size):
            for x in range(size):
                if c.at(x, y)[3] == 0:
                    continue
                if math.hypot(x - c.mid, y - c.mid) >= r - 1:
                    c.put(x, y, rim)
    c.outline(VOID)
    return c


def build() -> dict[str, Canvas]:
    """Every sprite this script owns, keyed by its path under public/assets."""
    art: dict[str, Canvas] = {}

    # Bloodlink / Crimson Meridian — the beads a cord is strung from.
    art['weapons/cord.png'] = bead(10, VOID, DRIED_BLOOD, FRESH_BLOOD, None)
    art['weapons/meridian.png'] = bead(14, VOID, FRESH_BLOOD, TARNISHED_GOLD, COLD_HIGHLIGHT)

    # Corpselight / Wildfire Sermon — the spark left at each leap.
    # Odd sizes: a star wants a single centre pixel, not a seam between four.
    art['fx/corpselight.png'] = burst(29, COLD_HIGHLIGHT, MOONLIT_STEEL, ROYAL_VIOLET)
    art['fx/wildfire.png'] = burst(39, COLD_HIGHLIGHT, TARNISHED_GOLD, TORCH_ORANGE)

    # Red Wake / Hemorrhage — what you leave on the ground behind you.
    wake = Canvas(22)
    pool(wake, 10.5, WINE_SHADOW, DRIED_BLOOD, FRESH_BLOOD)
    art['weapons/wake.png'] = wake
    hemorrhage = Canvas(30)
    pool(hemorrhage, 14.5, DRIED_BLOOD, FRESH_BLOOD, COLD_HIGHLIGHT)
    art['weapons/hemorrhage.png'] = hemorrhage

    # Ironfall / Ruinbell — the expanding rings. Drawn thick, because the
    # collider grows from a fraction of this radius to several times it.
    art['fx/ironfall.png'] = ring(64, 7, ASH_VIOLET, MOONLIT_STEEL, COLD_HIGHLIGHT, DUSK_VIOLET)
    art['fx/ruinbell.png'] = ring(96, 11, DEEP_GOLD, TARNISHED_GOLD, BONE, DRIED_BLOOD)

    # Moonshear / Eclipse — the spiralling blades.
    art['weapons/moonshear.png'] = crescent(11, COLD_HIGHLIGHT, MOONLIT_STEEL, ASH_VIOLET, None)
    art['weapons/eclipse.png'] = crescent(15, BONE, TARNISHED_GOLD, DEEP_GOLD, COLD_HIGHLIGHT)

    return art


def assert_on_palette(art: dict[str, Canvas], palette: list[tuple[int, int, int]]) -> None:
    allowed = set(palette)
    for name, canvas in art.items():
        for idx in range(canvas.size * canvas.size):
            o = idx * 4
            if canvas.px[o + 3] == 0:
                continue
            key = (canvas.px[o], canvas.px[o + 1], canvas.px[o + 2])
            if key not in allowed:
                raise SystemExit(f'{name}: #{key[0]:02x}{key[1]:02x}{key[2]:02x} is not in the palette')


def preview(art: dict[str, Canvas], path: Path, zoom: int = 6) -> None:
    """One contact sheet of every sprite, upscaled, for eyeballing a change."""
    pad = 4
    width = sum(c.size for c in art.values()) * zoom + pad * (len(art) + 1)
    height = max(c.size for c in art.values()) * zoom + pad * 2
    sheet = bytearray(width * height * 4)
    x0 = pad
    for canvas in art.values():
        for y in range(canvas.size * zoom):
            for x in range(canvas.size * zoom):
                r, g, b, a = canvas.at(x // zoom, y // zoom)
                if a == 0:
                    r, g, b, a = 20, 16, 28, 255
                o = ((y + pad) * width + x0 + x) * 4
                sheet[o:o + 4] = bytes((r, g, b, a))
        x0 += canvas.size * zoom + pad
    write_png(path, width, height, sheet)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if the committed PNGs differ')
    parser.add_argument('--preview', type=Path, help='write an upscaled contact sheet here')
    args = parser.parse_args()

    art = build()
    assert_on_palette(art, load_palette())

    if args.preview:
        preview(art, args.preview)
        print(f'preview -> {args.preview}')

    failed = False
    for name, canvas in art.items():
        target = ASSETS / name
        if args.check:
            if not target.exists():
                print(f'MISSING  {name}')
                failed = True
                continue
            expected = target.read_bytes()
            scratch = target.with_suffix('.check')
            write_png(scratch, canvas.size, canvas.size, canvas.px)
            same = scratch.read_bytes() == expected
            scratch.unlink()
            print(f'{"ok      " if same else "STALE   "} {name}')
            failed = failed or not same
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            write_png(target, canvas.size, canvas.size, canvas.px)
            print(f'wrote {name} ({canvas.size}x{canvas.size})')

    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
