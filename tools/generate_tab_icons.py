"""Rasterize the bottom-tab glyphs from their REAL source: the installed iconoir.

    uv run --with cairosvg --with pillow python tools/generate_tab_icons.py

(cairosvg/Pillow are not repo dependencies, same as in `generate_app_icons.py`.)

WHY THIS EXISTS AT ALL
======================
The bottom bar is a NATIVE tab bar (expo-router `NativeTabs`), so an icon is
either a platform symbol name — SF Symbols on iOS, Material on Android — or a
raster image. It cannot be a React component, which is the only form
`iconoir-react-native` ships.

Figma 3670:48082 (Home) and 3670:48091 (Wishlist) draw iconoir glyphs, and the
design is the source of truth, so those two have to reach the bar as images.

WHY IT READS node_modules INSTEAD OF A COMMITTED SVG
====================================================
The path data below is not copied into this file — it is EXTRACTED from
`iconoir-react-native` at run time. A hand-copied path is a snapshot that
silently stops matching the package the app renders everywhere else the moment
iconoir is upgraded; reading the installed source means regenerating always
produces what the rest of the app draws. It also means the PNGs are traceable to
a versioned dependency rather than to a Figma export URL that expires in a week.

WHAT IS DELIBERATELY NOT HERE
=============================
The Scan tab. Figma 3670:48086 draws Apple's `viewfinder`, which iOS already
renders natively as an SF Symbol — there is nothing to rasterize, and Apple's
SF Symbols license does not permit shipping their artwork on Android anyway.
Android uses Material's own four-corner glyph instead. See `(tabs)/_layout.tsx`.
"""

from __future__ import annotations

import io
import re
import sys
from pathlib import Path

import cairosvg
from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parent.parent
ICONOIR = REPO / "node_modules" / "iconoir-react-native" / "dist"
OUT = REPO / "apps" / "spotlight-rn" / "assets" / "images" / "tab-icons"

# The glyph each tab draws, and the file it becomes. Names are iconoir's own, so
# they can be checked against the Figma layer names directly.
ICONS = {
    "home": "HomeSimple",
    "wishlist": "Bookmark",
}

# SELECTED-STATE VARIANTS (Figma 4299:95029): the same glyphs, filled.
# Wishlist ships as iconoir `solid/Bookmark`. iconoir has no solid HomeSimple,
# so the filled home is the regular shell filled — with the door slot KNOCKED
# OUT of the alpha rather than painted white as the Figma asset does: a tab
# icon is template-tinted, only alpha survives, and white ink would simply
# vanish into the fill.

# Rendered in a 24pt box for BOTH glyphs. Figma reports Wishlist as 14x18 because
# that is the bookmark's ink inside iconoir's 24x24 viewBox — rendering it in the
# same box as Home is what keeps their relative weights right in the bar.
BOX_PT = 24
# React Native picks `@2x` / `@3x` off the filename; the base file is 1x.
SCALES = (1, 2, 3)

# iconoir's own defaults, from the component wrapper it generates.
VIEW_BOX = "0 0 24 24"
STROKE_WIDTH = 1.5

# Black on transparent. The COLOUR IS IRRELEVANT and must not be tuned: a tab
# icon is tinted by the OS — template rendering on iOS, an SRC_IN tint list on
# Android — so only the alpha survives. Black simply keeps the anti-aliased
# edges neutral.
STROKE = "#000000"


def extract_paths(component: str, variant: str = "regular") -> list[str]:
    """Every `d=` in an iconoir component, in draw order."""
    source = (ICONOIR / variant / f"{component}.js").read_text(encoding="utf-8")
    paths = re.findall(r'd:"([^"]+)"', source)
    if not paths:
        raise SystemExit(f"No path data in {component}.js — did iconoir change shape?")
    return paths


def build_svg(paths: list[str]) -> str:
    body = "".join(
        f'<path d="{d}" fill="none" stroke="{STROKE}" stroke-width="{STROKE_WIDTH}"'
        ' stroke-linecap="round" stroke-linejoin="round"/>'
        for d in paths
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEW_BOX}" '
        f'width="{BOX_PT}" height="{BOX_PT}">{body}</svg>'
    )


def build_solid_svg(paths: list[str]) -> str:
    """iconoir solid glyphs: fill AND stroke, the way the package renders them."""
    body = "".join(
        f'<path d="{d}" fill="{STROKE}" stroke="{STROKE}" stroke-width="{STROKE_WIDTH}"'
        ' stroke-linecap="round" stroke-linejoin="round"/>'
        for d in paths
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEW_BOX}" '
        f'width="{BOX_PT}" height="{BOX_PT}">{body}</svg>'
    )


def rasterize_filled_home(name: str, shell: str, slot: str) -> None:
    """The regular HomeSimple shell, filled, with the door slot erased from the
    alpha. Done in raster space (cairosvg silently ignores SVG <mask>): render
    the slot stroke on its own and subtract its alpha from the filled shell's.
    """
    shell_svg = build_solid_svg([shell]).encode("utf-8")
    slot_svg = build_svg([slot]).encode("utf-8")
    for scale in SCALES:
        suffix = "" if scale == 1 else f"@{scale}x"
        target = OUT / f"{name}{suffix}.png"
        px = BOX_PT * scale
        filled = Image.open(
            io.BytesIO(cairosvg.svg2png(bytestring=shell_svg, output_width=px, output_height=px))
        ).convert("RGBA")
        slot_mask = Image.open(
            io.BytesIO(cairosvg.svg2png(bytestring=slot_svg, output_width=px, output_height=px))
        ).convert("RGBA")
        alpha = ImageChops.subtract(filled.getchannel("A"), slot_mask.getchannel("A"))
        filled.putalpha(alpha)
        filled.save(target)
        print(f"{target.relative_to(REPO)}  {px}x{px}  (regular/HomeSimple, filled)")


def rasterize(name: str, svg_text: str, source: str) -> None:
    svg = svg_text.encode("utf-8")
    for scale in SCALES:
        suffix = "" if scale == 1 else f"@{scale}x"
        target = OUT / f"{name}{suffix}.png"
        px = BOX_PT * scale
        cairosvg.svg2png(
            bytestring=svg,
            write_to=str(target),
            output_width=px,
            output_height=px,
        )
        print(f"{target.relative_to(REPO)}  {px}x{px}  ({source})")


def main() -> int:
    if not ICONOIR.is_dir():
        raise SystemExit(f"iconoir not installed at {ICONOIR}. Run pnpm install first.")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, component in ICONS.items():
        rasterize(name, build_svg(extract_paths(component)), f"regular/{component}")

    home_paths = extract_paths(ICONS["home"])
    rasterize_filled_home("home-filled", home_paths[0], home_paths[1])
    rasterize(
        "wishlist-filled",
        build_solid_svg(extract_paths(ICONS["wishlist"], variant="solid")),
        "solid/Bookmark",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
