#!/usr/bin/env python3
"""Shrink ship textures and turn colour maps into grey "detail" maps the team paint shows through.

    python3 apps/web/scripts/shrink-textures.py            # rewrites apps/web/src/assets in place

- *_base / *base.jpg          -> greyscale detail map, levels stretched so the paint stays bright
- *_emissive / emissive.jpg   -> greyscale glow mask (the team light colour tints it)
- normal maps                 -> kept in colour (they encode direction), downscaled
- rough / metal / ao          -> greyscale, downscaled
The spaceship's separate red/blue skins collapse into one detail + one glow map.
Idempotent: running it again leaves already-shrunk files alone.
"""
import os
import sys
from PIL import Image, ImageOps

ROOT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
SIZES = {'normal': 512, 'base': 512, 'emissive': 256, 'rough': 256, 'metal': 128, 'ao': 256, 'metallic': 256, 'roughness': 256}


def kind(name):
    n = name.lower()
    for k in ('normal', 'emissive', 'base', 'roughness', 'rough', 'metallic', 'metal', 'ao'):
        if k in n:
            return k
    return None


def detail_map(im):
    """Greyscale with levels stretched: 2nd..98th percentile -> 0.25..1.0, so paint never goes muddy."""
    g = ImageOps.grayscale(im)
    hist = g.histogram()
    total = sum(hist)
    lo = hi = 0
    acc = 0
    for i, c in enumerate(hist):
        acc += c
        if acc >= total * 0.02 and lo == 0:
            lo = i
        if acc >= total * 0.98:
            hi = i
            break
    hi = max(hi, lo + 1)
    return g.point(lambda v: int(64 + 191 * min(1, max(0, (v - lo) / (hi - lo)))))


def save(im, path, size, quality):
    if max(im.size) > size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(path, 'JPEG', quality=quality, optimize=True, progressive=True)


def main():
    before = after = 0
    sp = os.path.join(ROOT, 'spaceship')
    # One skin for the fighter: the blue set becomes the shared detail/glow maps.
    for old, new in (('blue_base.jpg', 'base.jpg'), ('blue_emissive.jpg', 'emissive.jpg')):
        if os.path.exists(os.path.join(sp, old)):
            os.replace(os.path.join(sp, old), os.path.join(sp, new))
    for gone in ('red_base.jpg', 'red_emissive.jpg'):
        p = os.path.join(sp, gone)
        if os.path.exists(p):
            before += os.path.getsize(p)
            os.remove(p)

    for dirpath, _, files in os.walk(ROOT):
        for f in sorted(files):
            if not f.lower().endswith('.jpg'):
                continue
            p = os.path.join(dirpath, f)
            k = kind(f)
            if k is None:
                continue
            size0 = os.path.getsize(p)
            before += size0
            im = Image.open(p)
            if max(im.size) <= SIZES[k] and im.info.get('progressive'):
                after += size0  # already done
                continue
            if k == 'base':
                save(detail_map(im.convert('RGB')), p, SIZES[k], 78)
            elif k == 'emissive':
                save(ImageOps.grayscale(im), p, SIZES[k], 80)
            elif k == 'normal':
                save(im.convert('RGB'), p, SIZES[k], 85)
            else:
                save(ImageOps.grayscale(im), p, SIZES[k], 78)
            after += os.path.getsize(p)
            print(f'{os.path.relpath(p, ROOT):32s} {size0 // 1024:5d} KB -> {os.path.getsize(p) // 1024:4d} KB')
    print(f'textures: {before // 1024} KB -> {after // 1024} KB')


if __name__ == '__main__':
    sys.exit(main())
