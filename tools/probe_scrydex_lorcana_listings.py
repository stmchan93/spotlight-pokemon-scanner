"""Does Scrydex serve sold LISTINGS for Lorcana?

Lorcana is the one non-Pokémon game with real GRADED pricing (AOTV-224 PSA 10
Holofoil sits at $140 market in our synced catalog), which makes it the only
game where the sold-comps drawer would be offered under a lane that actually
has data. So `has_listings` for Lorcana is a real product decision, not a
formality — and it was set to False on the "no evidence" default rather than on
a measurement.

This spends exactly ONE request to settle it. Not a loop, not a sweep: one
card, the broadest possible query.

Why AOTV-224 and why no filters:
  * AOTV-224 is the highest-signal card available — a $140 PSA 10. If ANY
    Lorcana card has sold comps, a graded chase card does.
  * No `company`/`grade` filter, so raw sales count as evidence too. A filtered
    zero would be ambiguous ("no PSA 10 sales" vs "no listings endpoint");
    an unfiltered zero is not.

A zero here is not proof the endpoint is empty forever, only that the best
candidate we have returns nothing — which is the same standard One Piece was
measured against, and enough to keep the drawer hidden.

Credentials come from the MAIN tree's backend/.env so no key lands on this
branch.

    python3 tools/probe_scrydex_lorcana_listings.py
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAIN_TREE_ENV = Path("/Users/stephenchan/Code/spotlight/backend/.env")
BASE_URL = "https://api.scrydex.com"
USER_AGENT = "SpotlightBackend/1.0 (lorcana listings probe)"

# A real id from backend/data/lorcana_poc.sqlite with a populated PSA 10 row.
DEFAULT_CARD_ID = "AOTV-224"


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


def request(path: str, api_key: str, team_id: str, **params: str) -> tuple[int, Any]:
    url = f"{BASE_URL}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("X-Api-Key", api_key)
    req.add_header("X-Team-ID", team_id)
    print(f"  -> GET {url}")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return error.code, body


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--card-id", default=DEFAULT_CARD_ID)
    args = parser.parse_args()

    api_key, team_id = load_credentials()

    print(f"== Lorcana listings for {args.card_id} (ONE request) ==")
    status, payload = request(
        f"/lorcana/v1/cards/{args.card_id}/listings",
        api_key,
        team_id,
        source="ebay",
        page_size="25",
    )
    print(f"  HTTP {status}")
    if not isinstance(payload, dict):
        print(f"  body: {str(payload)[:600]}")
        print("\nVERDICT: has_listings = False (endpoint did not serve Lorcana)")
        return 0

    data = payload.get("data")
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = (
            data.get("listings")
            or data.get("results")
            or data.get("transactions")
            or []
        )
    else:
        rows = []

    print(f"  top-level keys: {sorted(payload)}")
    print(f"  rows: {len(rows)}")
    for row in rows[:3]:
        print(f"    - {json.dumps(row)[:220]}")

    print(
        "\nVERDICT: has_listings = "
        + ("True" if rows else "False")
        + f" ({len(rows)} sold rows for a $140 PSA 10)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
