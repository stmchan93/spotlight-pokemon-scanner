from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scrydex_adapter import scrydex_credentials, scrydex_request_url  # noqa: E402
from raw_visual_dataset_paths import default_raw_visual_train_expansion_snapshot_path  # noqa: E402

USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
ALIAS_PATH = Path(__file__).with_name("scrydex_expansion_aliases.json")


def _normalized_set_token(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _quote_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _load_aliases() -> dict[str, dict[str, Any]]:
    if not ALIAS_PATH.exists():
        return {}
    payload = json.loads(ALIAS_PATH.read_text())
    if not isinstance(payload, dict):
        return {}
    aliases: dict[str, dict[str, Any]] = {}
    for key, value in payload.items():
        if isinstance(key, str) and isinstance(value, dict):
            aliases[key.strip().upper()] = dict(value)
    return aliases


SCRYDEX_EXPANSION_ALIASES = _load_aliases()


def map_scrydex_expansion(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(payload.get("id") or ""),
        "code": str(payload.get("code") or ""),
        "name": str(payload.get("name") or ""),
        "series": str(payload.get("series") or ""),
        "language": str(payload.get("language") or ""),
        "language_code": str(payload.get("language_code") or ""),
    }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _expansion_request(path: str, **params: str) -> dict[str, Any]:
    credentials = scrydex_credentials()
    if credentials is None:
        raise SystemExit("Scrydex credentials are required to resolve expansions.")
    api_key, team_id = credentials

    request = Request(scrydex_request_url(path, **params))
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("X-Api-Key", api_key)
    request.add_header("X-Team-ID", team_id)

    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def search_expansions(query: str, page_size: int = 10) -> list[dict[str, Any]]:
    payload = _expansion_request("/pokemon/v1/expansions", q=query, page_size=str(page_size))
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [map_scrydex_expansion(item) for item in data if isinstance(item, dict)]


def fetch_all_expansions(page_size: int = 100) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    page = 1
    while True:
        payload = _expansion_request(
            "/pokemon/v1/expansions",
            page=str(page),
            page_size=str(page_size),
        )
        data = payload.get("data")
        if not isinstance(data, list) or not data:
            break
        entries.extend(map_scrydex_expansion(item) for item in data if isinstance(item, dict))
        if len(data) < int(payload.get("page_size") or page_size):
            break
        page += 1
    deduped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if entry_id:
            deduped[entry_id] = entry
    return [deduped[key] for key in sorted(deduped.keys())]


def build_expansion_snapshot_payload(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "generatedAt": utc_now_iso(),
        "source": "scrydex",
        "entryCount": len(entries),
        "entries": entries,
    }


def write_expansion_snapshot(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_expansion_snapshot_payload(entries)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def load_expansion_snapshot(path: Path | None = None) -> list[dict[str, Any]]:
    snapshot_path = (path or default_raw_visual_train_expansion_snapshot_path()).expanduser()
    if not snapshot_path.exists():
        return []
    payload = json.loads(snapshot_path.read_text())
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    return [dict(entry) for entry in entries if isinstance(entry, dict)]


def _snapshot_candidates(local_token: str, snapshot_entries: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    token = str(local_token or "").strip()
    token_upper = token.upper()
    alias = SCRYDEX_EXPANSION_ALIASES.get(token_upper)
    attempts: list[dict[str, Any]] = []
    candidates_by_id: dict[str, dict[str, Any]] = {}

    def add_candidates(label: str, predicate) -> None:
        matched = [entry for entry in snapshot_entries if predicate(entry)]
        attempts.append({"query": f"snapshot:{label}", "resultCount": len(matched)})
        for entry in matched:
            entry_id = str(entry.get("id") or "")
            if entry_id:
                candidates_by_id[entry_id] = entry

    if alias:
        alias_id = str(alias.get("id") or "").strip()
        alias_code = str(alias.get("code") or "").strip()
        alias_name = str(alias.get("name") or "").strip()
        if alias_id:
            add_candidates(f"id:{alias_id}", lambda entry, alias_id=alias_id: str(entry.get("id") or "") == alias_id)
        if alias_code:
            add_candidates(
                f'code:"{alias_code}"',
                lambda entry, alias_code=alias_code: str(entry.get("code") or "") == alias_code,
            )
        if alias_name:
            add_candidates(
                f'name:"{alias_name}"',
                lambda entry, alias_name=alias_name: str(entry.get("name") or "") == alias_name,
            )

    add_candidates(f"id:{token.lower()}", lambda entry, token=token: str(entry.get("id") or "").lower() == token.lower())
    add_candidates(f'code:"{token}"', lambda entry, token=token: str(entry.get("code") or "") == token)
    add_candidates(f'name:"{token}"', lambda entry, token=token: str(entry.get("name") or "") == token)
    return candidates_by_id, attempts


def expansion_resolution_queries(local_token: str) -> list[str]:
    token = str(local_token or "").strip()
    if not token:
        return []

    queries: list[str] = []
    seen: set[str] = set()

    def add(query: str) -> None:
        normalized = query.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            queries.append(normalized)

    alias = SCRYDEX_EXPANSION_ALIASES.get(token.upper())
    if alias:
        alias_id = str(alias.get("id") or "").strip()
        alias_code = str(alias.get("code") or "").strip()
        alias_name = str(alias.get("name") or "").strip()
        if alias_id:
            add(f"id:{alias_id}")
        if alias_code:
            add(f'code:"{_quote_query_value(alias_code)}"')
        if alias_name:
            add(f'name:"{_quote_query_value(alias_name)}"')

    add(f"id:{token.lower()}")
    add(f'code:"{_quote_query_value(token)}"')
    add(f'name:"{_quote_query_value(token)}"')
    return queries


def _expansion_score(local_token: str, expansion: dict[str, Any]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    token_norm = _normalized_set_token(local_token)
    alias = SCRYDEX_EXPANSION_ALIASES.get(str(local_token or "").strip().upper())

    expansion_id = _normalized_set_token(expansion.get("id"))
    expansion_code = _normalized_set_token(expansion.get("code"))
    expansion_name = _normalized_set_token(expansion.get("name"))

    if alias:
        alias_id = _normalized_set_token(alias.get("id"))
        alias_code = _normalized_set_token(alias.get("code"))
        alias_name = _normalized_set_token(alias.get("name"))
        if alias_id and expansion_id == alias_id:
            score += 300
            reasons.append("alias_id")
        if alias_code and expansion_code == alias_code:
            score += 160
            reasons.append("alias_code")
        if alias_name and expansion_name == alias_name:
            score += 140
            reasons.append("alias_name")

    if token_norm and expansion_id == token_norm:
        score += 220
        reasons.append("exact_id")
    if token_norm and expansion_code == token_norm:
        score += 200
        reasons.append("exact_code")
    if token_norm and expansion_name == token_norm:
        score += 120
        reasons.append("exact_name")

    if str(expansion.get("language_code") or "").upper() == "EN":
        score += 5
        reasons.append("english")

    return score, reasons


def resolve_expansion_token(
    local_token: str | None,
    query_cache: dict[str, list[dict[str, Any]]],
    *,
    snapshot_path: Path | None = None,
    allow_live_lookup: bool = False,
) -> dict[str, Any]:
    token = str(local_token or "").strip()
    if not token:
        return {
            "selected": None,
            "attempts": [],
            "candidateSummaries": [],
            "resolution": "missing_token",
        }

    snapshot_entries = load_expansion_snapshot(snapshot_path)
    candidates_by_id, attempts = _snapshot_candidates(token, snapshot_entries)

    if not candidates_by_id and allow_live_lookup:
        for query in expansion_resolution_queries(token):
            cache_key = f"expansion:{query}"
            expansions = query_cache.get(cache_key)
            if expansions is None:
                try:
                    expansions = search_expansions(query)
                except Exception as exc:  # noqa: BLE001
                    expansions = []
                    attempts.append({"query": query, "resultCount": 0, "error": str(exc)})
                    query_cache[cache_key] = expansions
                    continue
                query_cache[cache_key] = expansions
            attempts.append({"query": query, "resultCount": len(expansions)})
            for expansion in expansions:
                expansion_id = str(expansion.get("id") or "")
                if expansion_id:
                    candidates_by_id[expansion_id] = expansion

    scored: list[tuple[int, dict[str, Any], list[str]]] = []
    for expansion in candidates_by_id.values():
        score, reasons = _expansion_score(token, expansion)
        scored.append((score, expansion, reasons))
    scored.sort(key=lambda item: (-item[0], str(item[1].get("id") or ""), str(item[1].get("code") or "")))

    candidate_summaries = [
        {
            "id": expansion.get("id"),
            "code": expansion.get("code"),
            "name": expansion.get("name"),
            "series": expansion.get("series"),
            "languageCode": expansion.get("language_code"),
            "score": score,
            "reasons": reasons,
        }
        for score, expansion, reasons in scored[:5]
    ]

    selected = None
    resolution = "unresolved"
    if scored:
        top_score, top_expansion, _ = scored[0]
        second_score = scored[1][0] if len(scored) > 1 else None
        if top_score > 0 and (second_score is None or top_score > second_score):
            selected = top_expansion
            resolution = "resolved"
        elif top_score > 0:
            resolution = "ambiguous"

    return {
        "selected": selected,
        "attempts": attempts,
        "candidateSummaries": candidate_summaries,
        "resolution": resolution,
    }
