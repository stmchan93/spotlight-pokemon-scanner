#!/usr/bin/env python3
"""Validate art-tag gold-set JSONL against vocab v1 / v1.1 (stdlib only).

Lines without "vocab_version" are v1. Lines with "vocab_version": "v1.1" may also use
the v1.1 additions (V11_ADDITIONS); v1 lines may not.

Usage: python3 qa/art-tags-gold/validate.py [path/to/file.jsonl]
Exits non-zero if any line has errors.
"""
import json
import sys
from collections import Counter
from pathlib import Path

VOCAB = {
    "scene": {"beach", "ocean_underwater", "river_lake", "forest", "jungle", "field_meadow", "flowers_garden",
              "mountain", "cave", "desert", "snow_ice", "volcano", "sky_clouds", "space_stars", "city_street",
              "town_village", "indoor_home", "bedroom", "kitchen_food", "restaurant_cafe", "shop_market",
              "school_library", "lab", "stadium_arena", "festival_fair", "ruins_temple", "abstract_background",
              "other"},
    "weather_time": {"day", "sunset_sunrise", "night", "rain", "snow", "storm", "fog", "rainbow", "none_visible"},
    "activity": {"sleeping", "eating", "cooking", "playing", "swimming", "flying", "running", "battling", "posing",
                 "reading", "celebrating", "resting", "hugging_group", "hiding", "other"},
    "mood": {"cozy", "cute", "funny", "dramatic", "fierce", "peaceful", "spooky", "melancholy", "festive",
             "majestic"},
    "objects": {"food", "drinks", "sweets", "umbrella", "books", "toys", "balloons", "flowers", "gifts", "lanterns",
                "pokeballs", "instruments", "vehicles", "furniture", "bed_pillow", "tableware", "trees", "rocks",
                "water_splash", "other"},
    "art_style": {"painterly", "watercolor", "pencil_sketch", "anime_cel", "cgi_3d", "papercraft", "clay_model",
                  "pixel", "graphic_flat", "photo_composite", "mixed"},
    "composition": {"full_art_scene", "framed_window", "character_closeup", "panorama", "group_shot",
                    "text_heavy"},
}
# v1.1 = v1 plus these values.
V11_ADDITIONS = {
    "objects": {"energy_effects", "crystals_gems", "plants", "items_medicine", "lights_lamps", "containers",
                "paper_signs", "gym_equipment", "coins_treasure", "weapons"},
    "mood": {"cheerful", "adventurous"},
}
VOCABS = {
    "v1": VOCAB,
    "v1.1": {k: v | V11_ADDITIONS.get(k, set()) for k, v in VOCAB.items()},
}
# (min, max) list lengths for list fields
LIST_BOUNDS = {"scene": (1, 2), "weather_time": (0, 2), "activity": (0, 3), "mood": (1, 2), "objects": (0, 8)}
ROLES = {"main", "secondary", "background", "cameo"}
REVIEW_STATES = {"draft", "human_ok", "human_fixed"}
REQUIRED = ["card_id", "name", "set", "drafted_by"]


def check(rec):
    errs = []
    for k in REQUIRED:
        if not isinstance(rec.get(k), str) or not rec.get(k):
            errs.append(f"missing/empty {k}")
    rs = rec.get("review_state", "draft")
    if rs not in REVIEW_STATES:
        errs.append(f"bad review_state {rs!r}")
    ver = rec.get("vocab_version", "v1")
    if ver not in VOCABS:
        errs.append(f"unknown vocab_version {ver!r}")
        ver = "v1"
    vocab = VOCABS[ver]
    if "error" in rec:
        if rec["error"] != "image_unavailable":
            errs.append(f"unknown error value {rec['error']!r}")
        return errs
    for field, (lo, hi) in LIST_BOUNDS.items():
        v = rec.get(field)
        if not isinstance(v, list):
            errs.append(f"{field} must be a list")
            continue
        if not lo <= len(v) <= hi:
            errs.append(f"{field} has {len(v)} values (allowed {lo}-{hi})")
        if len(set(v)) != len(v):
            errs.append(f"{field} has duplicates")
        for x in v:
            if x not in vocab[field]:
                errs.append(f"{field}: {x!r} not in vocab {ver}")
    wt = rec.get("weather_time", [])
    if isinstance(wt, list) and "none_visible" in wt and len(wt) > 1:
        errs.append("weather_time: none_visible combined with other values")
    for field in ("art_style", "composition"):
        if rec.get(field) not in vocab[field]:
            errs.append(f"{field}: {rec.get(field)!r} not in vocab {ver}")
    ap = rec.get("appearing_pokemon")
    if not isinstance(ap, list):
        errs.append("appearing_pokemon must be a list")
    else:
        for i, p in enumerate(ap):
            if not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p.get("name"):
                errs.append(f"appearing_pokemon[{i}] needs a name")
                continue
            if p.get("role") not in ROLES:
                errs.append(f"appearing_pokemon[{i}] bad role {p.get('role')!r}")
            c = p.get("confidence")
            if not isinstance(c, (int, float)) or isinstance(c, bool) or not 0 <= c <= 1:
                errs.append(f"appearing_pokemon[{i}] confidence must be 0-1")
    ch = rec.get("characters")
    if not isinstance(ch, list) or len(ch) > 5 or not all(isinstance(x, str) and x for x in ch):
        errs.append("characters must be a list of <=5 non-empty strings")
    alt = rec.get("alt_text")
    if not isinstance(alt, str) or not alt.strip():
        errs.append("alt_text required")
    if not isinstance(rec.get("notes", ""), str):
        errs.append("notes must be a string")
    return errs


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("draft-v1.jsonl")
    bad = 0
    ids = Counter()
    n = unavailable = 0
    others = Counter()
    versions = Counter()
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        n += 1
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"line {lineno}: invalid JSON ({e})")
            bad += 1
            continue
        ids[rec.get("card_id")] += 1
        versions[rec.get("vocab_version", "v1")] += 1
        if "error" in rec:
            unavailable += 1
        for f in ("scene", "activity", "objects"):
            if "other" in rec.get(f, []):
                others[f] += 1
        errs = check(rec)
        if errs:
            bad += 1
            print(f"line {lineno} ({rec.get('card_id')}): " + "; ".join(errs))
    dups = [k for k, v in ids.items() if v > 1]
    if dups:
        bad += 1
        print(f"duplicate card_ids: {dups}")
    print(f"{path.name}: {n} lines, {n - bad} valid, {bad} invalid, {unavailable} image_unavailable")
    print("vocab versions: " + ", ".join(f"{k}={v}" for k, v in sorted(versions.items())))
    print("lines using 'other': " + ", ".join(f"{k}={v}" for k, v in sorted(others.items())))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
