#!/usr/bin/env python3
"""Check Android foreground content stays inside the circular launcher safe zone."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
for name in ('adaptive-icon.png', 'monochrome-icon.png', 'notification-icon.png'):
    path = ROOT / 'apps/mobile/assets' / name
    image = Image.open(path).convert('RGBA')
    alpha = image.getchannel('A')
    center_x, center_y = image.width / 2, image.height / 2
    max_distance_squared = max(
        ((x + .5 - center_x) ** 2 + (y + .5 - center_y) ** 2
         for y in range(image.height) for x in range(image.width)
         if alpha.getpixel((x, y)) > 16),
        default=None,
    )
    assert max_distance_squared is not None, name
    radius = .30 * min(image.size)
    assert max_distance_squared <= radius ** 2, (
        f'{name}: furthest opaque pixel is {max_distance_squared ** .5:.2f} '
        f'pixels from center; limit is {radius:.2f}'
    )
print('Android icon opaque pixels are inside the circular safe zone')
