"""Load a hand/agent-drafted art-tag JSONL (qa/art-tags-seed, qa/art-tags-gold)
into card_art_groups / card_art_tags, through the same normalizer and writer
the batch tagger uses. Lines are keyed by card_id; each lands on that card's
art group, so EN↔JP pairs inherit the tags.

    python tools/import_art_seed.py --database data/spotlight_scanner.sqlite \
        --jsonl ../qa/art-tags-seed/ir-seed-v1.jsonl --model claude-opus-5-5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from art_groups import compute_art_groups  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from tools.tag_card_art import build_pokemon_name_index, normalize_tags, write_tagged_groups  # noqa: E402

# Drafts list facet values as plain strings; give them a uniform confidence.
DRAFT_CONFIDENCE = 0.9
LIST_FACETS = ("scene", "weather_time", "activity", "mood", "objects")


def to_model_shape(line: dict) -> dict:
    raw = dict(line)
    for facet in LIST_FACETS:
        raw[facet] = [
            v if isinstance(v, dict) else {"value": v, "confidence": DRAFT_CONFIDENCE}
            for v in line.get(facet) or []
        ]
    return raw


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--jsonl", required=True)
    parser.add_argument("--model", default="seed")
    parser.add_argument("--prompt-version", default="seed")
    args = parser.parse_args(argv)

    conn = connect(Path(args.database))
    apply_schema(conn, BACKEND_ROOT / "schema.sql")
    group_of = {}
    for group in compute_art_groups(conn):
        for card_id in group.members:
            group_of[card_id] = group
    name_index = build_pokemon_name_index(conn)

    entries, seen, skipped = [], set(), []
    for text in Path(args.jsonl).read_text().splitlines():
        if not text.strip():
            continue
        line = json.loads(text)
        group = group_of.get(line.get("card_id"))
        if line.get("error") or group is None:
            skipped.append(line.get("card_id"))
            continue
        if group.art_group_id in seen:
            continue
        seen.add(group.art_group_id)
        tags, rows, alt_text = normalize_tags(to_model_shape(line), name_index=name_index)
        entries.append(
            {
                "art_group_id": group.art_group_id,
                "representative_card_id": group.representative_card_id,
                "members": dict(group.members),
                "tags": tags,
                "rows": rows,
                "alt_text": alt_text,
            }
        )
    written = write_tagged_groups(conn, entries, model=args.model, prompt_version=args.prompt_version)
    members = sum(len(e["members"]) for e in entries)
    print(json.dumps({"groups_written": written, "cards_covered": members, "skipped": skipped}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
