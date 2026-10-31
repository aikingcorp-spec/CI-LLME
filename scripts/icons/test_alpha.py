#!/usr/bin/env python3
"""The desktop mascot has one solid interior and no detached tile fragments."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
image = Image.open(ROOT / 'apps/desktop/assets/icon.png').convert('RGBA')
alpha = image.getchannel('A')
visible = alpha.point(lambda value: 255 if value > 0 else 0)
interior = visible.filter(ImageFilter.MinFilter(11))
assert all(a == 255 for a, inside in zip(alpha.getdata(), interior.getdata()) if inside), 'transparent pixel inside mascot'
opaque = alpha.point(lambda value: 255 if value > 16 else 0)
main = opaque.copy()
ImageDraw.floodfill(main, (image.width // 2, image.height // 2), 128, thresh=0)
assert not any(value == 255 for value in main.getdata()), 'detached opaque component'
print('Desktop icon has an opaque interior and one artwork component')
