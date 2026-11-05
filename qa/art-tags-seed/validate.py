#!/usr/bin/env python3
"""Validate qa/art-tags-seed/ir-seed-v1.jsonl against art-tag vocab v1.

Stdlib only. Usage:
    python3 qa/art-tags-seed/validate.py [path/to/file.jsonl] [--stats]

Exits 0 when every line is valid, 1 otherwise. --stats prints counts and the
top scene / activity values.
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_JSONL = HERE / "ir-seed-v1.jsonl"
CARDS_FILE = HERE / "cards.txt"

VOCAB_VERSION = "v1.1"

ENUMS = {
    "scene": {
        "beach", "ocean_underwater", "river_lake", "forest", "jungle", "field_meadow",
        "flowers_garden", "mountain", "cave", "desert", "snow_ice", "volcano",
        "sky_clouds", "space_stars", "city_street", "town_village", "indoor_home",
        "bedroom", "kitchen_food", "restaurant_cafe", "shop_market", "school_library",
        "lab", "stadium_arena", "festival_fair", "ruins_temple", "abstract_background",
        "other",
    },
    "weather_time": {
        "day", "sunset_sunrise", "night", "rain", "snow", "storm", "fog", "rainbow",
        "none_visible",
    },
    "activity": {
        "sleeping", "eating", "cooking", "playing", "swimming", "flying", "running",
        "battling", "posing", "reading", "celebrating", "resting", "hugging_group",
        "hiding", "other",
    },
    "mood": {
        "cozy", "cute", "funny", "dramatic", "fierce", "peaceful", "spooky",
        "melancholy", "festive", "majestic", "cheerful", "adventurous",
    },
    "objects": {
        "food", "drinks", "sweets", "umbrella", "books", "toys", "balloons", "flowers",
        "gifts", "lanterns", "pokeballs", "instruments", "vehicles", "furniture",
        "bed_pillow", "tableware", "trees", "rocks", "water_splash", "other",
        # v1.1 additions
        "energy_effects", "crystals_gems", "plants", "items_medicine", "lights_lamps",
        "containers", "paper_signs", "gym_equipment", "coins_treasure", "weapons",
    },
}
# field -> (min, max) list length
LIST_BOUNDS = {
    "scene": (1, 2),
    "weather_time": (0, 2),
    "activity": (0, 3),
    "mood": (1, 2),
    "objects": (0, 8),
}
ART_STYLES = {
    "painterly", "watercolor", "pencil_sketch", "anime_cel", "cgi_3d", "papercraft",
    "clay_model", "pixel", "graphic_flat", "photo_composite", "mixed",
}
COMPOSITIONS = {
    "full_art_scene", "framed_window", "character_closeup", "panorama", "group_shot",
    "text_heavy",
}
ROLES = {"main", "secondary", "background", "cameo"}
FORBIDDEN_KEYS = {"artist", "set", "set_name", "rarity", "price", "prices"}

TAGGED_KEYS = {
    "card_id", "name", "scene", "weather_time", "activity", "mood", "objects",
    "art_style", "composition", "appearing_pokemon", "characters", "alt_text",
    "drafted_by", "vocab_version",
}
OPTIONAL_KEYS = {"remap"}  # set when v1.1 values were inferred from alt_text
ERROR_KEYS = {"card_id", "name", "error", "drafted_by", "vocab_version"}
ALLOWED_ERRORS = {"image_unavailable"}


def load_cards() -> dict[str, str]:
    cards: dict[str, str] = {}
    if CARDS_FILE.exists():
        for raw in CARDS_FILE.read_text(encoding="utf-8").splitlines():
            if raw.strip():
                cid, _, name = raw.partition("|")
                cards[cid.strip()] = name.strip()
    return cards


def _is_str(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def validate_record(rec: dict, cards: dict[str, str]) -> list[str]:
    errs: list[str] = []
    if not isinstance(rec, dict):
        return ["line is not a JSON object"]

    for k in FORBIDDEN_KEYS & rec.keys():
        errs.append(f"forbidden key {k!r}")

    cid = rec.get("card_id")
    if not _is_str(cid):
        errs.append("card_id missing/empty")
    elif cards and cid not in cards:
        errs.append(f"card_id {cid!r} not in cards.txt")
    elif cards and rec.get("name") != cards[cid]:
        errs.append(f"name {rec.get('name')!r} != cards.txt {cards[cid]!r}")
    if not _is_str(rec.get("drafted_by")):
        errs.append("drafted_by missing/empty")
    if rec.get("vocab_version") != VOCAB_VERSION:
        errs.append(f"vocab_version must be {VOCAB_VERSION!r}")

    if "error" in rec:
        if rec["error"] not in ALLOWED_ERRORS:
            errs.append(f"unknown error value {rec['error']!r}")
        extra = rec.keys() - ERROR_KEYS
        if extra:
            errs.append(f"error line has extra keys {sorted(extra)}")
        return errs

    missing = TAGGED_KEYS - rec.keys()
    if missing:
        errs.append(f"missing keys {sorted(missing)}")
    extra = rec.keys() - TAGGED_KEYS - OPTIONAL_KEYS
    if extra:
        errs.append(f"unexpected keys {sorted(extra)}")

    for field, allowed in ENUMS.items():
        val = rec.get(field)
        if not isinstance(val, list):
            errs.append(f"{field} must be a list")
            continue
        lo, hi = LIST_BOUNDS[field]
        if not lo <= len(val) <= hi:
            errs.append(f"{field} has {len(val)} values (allowed {lo}-{hi})")
        if len(set(map(str, val))) != len(val):
            errs.append(f"{field} has duplicate values")
        bad = [v for v in val if v not in allowed]
        if bad:
            errs.append(f"{field} has out-of-vocab values {bad}")
    wt = rec.get("weather_time")
    if isinstance(wt, list) and "none_visible" in wt and len(wt) > 1:
        errs.append("weather_time: none_visible must be alone")

    if rec.get("art_style") not in ART_STYLES:
        errs.append(f"art_style {rec.get('art_style')!r} not in vocab")
    if rec.get("composition") not in COMPOSITIONS:
        errs.append(f"composition {rec.get('composition')!r} not in vocab")

    ap = rec.get("appearing_pokemon")
    if not isinstance(ap, list):
        errs.append("appearing_pokemon must be a list")
    else:
        for i, p in enumerate(ap):
            if not isinstance(p, dict) or set(p.keys()) != {"name", "role", "confidence"}:
                errs.append(f"appearing_pokemon[{i}] must have exactly name/role/confidence")
                continue
            if not _is_str(p["name"]):
                errs.append(f"appearing_pokemon[{i}].name empty")
            if p["role"] not in ROLES:
                errs.append(f"appearing_pokemon[{i}].role {p['role']!r} not in {sorted(ROLES)}")
            c = p["confidence"]
            if isinstance(c, bool) or not isinstance(c, (int, float)) or not 0 <= c <= 1:
                errs.append(f"appearing_pokemon[{i}].confidence must be 0-1")

    ch = rec.get("characters")
    if not isinstance(ch, list) or len(ch) > 5 or not all(_is_str(c) for c in ch):
        errs.append("characters must be a list of <=5 non-empty strings")

    alt = rec.get("alt_text")
    if not _is_str(alt):
        errs.append("alt_text missing/empty")
    elif "\n" in alt:
        errs.append("alt_text must be one line")
    return errs


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    path = Path(args[0]) if args else DEFAULT_JSONL
    cards = load_cards()
    n_bad = 0
    seen: set[str] = set()
    recs: list[dict] = []
    if not path.exists():
        print(f"{path}: not found (0 lines)")
        lines: list[str] = []
    else:
        lines = path.read_text(encoding="utf-8").splitlines()
    for lineno, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"line {lineno}: invalid JSON: {exc}")
            n_bad += 1
            continue
        errs = validate_record(rec, cards)
        cid = rec.get("card_id") if isinstance(rec, dict) else None
        if cid in seen:
            errs.append("duplicate card_id")
        seen.add(cid)
        if errs:
            n_bad += 1
            for e in errs:
                print(f"line {lineno} ({cid}): {e}")
        recs.append(rec if isinstance(rec, dict) else {})

    tagged = [r for r in recs if "error" not in r]
    unavailable = [r for r in recs if r.get("error") == "image_unavailable"]
    remaining = len(set(cards) - seen) if cards else 0
    print(
        f"{path.name}: {len(recs)} lines, {n_bad} invalid | tagged={len(tagged)} "
        f"image_unavailable={len(unavailable)} remaining={remaining}"
    )
    if "--stats" in argv:
        for field in ("scene", "activity"):
            ctr = collections.Counter(v for r in tagged for v in r.get(field, []))
            top = ", ".join(f"{k}={v}" for k, v in ctr.most_common(10)) or "(none)"
            print(f"top {field}: {top}")
    return 1 if n_bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
