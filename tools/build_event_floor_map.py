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
# Wide enough to read table numbers when zoomed on a phone, small enough to load fast.
TARGET_IMAGE_WIDTH = 1600

_BLOCK_LABEL_RE = re.compile(r"^(?:[A-Z]|HA)$")
_LOCATION_TOKEN_RE = re.compile(
    r"^(?P<b1>HA|[A-Z])?\s*(?P<n1>\d+)\s*(?:[-–]\s*(?P<b2>HA|[A-Z])?\s*(?P<n2>\d+))?$"
)

# Keyword -> tag, matched against the CSV's free-text "inventory" answer.
TAG_PATTERNS: list[tuple[str, str]] = [
    ("Pokémon", r"pok[eé]mon|pkmn"),
    ("One Piece", r"one\s?piece"),
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
        tags = tags_for(row["inventory"]) if row else []
        if any(i.startswith(FOOD_BLOCK) for i in ids) or (row and "food" in row["purchase"].lower()):
            tags = ["Food", *[t for t in tags if t != "Food"]]
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
    tag_counts = collections.Counter(tag for v in vendors for tag in v["tags"])
    document = {
        "eventId": event_id,
        "imageFile": image_file,
        "imageWidth": image_size[0],
        "imageHeight": image_size[1],
        "tables": out_tables,
        "vendors": vendors,
        "tags": [tag for tag, _ in tag_counts.most_common()],
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

    csv_rows = load_csv(args.vendors_csv.expanduser()) if args.vendors_csv else None
    image_file = f"{args.event_id}.png"
    document, report = build_map(
        frame, event_id=args.event_id, image_file=image_file, image_size=_png_size(png), csv_rows=csv_rows
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / image_file).write_bytes(png)
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
