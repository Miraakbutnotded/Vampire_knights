#!/usr/bin/env python3
"""Check every sprite strip declared in sprites.json against the art contract.

Three things can go wrong between a PNG landing in `public/assets/` and the game
drawing it, and not one of them raises. A mistyped `src` falls back to a
generated placeholder, so the game still runs and the typo hides. A strip whose
width is not a whole multiple of its frame width gets its last frame silently
half-cut. And art that never went through spritify.py carries colours the
canonical palette does not contain — which is how a set drifts off-style one
sprite at a time, each addition defensible on its own.

    python3 scripts/validate-art.py [--worst 3] [--quiet]
    npm run validate:art

Exits non-zero the moment anything fails, so it can gate a commit.

Palette, PNG codec and frame inference are borrowed from where the rest of the
project already keeps them — docs/art/palette.md via spritify.py, and the rules
in src/render/sprites.ts — because a validator holding a second opinion about
any of the three is worse than no validator at all.

Stdlib only, so it runs anywhere the repo does.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from spritify import load_palette, read_png

ROOT = Path(__file__).resolve().parent.parent
SPRITES_FILE = ROOT / 'src' / 'content' / 'sprites.json'
ASSETS_DIR = ROOT / 'public' / 'assets'


def frame_geometry(anim: dict, width: int, height: int) -> tuple[int, int, int]:
    """Infer frame size and count exactly as the loader does.

    src/render/sprites.ts: frame height defaults to the image height, frame width
    defaults to the frame height (square is the common case), and the frame count
    is the strip width divided down. The loader clamps that count to at least 1
    and would then sample past the right edge — here it stays unclamped so the
    degenerate case is visible instead of merely survivable.
    """
    frame_h = anim.get('frameH') or height
    frame_w = anim.get('frameW') or frame_h
    return frame_w, frame_h, width // frame_w if frame_w > 0 else 0


def off_palette(rgba: bytearray, palette: list[tuple[int, int, int]]) -> list[tuple[tuple[int, int, int], int]]:
    """Tally the opaque colours the palette does not contain, worst first.

    A pixel counts as opaque the moment its alpha is non-zero: spritify writes
    only 0 or 255, so a half-transparent edge is itself a sign the art skipped
    the pipeline.
    """
    allowed = set(palette)
    strays: dict[tuple[int, int, int], int] = {}
    for idx in range(len(rgba) // 4):
        o = idx * 4
        if rgba[o + 3] == 0:
            continue
        key = (rgba[o], rgba[o + 1], rgba[o + 2])
        if key not in allowed:
            strays[key] = strays.get(key, 0) + 1
    return sorted(strays.items(), key=lambda kv: -kv[1])


def describe_strays(strays: list[tuple[tuple[int, int, int], int]], worst: int) -> str:
    total = sum(count for _, count in strays)
    named = ', '.join(f'#{r:02x}{g:02x}{b:02x} x{count}' for (r, g, b), count in strays[:worst])
    return f'{len(strays)} off-palette {"colour" if len(strays) == 1 else "colours"} over {total} px ({named})'


def check_strip(src: str, anim: dict, palette: list[tuple[int, int, int]], cache: dict, worst: int) -> tuple[str, list[str]]:
    """Validate one animation strip. Returns its report line and its failure kinds."""
    path = ASSETS_DIR / src
    if not path.is_file():
        return 'missing PNG — the loader is drawing a placeholder here', ['missing']

    entry = cache.get(src)
    if entry is None:
        try:
            entry = read_png(path)
        except SystemExit as exc:
            return f'unreadable — {exc}', ['unreadable']
        cache[src] = entry
    width, height, rgba = entry

    frame_w, frame_h, frames = frame_geometry(anim, width, height)
    if frame_w <= 0 or frame_h <= 0:
        return f'{width}x{height}, declared frame {frame_w}x{frame_h} has no area', ['geometry']

    plural = 'frame' if frames == 1 else 'frames'
    facts, kinds = [f'{width}x{height}', f'{frames} {plural} of {frame_w}x{frame_h}'], []
    if frames < 1:
        facts.append(f'no whole {frame_w}px frame fits')
        kinds.append('no-frame')
    elif width % frame_w:
        facts.append(f'width is not a multiple of {frame_w}px — last frame is cut at {width % frame_w}px')
        kinds.append('frame-split')

    strays = off_palette(rgba, palette)
    if strays:
        facts.append(describe_strays(strays, worst))
        kinds.append('off-palette')
    else:
        used = len({tuple(rgba[i * 4:i * 4 + 3]) for i in range(width * height) if rgba[i * 4 + 3]})
        facts.append(f'{used} palette {"entry" if used == 1 else "entries"}')
    return ', '.join(facts), kinds


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--worst', type=int, default=3, help='how many off-palette colours to name per strip')
    ap.add_argument('--quiet', action='store_true', help='print only the failures and the summary')
    args = ap.parse_args()

    palette = load_palette()
    sprites = json.loads(SPRITES_FILE.read_text())
    cache: dict[str, tuple[int, int, bytearray]] = {}
    checked, failed, tally = 0, 0, {}

    for name, sprite in sprites.items():
        for anim_name, anim in (sprite.get('anims') or {}).items():
            src = anim.get('src')
            if not src:
                continue
            checked += 1
            report, kinds = check_strip(src, anim, palette, cache, args.worst)
            if kinds:
                failed += 1
                for kind in kinds:
                    tally[kind] = tally.get(kind, 0) + 1
                print(f'FAIL {src} [{name}.{anim_name}]: {report}')
            elif not args.quiet:
                print(f'ok   {src}: {report}')

    counts = ', '.join(f'{count} {kind}' for kind, count in sorted(tally.items()))
    print(f'\n{checked} strips checked, {checked - failed} clean, {failed} failing' + (f' ({counts})' if counts else ''))
    if failed:
        print(f'palette: {len(palette)} colours in docs/art/palette.md — run art through scripts/spritify.py to conform')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
