#!/usr/bin/env python3
"""Shrink a show's vendor logos and key them to the floor map's vendor ids.

Input is a folder of logos (as downloaded from the ticketing vendor
applications) plus its ``_vendors.csv`` (columns: business, name, username,
logo_file). Output, for ``spotlight_events.py`` to serve as each vendor's
``logoUrl``:

    backend/data/spotlight_event_maps/<event-id>-logos/<vendor-id>.webp

Each logo is trimmed of its empty margin, padded square with its own
background colour (or transparency) and saved at 256px. Re-run after rebuilding the map (vendor ids come from its JSON), then
deploy the backend; no app release needed.

    python3 tools/build_event_vendor_logos.py \\
        --event-id hawaii-2026-10 --logos-dir ~/Downloads/hawaii-vendor-logos
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

MAPS_DIR = Path(__file__).resolve().parents[1] / "backend" / "data" / "spotlight_event_maps"
SIZE = 256


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower().replace("&", "and"))


def match_row(vendor: dict, rows: list[dict[str, str]]) -> dict[str, str] | None:
    keys = [k for k in (_norm(vendor["name"]), _norm(vendor.get("instagram") or "")) if k]
    for field in ("business", "username", "name"):
        for row in rows:
            if _norm(row[field]) in keys:
                return row
    # "Chazer808" vs "Chazer808 Collectibles"
    for row in rows:
        other = _norm(row["business"])
        if len(other) >= 5 and any(len(k) >= 5 and (other.startswith(k) or k.startswith(other)) for k in keys):
            return row
    return None


def _corner_colour(image: Image.Image) -> tuple[int, int, int, int] | None:
    """The background, when all four corners agree on one opaque colour."""
    w, h = image.size
    corners = [image.getpixel(xy) for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    if any(c[3] < 250 for c in corners):
        return None
    if max(max(c[i] for c in corners) - min(c[i] for c in corners) for i in range(3)) > 24:
        return None
    return tuple(sum(c[i] for c in corners) // 4 for i in range(3)) + (255,)  # type: ignore[return-value]


def square_logo(path: Path) -> Image.Image:
    image = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    background = _corner_colour(image)
    if background is None:
        bbox = image.getchannel("A").getbbox()
    else:
        # Trim the flat margin around the mark, then pad with that same colour.
        diff = ImageChops.difference(image.convert("RGB"), Image.new("RGB", image.size, background[:3]))
        bbox = diff.point(lambda v: 255 if v > 24 else 0).getbbox()
    if bbox:
        image = image.crop(bbox)
    # The app shows it in a circle; a margin keeps a square mark's corners in.
    side = int(max(image.size) * (1.2 if background else 1.0))
    canvas = Image.new("RGBA", (side, side), background or (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--logos-dir", type=Path, required=True)
    parser.add_argument("--maps-dir", type=Path, default=MAPS_DIR)
    args = parser.parse_args(argv)

    logos_dir = args.logos_dir.expanduser()
    vendors = json.loads((args.maps_dir / f"{args.event_id}.json").read_text(encoding="utf-8"))["vendors"]
    with (logos_dir / "_vendors.csv").open(encoding="utf-8", newline="") as handle:
        rows = [r for r in csv.DictReader(handle) if (logos_dir / r["logo_file"]).is_file()]

    out = args.maps_dir / f"{args.event_id}-logos"
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.webp"):
        stale.unlink()

    used: set[str] = set()
    missing: list[str] = []
    for vendor in vendors:
        row = match_row(vendor, rows)
        if row is None:
            missing.append(vendor["name"])
            continue
        square_logo(logos_dir / row["logo_file"]).save(out / f"{vendor['id']}.webp", "WEBP", quality=82, method=6)
        used.add(row["logo_file"])

    total = sum(p.stat().st_size for p in out.glob("*.webp"))
    print(f"{len(vendors) - len(missing)}/{len(vendors)} vendors have a logo ({total / 1e6:.1f} MB) -> {out}")
    print(f"\nno logo ({len(missing)}): " + ", ".join(missing))
    unused = [r["business"] or r["name"] for r in rows if r["logo_file"] not in used]
    if unused:
        print(f"\nlogos not on the map ({len(unused)}): " + ", ".join(unused))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
