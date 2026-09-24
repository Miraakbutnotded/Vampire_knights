#!/usr/bin/env python3
"""Shrinks the textures inside a .glb so a model sized for the 480x270 view does
not ship megabytes of texels it can never show.

Generated models arrive with 2048px textures. A tower drawn 46 pixels tall on a
480x270 buffer samples a handful of them; the rest is download size and GPU
memory on a phone. This resamples every embedded image down to `--max` pixels on
its long side, re-encodes it as PNG, and repacks the binary chunk. Geometry,
materials and everything else in the file are left exactly as they were.

    node scripts/python.mjs scripts/shrink-glb.py raw.glb public/assets/models/tower.glb --max 256

The one art script that is not stdlib-only: generated textures are JPEG, and
decoding JPEG is not something to hand-roll. It needs Pillow (`pip install pillow`).
"""

from __future__ import annotations

import argparse
import io
import json
import struct
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment check
    sys.exit('shrink-glb needs Pillow: pip install pillow')

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def pad4(buf: bytearray, fill: int) -> None:
    while len(buf) % 4:
        buf.append(fill)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('src', help='input .glb')
    parser.add_argument('dst', help='output .glb')
    parser.add_argument('--max', type=int, default=256, help='longest texture side, in pixels (default 256)')
    args = parser.parse_args()

    data = open(args.src, 'rb').read()
    magic, _version, _length = struct.unpack('<4sII', data[:12])
    if magic != b'glTF':
        sys.exit(f'{args.src} is not a binary glTF file')
    json_len, json_type = struct.unpack('<II', data[12:20])
    if json_type != JSON_CHUNK:
        sys.exit(f'{args.src}: first chunk is not JSON')
    gltf = json.loads(data[20:20 + json_len])
    bin_at = 20 + json_len
    bin_len, _ = struct.unpack('<II', data[bin_at:bin_at + 8])
    blob = data[bin_at + 8:bin_at + 8 + bin_len]

    views = [blob[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in gltf['bufferViews']]
    for image in gltf.get('images', []):
        if 'bufferView' not in image:
            continue  # an external URI; nothing embedded to shrink
        index = image['bufferView']
        picture = Image.open(io.BytesIO(views[index]))
        before = picture.size
        picture.thumbnail((args.max, args.max), Image.LANCZOS)
        out = io.BytesIO()
        picture.convert('RGBA' if picture.mode in ('RGBA', 'LA', 'P') else 'RGB').save(out, 'PNG', optimize=True)
        print(f'texture {before[0]}x{before[1]} -> {picture.size[0]}x{picture.size[1]}, '
              f'{len(views[index])} -> {len(out.getvalue())} bytes')
        views[index] = out.getvalue()
        image['mimeType'] = 'image/png'

    packed = bytearray()
    for view, raw in zip(gltf['bufferViews'], views):
        pad4(packed, 0)
        view['byteOffset'] = len(packed)
        view['byteLength'] = len(raw)
        view['buffer'] = 0
        packed += raw
    pad4(packed, 0)
    gltf['buffers'] = [{'byteLength': len(packed)}]

    header = bytearray(json.dumps(gltf, separators=(',', ':')).encode())
    pad4(header, 0x20)
    total = 12 + 8 + len(header) + 8 + len(packed)
    with open(args.dst, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<II', len(header), JSON_CHUNK))
        f.write(header)
        f.write(struct.pack('<II', len(packed), BIN_CHUNK))
        f.write(packed)
    print(f'wrote {args.dst}: {len(data)} -> {total} bytes')


if __name__ == '__main__':
    main()
