#!/usr/bin/env python3
"""Build team-accent masks: where a ship shows its team colour; everything else is silver.

    python3 apps/web/scripts/make-accent-masks.py [git-rev]   # default rev c2a3707 (last with the colour maps)

The colour maps were turned into greyscale detail maps (shrink-textures.py), so the masks come from the
original colour textures in git history:
- Kestrel: it shipped a blue and a red skin of the same paint job; where they differ IS the team paint.
- Anvil (m001, m004): its accents are the saturated (orange) trim.
- Anvil m002 is the hull's main paint (about 73% orange), so it stays silver: no mask.
- The Wayfarer's texture paints most of its hull, so it gets region accents in shipAsset.ts instead.
Writes small greyscale JPEGs next to the detail maps: white = team colour, black = silver.
"""
import io
import os
import subprocess
import sys
from PIL import Image, ImageChops, ImageFilter

REV = sys.argv[1] if len(sys.argv) > 1 else 'c2a3707'
ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
SIZE = 256


def original(path):
    data = subprocess.run(['git', 'show', f'{REV}:apps/web/src/assets/{path}'], check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(data)).convert('RGB')


def finish(mask, out):
    mask = mask.resize((SIZE, SIZE), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    mask.save(os.path.join(ASSETS, out), 'JPEG', quality=85, optimize=True)
    share = sum(1 for v in mask.getdata() if v > 127) / (SIZE * SIZE)
    print(f'{out:28s} {share * 100:4.0f}% team colour, {os.path.getsize(os.path.join(ASSETS, out)) // 1024} KB')


def skin_difference(a, b):
    """Pixels whose colour differs between two skins of the same paint job."""
    d = ImageChops.difference(a, b).convert('L')
    return d.point(lambda v: 255 if v > 60 else int(v * 255 / 60) if v > 25 else 0)


def saturated(im):
    """Saturated, not-too-dark pixels (painted accents) -> white."""
    h, s, v = im.convert('HSV').split()
    s = s.point(lambda x: 255 if x > 140 else 0 if x < 90 else int((x - 90) * 255 / 50))
    v = v.point(lambda x: 255 if x > 80 else 0)
    return ImageChops.multiply(s, v)


def main():
    finish(skin_difference(original('spaceship/blue_base.jpg'), original('spaceship/red_base.jpg')), 'spaceship/accent.jpg')
    for m in ('m001', 'm004'):
        finish(saturated(original(f'bomber/{m}_base.jpg')), f'bomber/{m}_accent.jpg')


if __name__ == '__main__':
    main()
