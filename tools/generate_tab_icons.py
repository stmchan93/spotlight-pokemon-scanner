"""Rasterize the bottom-tab glyphs from their REAL source: the installed iconoir.

    uv run --with cairosvg python tools/generate_tab_icons.py

(cairosvg is not a repo dependency, same as Pillow in `generate_app_icons.py`.)

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

import re
import sys
from pathlib import Path

import cairosvg

REPO = Path(__file__).resolve().parent.parent
ICONOIR = REPO / "node_modules" / "iconoir-react-native" / "dist" / "regular"
OUT = REPO / "apps" / "spotlight-rn" / "assets" / "images" / "tab-icons"

# The glyph each tab draws, and the file it becomes. Names are iconoir's own, so
# they can be checked against the Figma layer names directly.
ICONS = {
    "home": "HomeSimple",
    "wishlist": "Bookmark",
}

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


def extract_paths(component: str) -> list[str]:
    """Every `d=` in an iconoir component, in draw order."""
    source = (ICONOIR / f"{component}.js").read_text(encoding="utf-8")
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


def main() -> int:
    if not ICONOIR.is_dir():
        raise SystemExit(f"iconoir not installed at {ICONOIR}. Run pnpm install first.")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, component in ICONS.items():
        paths = extract_paths(component)
        svg = build_svg(paths).encode("utf-8")
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
            print(f"{target.relative_to(REPO)}  {px}x{px}  ({component}, {len(paths)} paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
