#!/usr/bin/env python3
"""Generate the Google Play 1024x500 feature graphic from the shipped brand mark.

Play shows this banner at the top of the listing IN THE PLAY STORE APP (the web
listing usually hides it behind screenshots) and in promotional placements. It is
marketing art, NOT a screenshot — Google requires screenshots to be real app
pixels, but imposes no such rule here.

Source is `splash-logo@3x.png`, the same RGBA mark the splash uses, so the
banner can never drift from the app's own identity. The file stacks the roundel
above the wordmark with a fully-transparent gutter between them; this splits on
that gutter rather than hardcoding pixel offsets, so a redrawn logo still works.

SAFE ZONE: Google crops this on some surfaces, so everything sits inside the
middle ~82%. Anything pushed to the edges risks being cut.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
LOGO = REPO / "apps/spotlight-rn/assets/images/splash-logo@3x.png"
FONT = REPO / "backend/assets/fonts/PlusJakartaSans-Bold.ttf"
OUT = REPO / "docs/store-assets"

W, H = 1024, 500
TAGLINE = "Scan, price, and track your collection"

# Brand tokens (packages/design-system/src/tokens.ts)
GRAY900 = (26, 26, 26)
GRAY600 = (113, 113, 113)
WHITE = (255, 255, 255)


def split_logo(img: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Return (roundel, wordmark), split on the transparent gutter between them."""
    alpha = img.split()[3]
    w, h = img.size
    px = alpha.load()
    empty = [y for y in range(h) if all(px[x, y] == 0 for x in range(0, w, 4))]
    runs, start, prev = [], None, None
    for y in empty:
        if start is None:
            start = y
        elif y != prev + 1:
            runs.append((start, prev))
            start = y
        prev = y
    if start is not None:
        runs.append((start, prev))
    gutters = [r for r in runs if r[1] - r[0] > 5 and r[0] > h * 0.3]
    if not gutters:
        raise SystemExit("Could not find the gutter between mark and wordmark.")
    cut = gutters[0]
    mark = img.crop((0, 0, w, cut[0])).crop(img.crop((0, 0, w, cut[0])).split()[3].getbbox())
    word = img.crop((0, cut[1], w, h)).crop(img.crop((0, cut[1], w, h)).split()[3].getbbox())
    return mark, word


def tinted(mark: Image.Image, color: tuple[int, int, int]) -> Image.Image:
    """Recolor a solid-black RGBA mark, preserving its alpha."""
    solid = Image.new("RGBA", mark.size, color + (255,))
    solid.putalpha(mark.split()[3])
    return solid


def fit(img: Image.Image, height: int) -> Image.Image:
    scale = height / img.height
    return img.resize((max(1, round(img.width * scale)), height), Image.LANCZOS)


def build(bg, ink, sub, name: str) -> Path:
    logo = Image.open(LOGO).convert("RGBA")
    mark, word = split_logo(logo)
    mark, word = tinted(mark, ink), tinted(word, ink)

    canvas = Image.new("RGB", (W, H), bg)

    mark_h = 250
    mark = fit(mark, mark_h)
    word = fit(word, 74)

    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(str(FONT), 26)

    # Centre on the WIDEST element, not just the wordmark. Measuring the tagline
    # first is the whole point: it is wider than "ekalight", so centring on the
    # wordmark alone pushed it into the crop zone at the right edge.
    tag_w = draw.textlength(TAGLINE, font=font)
    gap = 44
    text_w = max(word.width, tag_w)
    block_w = mark.width + gap + text_w
    x = int((W - block_w) // 2)

    # Refuse to emit a banner whose content can be cropped away.
    if x < W * 0.06:
        raise SystemExit(f"Layout too wide for the safe zone (x={x}); shorten TAGLINE.")

    canvas.paste(mark, (x, (H - mark.height) // 2), mark)

    tx = int(x + mark.width + gap)
    word_y = H // 2 - word.height - 8
    canvas.paste(word, (tx, word_y), word)
    draw.text((tx + 3, word_y + word.height + 20), TAGLINE, font=font, fill=sub)

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    # No alpha: Play rejects transparency in the feature graphic.
    canvas.save(path, "PNG")
    return path


if __name__ == "__main__":
    light = build(WHITE, GRAY900, GRAY600, "feature-graphic-light-1024x500.png")
    dark = build(GRAY900, WHITE, (170, 170, 170), "feature-graphic-dark-1024x500.png")
    for p in (light, dark):
        im = Image.open(p)
        print(f"{p.relative_to(REPO)}  {im.size}  {im.mode}")
    sys.exit(0)
