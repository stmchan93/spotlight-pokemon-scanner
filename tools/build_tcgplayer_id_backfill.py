"""Build ``backend/tcgplayer_id_backfill.json``: TCGplayer product ids for catalog
cards whose Scrydex payload carries none (in practice: Japanese vintage sets and
promos, where Scrydex never links TCGplayer even though TCGplayer's "Pokemon
Japan" category lists and prices them).

    python3 tools/build_tcgplayer_id_backfill.py \
        --cards-json /path/to/jp_dump.json \
        --cache-dir /path/to/tcgcsv_cache \
        --out backend/tcgplayer_id_backfill.json \
        --report /path/to/report.md

Matching is deliberately conservative — an unmapped card keeps its Scrydex
fallback, a wrong map shows a wrong price:

  1. Set -> TCGplayer group: normalized English set name, plus the alias table
     below for the names TCGplayer spells differently. A set that resolves to
     no group (or several) contributes nothing.
  2. Card -> product inside that group:
       - when the product carries a card Number (modern sets/promos), Number
         AND name must both agree (``card_numbers_match`` semantics);
       - otherwise (all vintage JP: TCGplayer stores no Number there) the
         normalized name must be unique on BOTH sides, or the tie must break
         on (HP, rarity) — same-name cards with identical HP+rarity (Unown
         letters, some promos) stay unmapped;
       - a product already claimed by another card's Scrydex payload, or
         matched by two of our cards, is dropped.

The catalog side is a JSON dump (see the docstring of ``--cards-json``) so the
script can run against a staging/prod export without DB access; the TCGCSV side
is the on-disk cache written by tools/audit_tcgcsv_parity.py-style crawls
(``<cache-dir>/<category>/<group>_products.json`` + ``_prices.json``).
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.tcgcsv_adapter import (  # noqa: E402
    card_numbers_match,
    normalized_card_number,
    product_number,
)

JP_CATEGORY_ID = 85

# Our set id -> TCGplayer group id, for sets whose English name TCGplayer spells
# differently (or where several groups share a name). Verified by hand against
# the group list on 2026-09-07; everything else resolves by normalized name.
SET_ID_TO_GROUP_ID: dict[str, int] = {
    "base1_ja": 23721,      # Expansion Pack (not the "(No Rarity)" print run)
    "base2_ja": 23722,      # Pokemon Jungle
    "vnd1_ja": 24206,       # Vending Machine cards Series 1 (Blue)
    "vnd2_ja": 24207,
    "vnd3_ja": 24208,
    "vs1_ja": 24180,        # Pokemon VS
    "web1_ja": 24141,       # Pokemon Web
    "pcg7_ja": 24084,       # Holon Phantom (singular on TCGplayer)
    "dp1_ja": 23973,        # "Space Time Creation" vs "DP1: Space-Time Creation"
    "adv4_ja": 24124,       # "Magma vs Aqua" casing
    "bwp_ja": 24342,        # BW-P Promotional cards
    "pcgp_ja": 24138,       # PCG-P Promotional cards
    "dpp_ja": 24137,        # DP-P Promotional cards
    "advp_ja": 24140,       # ADV-P Promotional cards
    "miscpp_ja": 24143,     # P Promotional cards
    "miscpt_ja": 24157,     # T Promotional cards
    "miscpj_ja": 24142,     # J Promotional cards
    "miscppp_ja": 24152,    # PPP Promotional cards
    "svp_ja": 23779,        # SV-P Promotional Cards
    "swshp_ja": 23876,      # S-P: Sword & Shield Promos
    "smp_ja": 23881,        # SM-P: Sun & Moon Promos
    "xyp_ja": 23908,        # XY-P: XY Promos
    "lp_ja": 24023,         # L-P: Legends Promos
    "mp_ja": 24423,         # M-P Promotional Cards
    "cp4_ja": 23972,        # CP4: Premium Champion Pack
    "sm3p_ja": 23694,       # SM3+: Shining Legends
    "sm1p_ja": 23880,       # sm1+: Enhanced Expansion Pack Sun & Moon
    "sar_ja": 23858,        # sA: Fire Starter Set V
    "saw_ja": 23862,        # sA: Water Starter Set V
    "wcs23_ja": 23802,      # WCS23: 2023 World Championships Yokohama Deck: Pikachu
    "l1hg_ja": 24025,       # L1: HeartGold Collection
}

# Sets we deliberately do not map (no single TCGplayer group, or TCGplayer
# groups them differently). They stay on the Scrydex fallback.
SKIPPED_SET_IDS = {
    "miscp_ja",   # Unnumbered Promos — spread across many TCGplayer groups
    "topsun_ja",  # Topsun — not a TCGplayer group
    "ipb_ja", "ips_ja",  # Intro Packs — energy/duplicate-heavy, name-only matching unsafe
}


def normalize_name(value: str | None) -> str:
    """Accent-, case-, punctuation-insensitive card name with the symbol forms
    both catalogs use folded to words ("δ"/"(Delta Species)" -> "delta",
    "☆"/"Star" -> "star", "♀"/"(Female)" -> "female")."""
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold()
    text = re.sub(r"\s+-\s+\S+/\S+\s*$", "", text)  # "Pikachu - 001/SV-P"
    text = text.replace("δ", " delta ").replace("(delta species)", " delta ")
    text = text.replace("☆", " star ").replace("♀", " female ").replace("♂", " male ")
    text = text.replace("(female)", " female ").replace("(male)", " male ")
    # TCGplayer's JP vintage spelling: "Giovanni's Nidoran F" / "Nidoran M".
    text = re.sub(r"\bnidoran f\b", "nidoran female", text)
    text = re.sub(r"\bnidoran m\b", "nidoran male", text)
    text = text.replace("pokemon", "pokemon").replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_set_name(value: str | None) -> str:
    raw = re.sub(r"^[A-Za-z0-9+\-]{1,6}: ", "", str(value or ""))  # "DP1: Space-Time Creation"
    text = normalize_name(raw)
    text = re.sub(r"^pokemon ", "", text)
    text = text.replace("promotional cards", "promos").replace("cards series", "series")
    return text.strip()


def extended(product: dict, name: str) -> str | None:
    for entry in product.get("extendedData") or []:
        if isinstance(entry, dict) and str(entry.get("name") or "").strip() == name:
            value = str(entry.get("value") or "").strip()
            return value or None
    return None


def load_groups(cache_dir: Path) -> dict[int, dict]:
    groups_path = cache_dir / "jp_groups.json"
    if not groups_path.exists():
        groups_path = cache_dir.parent / "jp_groups.json"
    payload = json.loads(groups_path.read_text(encoding="utf-8"))
    return {int(g["groupId"]): g for g in payload["results"]}


def load_group_products(cache_dir: Path, group_id: int) -> tuple[list[dict], dict[str, list[dict]]]:
    base = cache_dir / str(JP_CATEGORY_ID)
    products = json.loads((base / f"{group_id}_products.json").read_text(encoding="utf-8"))["results"]
    prices_raw = json.loads((base / f"{group_id}_prices.json").read_text(encoding="utf-8"))["results"]
    prices: dict[str, list[dict]] = collections.defaultdict(list)
    for row in prices_raw:
        prices[str(row.get("productId"))].append(row)
    return products, prices


def resolve_group(set_id: str, set_en_name: str | None, groups: dict[int, dict]) -> tuple[int | None, str]:
    if set_id in SKIPPED_SET_IDS:
        return None, "skipped"
    if set_id in SET_ID_TO_GROUP_ID:
        return SET_ID_TO_GROUP_ID[set_id], "alias"
    wanted = normalize_set_name(set_en_name)
    if not wanted:
        return None, "no-english-name"
    hits = [gid for gid, g in groups.items() if normalize_set_name(g["name"]) == wanted]
    if len(hits) == 1:
        return hits[0], "name"
    return None, ("ambiguous:" + ",".join(map(str, hits))) if hits else "no-group"


def match_cards(cards: list[dict], products: list[dict], claimed: set[str]) -> tuple[dict[str, dict], list[dict]]:
    """cards: our unmapped cards of one set; products: TCGplayer products of the
    resolved group. Returns ({card_id: match}, [unmatched rows])."""
    by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for product in products:
        if str(product["productId"]) in claimed:
            continue
        by_name[normalize_name(product["name"])].append(product)
    ours_by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for card in cards:
        ours_by_name[normalize_name(card["name"])].append(card)

    matches: dict[str, dict] = {}
    unmatched: list[dict] = []
    for name, ours in ours_by_name.items():
        theirs = by_name.get(name) or []
        if not theirs:
            for card in ours:
                unmatched.append({"cardId": card["id"], "name": card["name"], "reason": "no-name-match"})
            continue
        numbered = [p for p in theirs if product_number(p)]
        for card in ours:
            card_num = normalized_card_number(card.get("number"))
            candidates: list[dict]
            how: str
            if numbered and card_num:
                candidates = [p for p in numbered if card_numbers_match(card_num, product_number(p) or "")]
                how = "number+name"
            elif len(ours) == 1 and len(theirs) == 1:
                candidates, how = theirs, "name"
            else:
                key = (str(card.get("hp") or ""), normalize_name(card.get("rarity")))
                candidates = [
                    p for p in theirs
                    if (str(extended(p, "HP") or ""), normalize_name(extended(p, "Rarity"))) == key
                ]
                # the tie must break on OUR side too: two of our cards with the
                # same name+hp+rarity cannot be told apart either.
                twins = [
                    c for c in ours
                    if (str(c.get("hp") or ""), normalize_name(c.get("rarity"))) == key
                ]
                if len(twins) != 1:
                    candidates = []
                how = "name+hp+rarity"
            if len(candidates) != 1:
                unmatched.append({
                    "cardId": card["id"], "name": card["name"], "number": card.get("number"),
                    "reason": "ambiguous" if len(candidates) > 1 or len(theirs) > 1 else "no-match",
                    "candidates": [f'{p["productId"]}:{p["name"]}' for p in theirs[:6]],
                })
                continue
            product = candidates[0]
            matches[card["id"]] = {
                "productId": str(product["productId"]),
                "productName": product["name"],
                "matchedBy": how,
            }
    # a product matched by two of our cards is unsafe for both
    owners: dict[str, list[str]] = collections.defaultdict(list)
    for card_id, m in matches.items():
        owners[m["productId"]].append(card_id)
    for product_id, card_ids in owners.items():
        if len(card_ids) > 1:
            for card_id in card_ids:
                m = matches.pop(card_id)
                unmatched.append({"cardId": card_id, "name": m["productName"], "reason": f"product-shared:{product_id}"})
    return matches, unmatched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cards-json", required=True, help=(
        "JSON with {'cards': [{id,name,set_id,number,rarity,hp,payload_pids:[[variant,pid]],"
        "set_en_name}]} — every JP card of the catalog, mapped or not"))
    parser.add_argument("--cache-dir", required=True, help="TCGCSV crawl cache root (contains 85/<group>_products.json)")
    parser.add_argument("--out", required=True, help="backfill JSON to write")
    parser.add_argument("--report", help="markdown report path")
    args = parser.parse_args(argv)

    cache_dir = Path(args.cache_dir)
    dump = json.loads(Path(args.cards_json).read_text(encoding="utf-8"))
    cards = dump["cards"]
    groups = load_groups(cache_dir)

    claimed = {pid for card in cards for _label, pid in (card.get("payload_pids") or [])}
    unmapped = [c for c in cards if not c.get("payload_pids")]
    by_set: dict[str, list[dict]] = collections.defaultdict(list)
    for card in unmapped:
        by_set[card["set_id"]].append(card)

    backfill: dict[str, dict] = {
        "_readme": (
            "Card -> TCGplayer product ids for cards whose Scrydex payload carries none "
            "(JP vintage + promos). Generated by tools/build_tcgplayer_id_backfill.py; "
            "the TCGCSV sync uses these only when the payload has no product id and no "
            "manual override exists, and still number-verifies them where TCGplayer "
            "publishes a Number. Regenerate rather than hand-edit; put human fixes in "
            "tcgplayer_id_overrides.json."
        ),
    }
    set_rows: list[dict] = []
    all_unmatched: list[dict] = []
    for set_id, set_cards in sorted(by_set.items(), key=lambda kv: -len(kv[1])):
        set_en = set_cards[0].get("set_en_name")
        group_id, how = resolve_group(set_id, set_en, groups)
        row = {"setId": set_id, "setName": set_en or set_cards[0].get("set_name"), "cards": len(set_cards),
               "groupId": group_id, "groupName": groups[group_id]["name"] if group_id else None,
               "resolvedBy": how, "matched": 0, "unmatched": len(set_cards)}
        if group_id is None:
            set_rows.append(row)
            all_unmatched.extend({"cardId": c["id"], "name": c["name"], "setId": set_id, "reason": f"set:{how}"} for c in set_cards)
            continue
        products, prices = load_group_products(cache_dir, group_id)
        matches, unmatched = match_cards(set_cards, products, claimed)
        for card_id, m in matches.items():
            priced = [p for p in prices.get(m["productId"], []) if p.get("marketPrice")]
            m["groupId"] = group_id
            m["marketPrices"] = {p["subTypeName"]: p["marketPrice"] for p in priced}
            backfill[card_id] = m
        for u in unmatched:
            u["setId"] = set_id
        all_unmatched.extend(unmatched)
        row["matched"] = len(matches)
        row["unmatched"] = len(unmatched)
        set_rows.append(row)

    # Today's market prices are review context for the report, not sync input —
    # they would only go stale inside the shipped file.
    shipped = {k: ({kk: vv for kk, vv in v.items() if kk != "marketPrices"} if isinstance(v, dict) else v)
               for k, v in backfill.items()}
    Path(args.out).write_text(json.dumps(shipped, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    matched_total = len(backfill) - 1
    priced_total = sum(1 for k, v in backfill.items() if not k.startswith("_") and v.get("marketPrices"))
    print(f"unmapped JP cards: {len(unmapped)}  matched: {matched_total}  priced now: {priced_total}  unmatched: {len(all_unmatched)}")

    if args.report:
        lines = ["# TCGplayer id backfill report", "",
                 f"Unmapped JP cards: {len(unmapped)} · matched: {matched_total} · with a TCGplayer market price today: {priced_total} · left unmapped: {len(all_unmatched)}", "",
                 "## Per set", "", "| set | cards | TCGplayer group | resolved by | matched | unmatched |", "|---|---|---|---|---|---|"]
        for r in set_rows:
            lines.append(f"| {r['setId']} {r['setName']} | {r['cards']} | {r['groupId'] or ''} {r['groupName'] or ''} | {r['resolvedBy']} | {r['matched']} | {r['unmatched']} |")
        by_how = collections.Counter(v["matchedBy"] for k, v in backfill.items() if not k.startswith("_"))
        lines += ["", "## Match method", ""] + [f"- {k}: {v}" for k, v in by_how.most_common()]
        reasons = collections.Counter(u["reason"].split(":")[0] for u in all_unmatched)
        lines += ["", "## Unmatched reasons", ""] + [f"- {k}: {v}" for k, v in reasons.most_common()]
        lines += ["", "## Sample matches (name-only, vintage — the ones worth eyeballing)", "", "| card | our name | product | market |", "|---|---|---|---|"]
        shown = 0
        for card_id, m in backfill.items():
            if card_id.startswith("_") or m["matchedBy"] == "number+name":
                continue
            lines.append(f"| {card_id} | {next(c['name'] for c in cards if c['id']==card_id)} | {m['productId']} {m['productName']} | {m.get('marketPrices')} |")
            shown += 1
            if shown >= 80:
                break
        lines += ["", "## Unmatched cards (ambiguous ones list their candidates)", "", "| card | name | set | reason | candidates |", "|---|---|---|---|---|"]
        for u in all_unmatched:
            if u["reason"].startswith("set:"):
                continue
            lines.append(f"| {u['cardId']} | {u.get('name')} | {u.get('setId')} | {u['reason']} | {'; '.join(u.get('candidates') or [])} |")
        Path(args.report).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
