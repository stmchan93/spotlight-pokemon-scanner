"""Phase 0 of the One Piece spike: does our Scrydex plan actually serve One Piece,
and do GRADED prices come back populated?

Everything downstream in docs/one-piece-tcg-spike-2026-08-13.md assumes those two
things. This answers them for a handful of credits instead of an evening.

Deliberately frugal — Scrydex bills per request and the catalog is otherwise a
deliberately frozen mirror:
  * 1 request for the expansion list
  * 1 request for a single expansion's cards, with prices included

Credentials are read from the MAIN tree's backend/.env rather than copied into
this worktree; the key never lands on this branch.

    python3 tools/probe_scrydex_onepiece.py [--expansion OP01] [--save-fixture]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAIN_TREE_ENV = Path("/Users/stephenchan/Code/spotlight/backend/.env")
BASE_URL = "https://api.scrydex.com"
USER_AGENT = "SpotlightBackend/1.0 (one-piece spike probe)"
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "backend" / "tests" / "fixtures"


def load_credentials() -> tuple[str, str]:
    api_key = os.environ.get("SCRYDEX_API_KEY", "").strip()
    team_id = os.environ.get("SCRYDEX_TEAM_ID", "").strip()
    if api_key and team_id:
        return api_key, team_id

    if not MAIN_TREE_ENV.is_file():
        raise SystemExit(f"No credentials in env and {MAIN_TREE_ENV} not found")
    for line in MAIN_TREE_ENV.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if key.strip() == "SCRYDEX_API_KEY" and not api_key:
            api_key = value
        elif key.strip() == "SCRYDEX_TEAM_ID" and not team_id:
            team_id = value
    if not api_key or not team_id:
        raise SystemExit("SCRYDEX_API_KEY / SCRYDEX_TEAM_ID missing")
    return api_key, team_id


def request(path: str, api_key: str, team_id: str, **params: str) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("X-Api-Key", api_key)
    req.add_header("X-Team-ID", team_id)
    print(f"  → GET {url}")
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def summarize_prices(prices: list[dict[str, Any]]) -> dict[str, Any]:
    """The whole question: are graded prices present, and in the shape our
    existing Pokémon resolver already understands?"""
    raw = [p for p in prices if str(p.get("type") or "").lower() == "raw"]
    graded = [p for p in prices if str(p.get("type") or "").lower() == "graded"]
    companies = sorted({str(p.get("company") or "") for p in graded if p.get("company")})
    grades = sorted({str(p.get("grade") or "") for p in graded if p.get("grade")})
    return {
        "rawCount": len(raw),
        "gradedCount": len(graded),
        "gradingCompanies": companies,
        "grades": grades[:12],
        "conditions": sorted({str(p.get("condition") or "") for p in raw if p.get("condition")}),
        "hasIsPerfect": any("is_perfect" in p for p in prices),
        "hasIsSigned": any("is_signed" in p for p in prices),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expansion", default=None, help="Expansion id, e.g. OP01")
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--save-fixture", action="store_true")
    args = parser.parse_args()

    api_key, team_id = load_credentials()
    print("== 1. Does the plan serve One Piece at all? ==")
    expansions_payload = request("/onepiece/v1/expansions", api_key, team_id)
    expansions = expansions_payload.get("data") or []
    print(f"  expansions returned: {len(expansions)}")
    if not expansions:
        print("  !! No expansions — the plan may not include One Piece.")
        return 1
    for expansion in expansions[:5]:
        print(f"    - {expansion.get('id')}: {expansion.get('name')} ({expansion.get('total')} cards)")

    expansion_id = args.expansion or str(expansions[0].get("id") or "").strip()

    print(f"\n== 2. Cards + prices for {expansion_id} ==")
    cards_payload = request(
        f"/onepiece/v1/expansions/{expansion_id}/cards",
        api_key,
        team_id,
        include="prices",
        page_size=str(args.page_size),
    )
    cards = cards_payload.get("data") or []
    print(f"  cards returned: {len(cards)}")
    if not cards:
        print("  !! No cards came back.")
        return 1

    priced = 0
    graded_seen = 0
    sample: dict[str, Any] | None = None
    for card in cards:
        variants = card.get("variants") or []
        prices = [p for variant in variants for p in (variant.get("prices") or [])]
        if not prices:
            continue
        priced += 1
        summary = summarize_prices(prices)
        if summary["gradedCount"] > 0:
            graded_seen += 1
            if sample is None:
                sample = {"card": card, "summary": summary}

    first = cards[0]
    print(f"\n  sample card: {first.get('id')} — {first.get('name')} ({first.get('rarity')})")
    print(f"  fields present: {sorted(first.keys())}")
    print(f"\n  cards with any price: {priced}/{len(cards)}")
    print(f"  cards with GRADED prices: {graded_seen}/{len(cards)}")
    if sample:
        print(f"  graded shape on {sample['card'].get('id')}:")
        print("    " + json.dumps(sample["summary"], indent=2).replace("\n", "\n    "))
    else:
        print("  !! No graded prices on this expansion — graded pricing may need")
        print("     a different include/param, or may not be covered for One Piece.")

    if args.save_fixture:
        FIXTURE_PATH.mkdir(parents=True, exist_ok=True)
        target = FIXTURE_PATH / "scrydex_onepiece_cards_sample.json"
        target.write_text(json.dumps({"data": cards[:5]}, indent=2))
        print(f"\n  fixture written: {target}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
