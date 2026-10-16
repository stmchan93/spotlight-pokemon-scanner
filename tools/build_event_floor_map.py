#!/usr/bin/env python3
"""Build a Spotlight show's interactive floor map from its Figma layout.

Reads the show's vendor-layout frame through the Figma REST API and writes, for
the backend to serve (``spotlight_events.py``):

    backend/data/spotlight_event_maps/<event-id>.json   tables + vendors
    backend/data/spotlight_event_maps/<event-id>.png    the floor, as drawn

What the Figma frame must contain (the Hawaii layout already does):
  * every table is a node named ``6' table`` with its number as a TEXT child;
  * each block's tables share a frame with that block's letter (``A``..``N``,
    ``HA``) as a TEXT node; tables in no lettered frame are the food strip;
  * the vendor list is rows of exactly two TEXT nodes: name, location
    (``A29``, ``C1-C5, C26-C28``, ``L7-8``, ``HA 1-6``; bare numbers = food).

Re-run after every Figma edit, then deploy the backend; no app release needed.

    python3 tools/build_event_floor_map.py \\
        --event-id hawaii-2026-10 \\
        --figma 'https://www.figma.com/design/<key>/...?node-id=2381-2048' \\
        --vendors-csv ~/Downloads/vendors-....csv

The CSV (the ticketing export) only adds tags and Instagram handles; phone and
email columns are never read into the output. FIGMA_TOKEN comes from the
environment or the repo's gitignored ``.env.figma``.
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "backend" / "data" / "spotlight_event_maps"
TABLE_NODE_NAME = "6' table"
FOOD_BLOCK = "FOOD"
# ~3px per point at the app's max zoom (4x of a ~230pt-wide fit); bigger costs too much decode memory.
TARGET_IMAGE_WIDTH = 3000
# The walls-only floor plan under the app-drawn tables; it is itself a raster in
# Figma, so going bigger than its source adds bytes, not detail.
BASE_IMAGE_WIDTH = 2000

_BLOCK_LABEL_RE = re.compile(r"^(?:[A-Z]|HA)$")
_LOCATION_TOKEN_RE = re.compile(
    r"^(?P<b1>HA|[A-Z])?\s*(?P<n1>\d+)\s*(?:[-–]\s*(?P<b2>HA|[A-Z])?\s*(?P<n2>\d+))?$"
)

# The app's filter chips, in display order. Anything a vendor sells outside the
# named games/formats (supplies, Magic, Yu-Gi-Oh...) folds into "Misc".
FILTER_TAGS = [
    "Pokémon", "One Piece", "Lorcana", "Riftbound", "Sports", "Singles", "Sealed", "Graded", "Food", "Misc",
]
MISC_TAG = "Misc"

# Keyword -> tag, matched against the CSV's free-text "inventory" answer.
TAG_PATTERNS: list[tuple[str, str]] = [
    ("Pokémon", r"pok[eé]mon|pkmn"),
    ("One Piece", r"one\s?piece"),
    ("Riftbound", r"riftbound|\brift\b"),
    ("Sports", r"sport|baseball|basketball|football|\bnba\b|\bnfl\b|\bmlb\b"),
    ("Graded", r"slab|graded|\bpsa\b|\bcgc\b|\bbgs\b"),
    ("Singles", r"single"),
    ("Sealed", r"sealed|booster|\betb\b|\bbox"),
    ("Vintage", r"vintage|wotc|base set|1st ed"),
    ("Japanese", r"japan|\bjp\b"),
    ("Magic", r"magic|\bmtg\b"),
    ("Lorcana", r"lorcana"),
    ("Yu-Gi-Oh", r"yu.?gi.?oh"),
    ("Dragon Ball", r"dragon\s?ball"),
    ("Supplies", r"supplies|sleeve|toploader|accessor|binder"),
]


# ---------------------------------------------------------------------------
# Figma
# ---------------------------------------------------------------------------


def parse_figma_url(url: str) -> tuple[str, str]:
    """(file key, node id with a colon) from a Figma design URL."""
    parsed = urllib.parse.urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] not in {"design", "file"}:
        raise ValueError(f"not a Figma design URL: {url}")
    key = parts[1]
    if len(parts) >= 4 and parts[2] == "branch":
        key = parts[3]
    node = urllib.parse.parse_qs(parsed.query).get("node-id", [""])[0]
    if not node:
        raise ValueError("the URL has no node-id; copy the link with the frame selected")
    return key, node.replace("-", ":")


def figma_token() -> str:
    token = os.environ.get("FIGMA_TOKEN", "").strip()
    if not token:
        env_file = REPO / ".env.figma"
        if env_file.is_file():
            for line in env_file.read_text().splitlines():
                if line.strip().startswith("FIGMA_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip("'\"")
    if not token:
        raise SystemExit("FIGMA_TOKEN is not set (env or .env.figma)")
    return token


def _figma_get(path: str, token: str) -> Any:
    request = urllib.request.Request(
        f"https://api.figma.com/v1/{path}", headers={"X-Figma-Token": token}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def fetch_frame(key: str, node_id: str, token: str) -> dict[str, Any]:
    payload = _figma_get(f"files/{key}/nodes?ids={urllib.parse.quote(node_id)}", token)
    node = (payload.get("nodes") or {}).get(node_id)
    if not node or "document" not in node:
        raise SystemExit(f"Figma returned no node {node_id}")
    return node["document"]


def export_png(key: str, node_id: str, scale: float, token: str) -> bytes:
    payload = _figma_get(
        f"images/{key}?ids={urllib.parse.quote(node_id)}&format=png&scale={scale:.4f}", token
    )
    url = (payload.get("images") or {}).get(node_id)
    if not url:
        raise SystemExit(f"Figma could not render {node_id}: {payload.get('err')}")
    with urllib.request.urlopen(url, timeout=300) as response:
        return response.read()


# ---------------------------------------------------------------------------
# Layout extraction (pure; unit-tested)
# ---------------------------------------------------------------------------


def _box(node: dict[str, Any]) -> tuple[float, float, float, float]:
    b = node["absoluteBoundingBox"]
    return b["x"], b["y"], b["width"], b["height"]


def _text_children(node: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in node.get("children", []) if c.get("type") == "TEXT"]


def _chars(node: dict[str, Any]) -> str:
    return " ".join(str(node.get("characters", "")).split())


def _walk_tables(node, ancestors, out):
    if node.get("name") == TABLE_NODE_NAME:
        out.append((node, ancestors))
        return
    for child in node.get("children", []):
        _walk_tables(child, ancestors + [node], out)


def _center(box):
    x, y, w, h = box
    return x + w / 2, y + h / 2


def extract_tables(frame: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Tables with absolute boxes, plus the node that holds all of them (the map)."""
    found: list[tuple[dict, list[dict]]] = []
    _walk_tables(frame, [], found)
    if not found:
        raise ValueError(f"no '{TABLE_NODE_NAME}' nodes in the frame")

    # The map = deepest ancestor shared by every table.
    shared = found[0][1]
    for _, ancestors in found[1:]:
        ids = {a["id"] for a in ancestors}
        shared = [a for a in shared if a["id"] in ids]
    map_node = shared[-1]

    # Tables sharing a direct parent form a cluster; its centre picks the label.
    # Per-table distance fails where blocks touch (H's tables 1-2 sit nearer "HA").
    clusters: dict[str, list[tuple[float, float]]] = collections.defaultdict(list)
    for node, ancestors in found:
        clusters[ancestors[-1]["id"]].append(_center(_box(node)))
    cluster_centre = {
        key: (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        for key, pts in clusters.items()
    }

    tables: list[dict[str, Any]] = []
    for node, ancestors in found:
        numbers = [_chars(t) for t in _text_children(node) if _chars(t).isdigit()]
        if not numbers:
            raise ValueError(f"table {node['id']} has no number")
        block = FOOD_BLOCK
        centre = cluster_centre[ancestors[-1]["id"]]
        for ancestor in reversed(ancestors):
            labels = [t for t in _text_children(ancestor) if _BLOCK_LABEL_RE.match(_chars(t))]
            if labels:
                nearest = min(labels, key=lambda t: math.dist(centre, _center(_box(t))))
                block = _chars(nearest)
                break
        number = int(numbers[0])
        tables.append({"id": f"{block}{number}", "block": block, "number": number, "box": _box(node)})

    duplicates = [i for i, n in collections.Counter(t["id"] for t in tables).items() if n > 1]
    if duplicates:
        raise ValueError(f"duplicate table ids: {sorted(duplicates)}")
    return tables, map_node


def _solid_fill(node: dict[str, Any]) -> tuple[str, float] | None:
    for fill in node.get("fills") or []:
        if fill.get("visible", True) and fill.get("type") == "SOLID" and fill.get("color"):
            c = fill["color"]
            hex_color = "#%02X%02X%02X" % tuple(round(c[k] * 255) for k in "rgb")
            return hex_color, round(float(fill.get("opacity", 1)) * float(c.get("a", 1)), 3)
    return None


def _has_image_fill(node: dict[str, Any]) -> bool:
    return any(f.get("type") == "IMAGE" and f.get("visible", True) for f in node.get("fills") or [])


def extract_drawing(map_node: dict[str, Any]) -> dict[str, Any]:
    """What the app draws itself (sharp at any zoom): the walls raster's node,
    coloured areas, text labels, and the tables' look. Boxes are absolute."""
    base: dict[str, Any] | None = None
    areas: list[dict[str, Any]] = []
    labels: list[dict[str, Any]] = []
    table_color: str | None = None
    number_size: float | None = None

    def walk(node: dict[str, Any], is_root: bool) -> None:
        nonlocal base, table_color, number_size
        if node.get("name") == TABLE_NODE_NAME:
            fill = _solid_fill(node)
            if fill and table_color is None:
                table_color = fill[0]
            for text in _text_children(node):
                size = (text.get("style") or {}).get("fontSize")
                if size and number_size is None:
                    number_size = float(size)
            return
        kind = node.get("type")
        if not is_root:
            if _has_image_fill(node):
                if base is None or node["absoluteBoundingBox"]["width"] > base["absoluteBoundingBox"]["width"]:
                    base = node
            elif kind == "TEXT" and _chars(node):
                style = node.get("style") or {}
                labels.append({
                    "text": str(node.get("characters", "")).strip(),
                    "box": _box(node),
                    "fontSize": float(style.get("fontSize") or 0),
                    "bold": float(style.get("fontWeight") or 400) >= 600,
                })
            elif kind in {"FRAME", "RECTANGLE", "ELLIPSE"}:
                fill = _solid_fill(node)
                if fill:
                    areas.append({
                        "shape": "ellipse" if kind == "ELLIPSE" else "rect",
                        "box": _box(node), "color": fill[0], "opacity": fill[1],
                    })
        for child in node.get("children", []):
            walk(child, False)

    walk(map_node, True)
    return {"base": base, "areas": areas, "labels": labels,
            "tableColor": table_color or "#BFFEAC", "numberSize": number_size or 0.0}


def extract_vendor_rows(frame: dict[str, Any]) -> list[tuple[str, str]]:
    """(name, location) for every two-text row; header rows dropped."""
    rows: list[tuple[str, str]] = []

    def walk(node):
        children = node.get("children", [])
        texts = _text_children(node)
        if len(children) == 2 and len(texts) == 2:
            left, right = sorted(texts, key=lambda t: _box(t)[0])
            name, location = _chars(left), _chars(right)
            if (name.upper(), location.upper()) != ("VENDOR", "LOCATION") and name and location:
                rows.append((name, location))
            return
        for child in children:
            walk(child)

    walk(frame)
    return rows


def parse_location(location: str) -> list[str]:
    """`C1-C5, C26-C28` -> [C1..C5, C26..C28]; bare numbers are food stalls."""
    ids: list[str] = []
    for token in re.split(r"[,&/]", location):
        token = token.strip()
        if not token:
            continue
        match = _LOCATION_TOKEN_RE.match(token.upper())
        if not match:
            raise ValueError(f"unreadable location {token!r} in {location!r}")
        b1, b2 = match["b1"], match["b2"] or match["b1"]
        start = int(match["n1"])
        end = int(match["n2"]) if match["n2"] else start
        if b2 != b1 or end < start:
            raise ValueError(f"range crosses blocks or runs backwards: {token!r}")
        block = b1 or FOOD_BLOCK
        ids.extend(f"{block}{n}" for n in range(start, end + 1))
    return ids


# ---------------------------------------------------------------------------
# CSV enrichment
# ---------------------------------------------------------------------------


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _handle(raw: str) -> str | None:
    text = raw.strip()
    match = re.search(r"instagram\.com/([A-Za-z0-9_.]+)", text)
    if match:
        text = match.group(1)
    text = text.lstrip("@").strip().strip("/")
    return text if re.fullmatch(r"[A-Za-z0-9_.]{1,30}", text) else None


def tags_for(inventory: str) -> list[str]:
    return [tag for tag, pattern in TAG_PATTERNS if re.search(pattern, inventory, re.I)]


# Attributes of what they already sell, not a separate line of goods.
_NOT_MISC = {"Vintage", "Japanese"}


def filter_tags(raw: list[str]) -> list[str]:
    """Raw keyword tags -> the chip vocabulary, in chip order."""
    tags = [t for t in FILTER_TAGS if t in raw]
    if any(t not in FILTER_TAGS and t not in _NOT_MISC for t in raw) or not raw:
        tags.append(MISC_TAG)
    return tags


def load_csv(path: Path) -> list[dict[str, str]]:
    keep = ("business_name", "name", "instagram", "inventory", "purchase", "status")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [{k: (row.get(k) or "") for k in keep} for row in csv.DictReader(handle)]


def match_csv(name: str, rows: list[dict[str, str]]) -> dict[str, str] | None:
    key = _norm(name)
    if not key:
        return None
    for field in ("business_name", "instagram", "name"):
        for row in rows:
            if _norm(row[field]) == key:
                return row
    # "Chazer808" vs "chazer808 collectibles partnered w/ ..."
    if len(key) >= 5:
        for row in rows:
            for field in ("business_name", "instagram"):
                other = _norm(row[field])
                if len(other) >= 5 and (other.startswith(key) or key.startswith(other)):
                    return row
    return None


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def _slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-") or "vendor"


def build_map(
    frame: dict[str, Any],
    *,
    event_id: str,
    image_file: str,
    image_size: tuple[int, int],
    base_image_file: str | None = None,
    csv_rows: list[dict[str, str]] | None = None,
    now: datetime | None = None,
) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """(map document, report of things a human should look at)."""
    tables, map_node = extract_tables(frame)
    mx, my, mw, mh = _box(map_node)
    table_ids = {t["id"] for t in tables}
    report: dict[str, list[str]] = {"unknownTables": [], "badLocations": [], "noCsvMatch": []}

    out_tables = []
    for t in sorted(tables, key=lambda t: (t["block"], t["number"])):
        x, y, w, h = t["box"]
        out_tables.append({
            "id": t["id"], "block": t["block"], "number": t["number"],
            "x": round((x - mx) / mw, 5), "y": round((y - my) / mh, 5),
            "width": round(w / mw, 5), "height": round(h / mh, 5),
        })

    vendors: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for name, location in extract_vendor_rows(frame):
        try:
            ids = parse_location(location)
        except ValueError as error:
            report["badLocations"].append(f"{name}: {error}")
            continue
        missing = [i for i in ids if i not in table_ids]
        if missing:
            report["unknownTables"].append(f"{name} ({location}): {', '.join(missing)}")
        ids = [i for i in ids if i in table_ids]

        row = match_csv(name, csv_rows) if csv_rows else None
        raw_tags = tags_for(row["inventory"]) if row else []
        if any(i.startswith(FOOD_BLOCK) for i in ids) or (row and "food" in row["purchase"].lower()):
            raw_tags.append("Food")
        tags = filter_tags(raw_tags)
        if csv_rows and row is None:
            report["noCsvMatch"].append(name)

        vendor_id = _slug(name)
        suffix = 2
        while vendor_id in seen_ids:
            vendor_id = f"{_slug(name)}-{suffix}"
            suffix += 1
        seen_ids.add(vendor_id)
        vendors.append({
            "id": vendor_id, "name": name, "location": location, "tableIds": ids,
            "tags": tags, "instagram": _handle(row["instagram"]) if row else None,
        })

    vendors.sort(key=lambda v: v["name"].lower())

    def frac(box: tuple[float, float, float, float]) -> dict[str, float]:
        x, y, w, h = box
        return {"x": round((x - mx) / mw, 5), "y": round((y - my) / mh, 5),
                "width": round(w / mw, 5), "height": round(h / mh, 5)}

    drawing = extract_drawing(map_node)
    vector = None
    if base_image_file and drawing["base"] is not None:
        vector = {
            "baseImageFile": base_image_file,
            "baseImage": frac(_box(drawing["base"])),
            "areas": [{"shape": a["shape"], **frac(a["box"]), "color": a["color"], "opacity": a["opacity"]}
                      for a in drawing["areas"]],
            # Font sizes as a fraction of the map's height, like every other measure.
            "labels": [{"text": l["text"], **frac(l["box"]), "fontSize": round(l["fontSize"] / mh, 5),
                        "bold": l["bold"]} for l in drawing["labels"]],
            "tableColor": drawing["tableColor"],
            "tableNumberSize": round(drawing["numberSize"] / mh, 5),
        }
    used = {tag for v in vendors for tag in v["tags"]}
    document = {
        "eventId": event_id,
        "imageFile": image_file,
        "imageWidth": image_size[0],
        "imageHeight": image_size[1],
        "tables": out_tables,
        "vendors": vendors,
        "tags": [tag for tag in FILTER_TAGS if tag in used],
        "vector": vector,
        "updatedAt": (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    return document, report


def _png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("Figma export is not a PNG")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event-id", required=True, help="id in backend/data/spotlight_events.json")
    parser.add_argument("--figma", required=True, help="Figma link to the layout frame (with node-id)")
    parser.add_argument("--vendors-csv", type=Path, help="ticketing vendor export, for tags + Instagram")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.event_id):
        raise SystemExit("--event-id must be a [a-z0-9-] slug")
    key, node_id = parse_figma_url(args.figma)
    token = figma_token()

    frame = fetch_frame(key, node_id, token)
    _, map_node = extract_tables(frame)
    scale = min(1.0, TARGET_IMAGE_WIDTH / map_node["absoluteBoundingBox"]["width"])
    png = export_png(key, map_node["id"], scale, token)

    base = extract_drawing(map_node)["base"]
    base_png = None
    if base is not None:
        base_scale = min(1.0, BASE_IMAGE_WIDTH / base["absoluteBoundingBox"]["width"])
        base_png = export_png(key, base["id"], base_scale, token)

    csv_rows = load_csv(args.vendors_csv.expanduser()) if args.vendors_csv else None
    image_file = f"{args.event_id}.png"
    base_image_file = f"{args.event_id}-base.png" if base_png else None
    document, report = build_map(
        frame, event_id=args.event_id, image_file=image_file, image_size=_png_size(png),
        base_image_file=base_image_file, csv_rows=csv_rows,
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / image_file).write_bytes(png)
    if base_png and base_image_file:
        (args.out_dir / base_image_file).write_bytes(base_png)
    (args.out_dir / f"{args.event_id}.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    print(f"{len(document['tables'])} tables, {len(document['vendors'])} vendors, "
          f"image {document['imageWidth']}x{document['imageHeight']} -> {args.out_dir}")
    for label, items in report.items():
        if items:
            print(f"\n{label} ({len(items)}):")
            for item in items:
                print(f"  - {item}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
