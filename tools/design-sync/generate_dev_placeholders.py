"""Generate the deterministic placeholder card images used by dev screen routes.

Usage:
    uv run --with pillow python tools/design-sync/generate_dev_placeholders.py

Outputs apps/spotlight-rn/assets/dev/card-placeholder-{1..5}.png at the real
card aspect ratio (63:88). Flat colors + baked-in label text, no randomness, so
simulator screenshots taken through the dev routes are pixel-reproducible.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parents[2] / "apps" / "spotlight-rn" / "assets" / "dev"

# 63x88mm card at 10px/mm.
WIDTH, HEIGHT = 630, 880
BORDER = 24
CORNER_RADIUS = 36

# Fills chosen from the design-system purple/gray families so placeholders look
# intentional in screenshots without pretending to be real card art.
VARIANTS = [
    ("card-placeholder-1", "#D9AEFF", "#2D2D2D"),
    ("card-placeholder-2", "#7000FF", "#FFFFFF"),
    ("card-placeholder-3", "#4A4A4A", "#FFFFFF"),
    ("card-placeholder-4", "#EFE3FF", "#2D2D2D"),
    ("card-placeholder-5", "#9B9B9B", "#FFFFFF"),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, fill, ink in VARIANTS:
        image = Image.new("RGB", (WIDTH, HEIGHT), "#FFFFFF")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(
            (BORDER, BORDER, WIDTH - BORDER, HEIGHT - BORDER),
            radius=CORNER_RADIUS,
            fill=fill,
            outline=ink,
            width=6,
        )
        # Simple centered glyph: an inner frame + the variant number. PIL's
        # default bitmap font is tiny at this scale, so draw shapes instead of
        # relying on system fonts (which vary by machine).
        inner = (WIDTH * 0.22, HEIGHT * 0.3, WIDTH * 0.78, HEIGHT * 0.7)
        draw.rectangle(inner, outline=ink, width=6)
        index = name.rsplit("-", 1)[1]
        tick_count = int(index)
        tick_width = 36
        gap = 24
        total = tick_count * tick_width + (tick_count - 1) * gap
        start_x = (WIDTH - total) / 2
        for tick in range(tick_count):
            x0 = start_x + tick * (tick_width + gap)
            draw.rectangle((x0, HEIGHT * 0.44, x0 + tick_width, HEIGHT * 0.56), fill=ink)
        image.save(OUT_DIR / f"{name}.png")
        print(f"wrote {OUT_DIR / f'{name}.png'}")


if __name__ == "__main__":
    main()
