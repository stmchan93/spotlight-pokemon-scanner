"""Does Scrydex carry NON-ENGLISH catalogs for the new games?

The four POC syncs (onepiece / lorcana / riftbound / gundam) all came back
100% `language_code: EN` with NO language filter applied, so either Scrydex
has no JP data for these games or it hides it somewhere the plain
`/{segment}/v1/cards` walk never reaches. The product call is "if there is
Japanese One Piece we should allow it", so this settles which of the two it
is — per game, with the smallest spend that is still unambiguous.

Three requests per game, page_size=1:
  1. `/{segment}/v1/ja/cards`            — a Pokémon-style per-language
     sub-path. 404 = the path shape does not exist for this game.
  2. `/{segment}/v1/cards?q=language_code:JA` — language as a field filter,
     the shape these games actually store language in.
  3. `/{segment}/v1/expansions?q=language_code:JA` — JP expansions that might
     exist even where card queries are unindexed.

A zero across all three is a strong "EN-only on Scrydex today" — the same
standard the One Piece graded probe used. `totalCount`/`total` in the page
envelope is the verdict, not the single row.

Credentials come from the MAIN tree's backend/.env so no key lands on this
branch.

    python3 tools/probe_scrydex_game_languages.py [--games onepiece,gundam]
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAIN_TREE_ENV = Path("/Users/stephenchan/Code/spotlight/backend/.env")
BASE_URL = "https://api.scrydex.com"
USER_AGENT = "SpotlightBackend/1.0 (game language probe)"

GAME_SEGMENTS = {
    "onepiece": "onepiece",
    "lorcana": "lorcana",
    "riftbound": "riftbound",
    "gundam": "gundam",
}


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


def describe(status: int, payload: Any) -> tuple[int | None, str]:
    """(count, summary) for one probe response. count=None means unreadable."""
    if status != 200:
        return None, f"HTTP {status}: {str(payload)[:160]}"
    if not isinstance(payload, dict):
        return None, f"HTTP 200 non-dict body: {str(payload)[:160]}"
    count = payload.get("totalCount", payload.get("total"))
    data = payload.get("data")
    rows = data if isinstance(data, list) else []
    if count is None:
        count = len(rows)
    sample = ""
    if rows:
        first = rows[0] if isinstance(rows[0], dict) else {}
        sample = (
            f" first={first.get('id')!r}"
            f" lang={first.get('language_code') or first.get('language')!r}"
            f" name={str(first.get('name'))[:40]!r}"
        )
    return int(count), f"HTTP 200 count={count}{sample}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", default="onepiece,lorcana,riftbound,gundam")
    args = parser.parse_args()

    api_key, team_id = load_credentials()
    verdicts: dict[str, str] = {}

    for game in [g.strip() for g in args.games.split(",") if g.strip()]:
        segment = GAME_SEGMENTS[game]
        print(f"\n== {game} ==")

        counts: list[int | None] = []

        status, payload = request(
            f"/{segment}/v1/ja/cards", api_key, team_id, page_size="1"
        )
        count, summary = describe(status, payload)
        counts.append(count)
        print(f"  ja sub-path:        {summary}")

        status, payload = request(
            f"/{segment}/v1/cards",
            api_key,
            team_id,
            q="language_code:JA",
            page_size="1",
        )
        count, summary = describe(status, payload)
        counts.append(count)
        print(f"  cards lang filter:  {summary}")

        status, payload = request(
            f"/{segment}/v1/expansions",
            api_key,
            team_id,
            q="language_code:JA",
            page_size="1",
        )
        count, summary = describe(status, payload)
        counts.append(count)
        print(f"  expansions filter:  {summary}")

        positives = [c for c in counts if c]
        verdicts[game] = (
            f"JAPANESE PRESENT ({max(positives)} rows on the best probe)"
            if positives
            else "EN-only on Scrydex today (all three probes empty/404)"
        )

    print("\n== VERDICTS ==")
    for game, verdict in verdicts.items():
        print(f"  {game}: {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
