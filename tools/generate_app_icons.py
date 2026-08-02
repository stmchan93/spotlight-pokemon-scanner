"""Regenerate the Ekalight app-icon PNGs from a single master logo file.

The master art is a black mark on a white (or transparent) square. Every icon we
ship is the same mark re-cropped to its ink bounding box, centered, and scaled to
a per-target fill ratio — so the mark's size on the tile is a number in one place
instead of whatever padding the exported file happened to carry.

Run it with uv (Pillow is not a repo dependency):

    uv run --with pillow python tools/generate_app_icons.py \
        "$HOME/Downloads/App store Blk Logo Wht Bg.png"

Fill ratios:
  iOS / Expo tile  0.78 — picked from measurements, not taste. Twenty App Store
                          icons were sampled (see the sweep in the 2026-08-01
                          session): mark-on-background icons put the mark at
                          58-84% of the tile, median 71%, Coinbase 70%. Apple's
                          own icon grid centers its primary circle at ~80%.
                          Our mark is a hollow crescent, so at an equal bounding
                          box it reads lighter than a solid mark like Coinbase's
                          C — 0.78 puts our INK area at 26%, between Notion (26%)
                          and Coinbase (28%), while staying under the grid's 80%
                          circle. 0.62 read as too small and 0.94 as too big.
  Android foreground 0.58 — Android crops the adaptive foreground to a ~66% mask
                          and may round it to a circle, so the mark has to stay
                          inside the safe zone. 0.58 is the same *visual* fill as
                          the iOS tile, measured against the visible area.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS = REPO_ROOT / 'apps' / 'spotlight-rn' / 'assets'

# Icon Composer's fill for ekalight.icon is extended-srgb 0.98824/0.98824/0.98039;
# the flat PNGs use the same off-white so the two icon paths match.
TILE_BACKGROUND = (252, 252, 250, 255)

IOS_FILL = 0.78
ANDROID_FILL = 0.58

# (relative path, canvas size, fill ratio, background)
TARGETS = [
    (ASSETS / 'images' / 'icon.png', 1024, IOS_FILL, TILE_BACKGROUND),
    (ASSETS / 'images' / 'ekalight-e-icon.png', 1024, IOS_FILL, TILE_BACKGROUND),
    (ASSETS / 'ekalight.icon' / 'Assets' / 'ekalight-mark.png', 1024, IOS_FILL, None),
    (ASSETS / 'images' / 'android-icon-foreground.png', 1024, ANDROID_FILL, None),
    (ASSETS / 'images' / 'android-icon-monochrome.png', 1024, ANDROID_FILL, None),
]


def load_mark(source: Path) -> Image.Image:
    """The master art as a black RGBA mark on transparency, cropped to its ink.

    A white-background export carries no alpha, so coverage is read from
    darkness (white = empty, black = solid). That keeps the edge antialiasing
    instead of hard-thresholding it into jaggies.
    """
    img = Image.open(source).convert('RGBA')
    alpha = img.getchannel('A')

    if alpha.getextrema()[0] == 255:
        # Fully opaque export: derive coverage from the inverted luminance.
        alpha = Image.eval(img.convert('L'), lambda value: 255 - value)

    mark = Image.new('RGBA', img.size, (0, 0, 0, 0))
    mark.putalpha(alpha)

    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit(f'{source}: no mark found (image is blank)')
    return mark.crop(bbox)


def render(mark: Image.Image, size: int, fill: float, background) -> Image.Image:
    """Center `mark` on a `size` canvas with its longest side at `fill` of it."""
    target = size * fill
    scale = target / max(mark.size)
    scaled = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.LANCZOS,
    )

    canvas = Image.new('RGBA', (size, size), background or (0, 0, 0, 0))
    canvas.alpha_composite(
        scaled,
        ((size - scaled.width) // 2, (size - scaled.height) // 2),
    )
    return canvas.convert('RGB') if background else canvas


def main() -> None:
    source = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else None
    if source is None or not source.is_file():
        raise SystemExit('usage: generate_app_icons.py <master-logo.png>')

    mark = load_mark(source)
    print(f'master {source.name}: ink {mark.width}x{mark.height}')

    for path, size, fill, background in TARGETS:
        render(mark, size, fill, background).save(path)
        print(f'  wrote {path.relative_to(REPO_ROOT)}  {size}px @ {fill:.0%} fill')


if __name__ == '__main__':
    main()
