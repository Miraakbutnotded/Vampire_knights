#!/usr/bin/env python3
"""Derive a looping walk strip from a single finished sprite frame.

Generating each frame of a cycle independently does not work: the model redraws
the character every time, so the frames jitter and stop reading as one creature.
The frames have to come from the frame that already shipped. Everything here is
therefore a *copy* of source pixels to whole-pixel offsets — no interpolation,
no blending, no new colours — so the output is palette-clean by construction and
frame 0 is byte-identical to the source (idle and walk agree on the pose).

The walk is built from four cues, in order of how much they carry the read:

  scissor  the leg band is split at the gap between the legs and the two sides
           slide in opposite directions — an actual stride, not a lean
  lift     the leg swinging forward also rises, so one foot leaves the ground
  crouch   the torso drops into the legs at full stride, shortening them; this
           is the weight settling, and it never clips because the feet do not move
  sway     the torso leans against the legs for counterbalance

All four are driven by one phase, sin(2*pi*p), and all four are zero at p=0.

Blobs, floaters and fliers are the same engine with different layers: `float`
sways a robe hem or flame tail under a bobbing body, `flap` shears columns
vertically by their distance from the spine so wings beat, `blob` resamples the
body height (nearest-neighbour, anchored at the feet) for squash and stretch.

    python3 scripts/animate.py in.png out.png --frames 6 --stride 2
    python3 scripts/animate.py bat.png bat_walk.png --mode flap --preview big.png

Amplitudes are clamped per layer against that layer's own margin to the frame
edge, so a request that would slice pixels off the art is reduced and reported
rather than silently cropping. Stdlib only, like the rest of scripts/.

The shipped enemy strips came from exactly these calls. Frame count is paired to
the stride: sampling a sine at 4x the amplitude hits every whole-pixel step once,
so 1px cycles want 4 frames and 2px cycles want 8. More frames than that just
duplicates poses.

    swarmling --mode walk  --frames 4 --hip 0.81  --stride 1 --lift 1 --crouch 1
    bat       --mode flap  --frames 4 --flap 2 --bob 1
    slime     --mode blob  --frames 4 --hip 0.72  --squash 1 --hem 1
    zombie    --mode walk  --frames 8 --hip 0.84  --stride 2 --lift 1 --crouch 1 --sway 1
    skeleton  --mode walk  --frames 8 --hip 0.81  --stride 2 --lift 1 --crouch 1
    ghost     --mode float --frames 8 --hip 0.75  --bob 2 --hem 1 --crouch 0
    wisp      --mode float --frames 4 --hip 0.70  --bob 0 --hem 1 --crouch 1
    brute     --mode walk  --frames 4 --hip 0.81  --split 17 --stride 1 --lift 1 --crouch 1 --sway 1
    warden    --mode walk  --frames 4 --hip 0.875 --stride 1 --lift 1 --crouch 1
    reaper    --mode float --frames 8 --hip 0.78  --bob 0 --hem 2 --crouch 1

The brute needs --split because its silhouette narrows to one trunk at the floor,
so the automatic gap search finds the arm rather than the far leg.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from spritify import load_palette, read_png, write_png  # noqa: E402

MODES = ('walk', 'float', 'flap', 'blob')


def snap(v: float) -> int:
    """Round half away from zero, so a swing actually reaches its intermediate steps.

    Python's round() is banker's rounding, which quietly eats every other step of
    a small-amplitude cycle. Everything downstream is an array index, so this has
    to be decided here rather than left to chance.
    """
    return int(math.floor(v + 0.5)) if v >= 0 else -int(math.floor(-v + 0.5))


# --- silhouette measurement ------------------------------------------------

def opaque_rows(size: int, rgba: bytearray) -> list[list[int]]:
    """Per row, the x of every opaque pixel. Everything else is measured off this."""
    return [[x for x in range(size) if rgba[(y * size + x) * 4 + 3]] for y in range(size)]


def content_box(size: int, rgba: bytearray) -> tuple[int, int, int, int]:
    rows = opaque_rows(size, rgba)
    ys = [y for y, xs in enumerate(rows) if xs]
    if not ys:
        raise SystemExit('source frame is empty')
    xs = [x for row in rows for x in row]
    return min(xs), ys[0], max(xs), ys[-1]


def band_margins(size: int, rgba: bytearray, pixels: list[int]) -> tuple[int, int, int, int]:
    """Free pixels left/right/up/down before this layer's own content leaves the frame."""
    if not pixels:
        return size, size, size, size
    xs = [i % size for i in pixels]
    ys = [i // size for i in pixels]
    return min(xs), size - 1 - max(xs), min(ys), size - 1 - max(ys)


def leg_split(size: int, rgba: bytearray, hip: int) -> int:
    """Column to cut the leg band on: the emptiest column nearest its centre.

    Measured over the lower half of the band only. Higher up, the hem and the
    hands are still in the way and the emptiest column is somewhere out by an
    elbow; down at the feet the gap between the legs is unambiguous.
    """
    rows = [y for y in range(hip, size) if any(rgba[(y * size + x) * 4 + 3] for x in range(size))]
    feet = rows[len(rows) // 2:] if len(rows) > 1 else rows
    counts = [sum(1 for y in feet if rgba[(y * size + x) * 4 + 3]) for x in range(size)]
    present = [x for x, c in enumerate(counts) if c]
    if not present:
        return size // 2
    centre = (present[0] + present[-1] + 1) // 2
    span = range(present[0] + 1, present[-1] + 1) or [centre]
    return min(span, key=lambda x: (counts[x], abs(x - centre)))


# --- layer compositing -----------------------------------------------------

def select(size: int, rgba: bytearray, keep) -> list[int]:
    return [y * size + x
            for y in range(size) for x in range(size)
            if rgba[(y * size + x) * 4 + 3] and keep(x, y)]


def clamp_offset(size: int, rgba: bytearray, pixels: list[int], dx: int, dy: int,
                 clamped: list[str], label: str) -> tuple[int, int]:
    left, right, up, down = band_margins(size, rgba, pixels)
    cx = max(-left, min(right, dx))
    cy = max(-up, min(down, dy))
    if (cx, cy) != (dx, dy):
        clamped.append(f'{label} ({dx},{dy})->({cx},{cy})')
    return cx, cy


def compose(size: int, rgba: bytearray, layers: list[tuple[list[int], int, int]]) -> bytearray:
    """Paint layers back-to-front at integer offsets. Pure copies, so no colour drifts."""
    out = bytearray(size * size * 4)
    for pixels, dx, dy in layers:
        for i in pixels:
            x, y = i % size + dx, i // size + dy
            if 0 <= x < size and 0 <= y < size:
                o, t = i * 4, (y * size + x) * 4
                out[t:t + 4] = rgba[o:o + 4]
    return out


def resample_height(size: int, rgba: bytearray, box: tuple[int, int, int, int],
                    target: int) -> bytearray:
    """Nearest-neighbour vertical rescale of the content, anchored at its bottom row.

    Whole-pixel row picking only — a row is kept, dropped or doubled, never mixed,
    so squash and stretch cost nothing in palette purity.
    """
    _, y0, _, y1 = box
    src_h = y1 - y0 + 1
    if target == src_h:
        return bytearray(rgba)
    out = bytearray(size * size * 4)
    for n in range(target):
        dst_y = y1 - (target - 1 - n)
        src_y = y0 + min(src_h - 1, (n * src_h) // target)
        if 0 <= dst_y < size:
            d, s = dst_y * size * 4, src_y * size * 4
            out[d:d + size * 4] = rgba[s:s + size * 4]
    return out


# --- the cycle ------------------------------------------------------------

def build_frame(size: int, rgba: bytearray, phase: float, args, clamped: list[str]) -> bytearray:
    swing = math.sin(2 * math.pi * phase)
    # Truncated sin^2: the weight drops only at the contact frames, where the legs
    # are at full stride. Rounding it instead would leave the body squatting for
    # most of the cycle, which reads as a limp rather than a step.
    settle = swing * swing
    box = content_box(size, rgba)
    x0, y0, x1, y1 = box
    height = y1 - y0 + 1
    hip = min(size - 1, y0 + max(1, round(height * args.hip)))
    src = rgba

    if args.mode == 'blob':
        src = resample_height(size, rgba, box, height + snap(args.squash * swing))
        box = content_box(size, src)

    if args.mode == 'flap':
        xs = [x for x in range(size) if any(src[(y * size + x) * 4 + 3] for y in range(size))]
        centre = (xs[0] + xs[-1] + 1) // 2
        reach = max(1, max(centre - xs[0], xs[-1] - centre))
        body = snap(-args.bob * swing)
        layers = []
        for x in xs:
            span = abs(x - centre)
            dy = body + snap(args.flap * swing * (span / reach))
            column = select(size, src, lambda px, py, c=x: px == c)
            layers.append((column, 0, clamp_offset(size, src, column, 0, dy, clamped, f'wing x{x}')[1]))
        return compose(size, src, layers)

    lower = select(size, src, lambda x, y: y >= hip)
    upper = select(size, src, lambda x, y: y < hip)

    if args.mode == 'walk':
        stride = snap(args.stride * swing)
        split = args.split if args.split is not None else leg_split(size, src, hip)
        left = select(size, src, lambda x, y: y >= hip and x < split)
        right = select(size, src, lambda x, y: y >= hip and x >= split)
        lift_l = snap(args.lift * max(0.0, swing))
        lift_r = snap(args.lift * max(0.0, -swing))
        torso = (snap(-args.sway * swing), int(args.crouch * settle))
        return compose(size, src, [
            (left, *clamp_offset(size, src, left, stride, -lift_l, clamped, 'leg L')),
            (right, *clamp_offset(size, src, right, -stride, -lift_r, clamped, 'leg R')),
            (upper, *clamp_offset(size, src, upper, torso[0], torso[1], clamped, 'torso')),
        ])

    # float / blob: a hem or tail trailing under a body that drifts and settles.
    # The bob has to carry both layers — moving the body alone opens a hole at the
    # hip the moment it travels further than the two layers overlap. Only the sway
    # is differential, and the crouch only ever pushes the body down into the hem,
    # which overlaps rather than parts.
    bob = snap(args.bob * swing)
    hem = snap(args.hem * swing)
    drift = (snap(args.sway * swing), bob + int(args.crouch * settle))
    return compose(size, src, [
        (lower, *clamp_offset(size, src, lower, hem, bob, clamped, 'hem')),
        (upper, *clamp_offset(size, src, upper, drift[0], drift[1], clamped, 'body')),
    ])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('dest')
    ap.add_argument('--mode', choices=MODES, default='walk')
    ap.add_argument('--frames', type=int, default=4)
    ap.add_argument('--hip', type=float, default=0.78,
                    help='where the legs start, as a fraction of content height')
    ap.add_argument('--stride', type=float, default=2, help='walk: leg scissor, px')
    ap.add_argument('--split', type=int, default=None,
                    help='walk: column to part the legs on, when the gap is not obvious')
    ap.add_argument('--lift', type=float, default=1, help='walk: how far the swinging foot rises')
    ap.add_argument('--crouch', type=float, default=1, help='torso settle at full stride, px')
    ap.add_argument('--sway', type=float, default=0, help='torso counter-lean, px')
    ap.add_argument('--hem', type=float, default=1, help='float: robe/tail sway, px')
    ap.add_argument('--bob', type=float, default=0, help='float/flap: body rise and fall, px')
    ap.add_argument('--flap', type=float, default=2, help='flap: wingtip travel, px')
    ap.add_argument('--squash', type=float, default=1, help='blob: height change, px')
    ap.add_argument('--preview', help='also write a nearest-neighbour blow-up of the strip')
    ap.add_argument('--preview-scale', type=int, default=6)
    args = ap.parse_args()

    if args.frames < 2:
        raise SystemExit('--frames must be at least 2')
    size, height, rgba = read_png(Path(args.source))
    if size != height:
        raise SystemExit(f'{args.source}: expected a square single frame, got {size}x{height}')

    palette = {tuple(c) for c in load_palette()}
    clamped: list[str] = []
    frames = [build_frame(size, rgba, i / args.frames, args, clamped) for i in range(args.frames)]

    strip = bytearray(size * args.frames * size * 4)
    row = size * args.frames * 4
    for n, frame in enumerate(frames):
        for y in range(size):
            d = y * row + n * size * 4
            strip[d:d + size * 4] = frame[y * size * 4:(y + 1) * size * 4]
    write_png(Path(args.dest), size * args.frames, size, strip)

    solid = [sum(1 for i in range(size * size) if f[i * 4 + 3]) for f in frames]
    stray = {tuple(f[i * 4:i * 4 + 3])
             for f in frames for i in range(size * size) if f[i * 4 + 3]} - palette
    base = solid[0]
    print(f'{args.dest}: {size * args.frames}x{size}, {args.frames} frames ({args.mode}), '
          f'solid px {min(solid)}-{max(solid)} (source {base})')
    # Compare visible pixels only: transparent source pixels may carry stale RGB
    # that compose() never copies, and that difference is not a pose difference.
    if any(frames[0][i * 4 + 3] != rgba[i * 4 + 3]
           or (rgba[i * 4 + 3] and frames[0][i * 4:i * 4 + 3] != rgba[i * 4:i * 4 + 3])
           for i in range(size * size)):
        print('  WARNING: frame 0 differs from the source frame')
    if stray:
        print(f'  WARNING: {len(stray)} off-palette colours: {sorted(stray)[:4]}')
    if any(s == 0 for s in solid):
        print('  WARNING: blank frame in the strip')
    if clamped:
        print(f'  clamped to stay inside the frame: {"; ".join(sorted(set(clamped))[:6])}')

    if args.preview:
        w, h = size * args.frames * args.preview_scale, size * args.preview_scale
        blown = bytearray(w * h * 4)
        for y in range(h):
            for x in range(w):
                s = ((y // args.preview_scale) * size * args.frames + x // args.preview_scale) * 4
                blown[(y * w + x) * 4:(y * w + x) * 4 + 4] = strip[s:s + 4]
        write_png(Path(args.preview), w, h, blown)
        print(f'  {args.preview}: {w}x{h} preview')
    return 0


if __name__ == '__main__':
    sys.exit(main())
