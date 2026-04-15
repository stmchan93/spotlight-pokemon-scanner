#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scrydex_adapter import map_scrydex_catalog_card, scrydex_credentials, scrydex_request_url  # noqa: E402
from scrydex_expansion_resolver import resolve_expansion_token  # noqa: E402
from raw_visual_dataset_paths import default_raw_footer_layout_query_cache_path  # noqa: E402

USER_AGENT = "Looty/0.1 (+https://local.looty.app)"


@dataclass(frozen=True)
class TruthKey:
    card_name: str
    collector_number: str
    set_code: str | None

    @property
    def key(self) -> str:
        return f"{self.card_name}|{self.collector_number}|{self.set_code or ''}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalized_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def normalized_set_token(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def title_similarity(lhs: str, rhs: str) -> float:
    left = normalized_title(lhs)
    right = normalized_title(rhs)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    if left in right or right in left:
        shorter = min(len(left), len(right))
        longer = max(len(left), len(right))
        return shorter / max(1, longer)
    left_tokens = set(re.findall(r"[a-z0-9]+", lhs.lower()))
    right_tokens = set(re.findall(r"[a-z0-9]+", rhs.lower()))
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def normalize_collector_number(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9/]+", "", str(value or "").upper())


def printed_number_query_value(value: str | None) -> str:
    text = str(value or "").strip().upper()
    text = re.sub(r"\s+", "", text)
    return re.sub(r"[^A-Z0-9/\-]+", "", text)


def collector_prefix(value: str | None) -> str:
    normalized = normalize_collector_number(value)
    if "/" in normalized:
        return normalized.split("/", 1)[0]
    return normalized


def stripped_number_variants(value: str | None) -> list[str]:
    normalized = collector_prefix(value)
    if not normalized:
        return []

    variants: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        cleaned = candidate.strip().upper()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            variants.append(cleaned)

    add(normalized)

    trailing_digits_match = re.search(r"(\d+)$", normalized)
    if trailing_digits_match:
        trailing = trailing_digits_match.group(1)
        add(trailing)
        stripped_trailing = trailing.lstrip("0") or "0"
        add(stripped_trailing)
        prefix = normalized[: -len(trailing)]
        if prefix:
            add(f"{prefix}{stripped_trailing}")

    stripped_normalized = normalized.lstrip("0") or "0"
    add(stripped_normalized)
    return variants


def build_card_queries(
    truth: TruthKey,
    *,
    resolved_expansion: dict[str, Any] | None,
) -> list[str]:
    queries: list[str] = []
    seen: set[str] = set()

    def add(query: str) -> None:
        normalized = query.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            queries.append(normalized)

    printed_number = printed_number_query_value(truth.collector_number)
    number_variants = stripped_number_variants(truth.collector_number)
    name = truth.card_name.replace('"', '\\"')
    set_code = str(truth.set_code or "").strip()
    expansion_id = str((resolved_expansion or {}).get("id") or "").strip()

    if expansion_id:
        if printed_number:
            add(f'printed_number:"{printed_number}" expansion.id:{expansion_id}')
        for number_variant in number_variants:
            add(f'number:"{number_variant}" expansion.id:{expansion_id}')
            add(f'name:"{name}" number:"{number_variant}" expansion.id:{expansion_id}')
        if printed_number:
            add(f'name:"{name}" printed_number:"{printed_number}" expansion.id:{expansion_id}')
        add(f'name:"{name}" expansion.id:{expansion_id}')

    if set_code and printed_number:
        add(f'printed_number:"{printed_number}" expansion.code:{set_code}')
    if set_code:
        for number_variant in number_variants:
            add(f'number:"{number_variant}" expansion.code:{set_code}')
            add(f'name:"{name}" number:"{number_variant}" expansion.code:{set_code}')
        if printed_number:
            add(f'name:"{name}" printed_number:"{printed_number}" expansion.code:{set_code}')
        add(f'name:"{name}" expansion.code:{set_code}')

    for number_variant in number_variants:
        add(f'name:"{name}" number:"{number_variant}"')
    add(f'name:"{name}"')
    return queries


def candidate_display_number(card: dict[str, Any]) -> str:
    return str(card.get("number") or "")


def set_match_score(expected: str | None, card: dict[str, Any]) -> tuple[int, str | None]:
    token = normalized_set_token(expected)
    if not token:
        return 0, None

    ptcgo = normalized_set_token(card.get("set_ptcgo_code") or card.get("setPtcgoCode"))
    set_id = normalized_set_token(card.get("set_id") or card.get("setID"))
    set_name = normalized_set_token(card.get("set_name") or card.get("setName"))
    set_series = normalized_set_token(card.get("set_series") or card.get("setSeries"))
    card_id = normalized_set_token(card.get("id"))

    checks = [
        ("ptcgoCode", ptcgo),
        ("set.id", set_id),
        ("set.name", set_name),
        ("set.series", set_series),
        ("card.id", card_id),
    ]
    for label, value in checks:
        if token and value and (token == value or token in value or value in token):
            return 25, label
    return 0, None


def card_mapping_score(truth: TruthKey, card: dict[str, Any]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []

    candidate_name = str(card.get("name") or "")
    similarity = title_similarity(truth.card_name, candidate_name)
    if similarity == 1.0:
        score += 90
        reasons.append("exact_name")
    elif similarity >= 0.8:
        score += 70
        reasons.append("strong_name_match")
    elif similarity >= 0.5:
        score += 40
        reasons.append("partial_name_match")

    expected_number = normalize_collector_number(truth.collector_number)
    candidate_number = normalize_collector_number(candidate_display_number(card))
    if expected_number and candidate_number == expected_number:
        score += 120
        reasons.append("exact_collector")
    else:
        expected_prefix = collector_prefix(truth.collector_number)
        candidate_prefix = collector_prefix(candidate_display_number(card))
        if expected_prefix and candidate_prefix and expected_prefix == candidate_prefix:
            score += 60
            reasons.append("collector_prefix_match")

    set_score, set_reason = set_match_score(truth.set_code, card)
    if set_score:
        score += set_score
        reasons.append(f"set_match:{set_reason}")

    return score, reasons


def api_request(url: str, api_key: str | None) -> dict[str, Any]:
    request = Request(url)
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    credentials = scrydex_credentials()
    if credentials is None:
        raise SystemExit("Scrydex credentials are required to build the visual seed manifest.")
    scrydex_api_key, team_id = credentials
    request.add_header("X-Api-Key", scrydex_api_key)
    request.add_header("X-Team-ID", team_id)
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def search_cards(query: str, api_key: str | None, page_size: int = 10, *, japanese: bool = False) -> list[dict[str, Any]]:
    del api_key
    params = urlencode({"q": query, "page_size": page_size})
    path = "/pokemon/v1/ja/cards" if japanese else "/pokemon/v1/cards"
    payload = api_request(scrydex_request_url(path, q=query, page_size=str(page_size)), None)
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [map_scrydex_catalog_card(item) for item in data if isinstance(item, dict)]


def truth_from_fixture(directory: Path) -> TruthKey:
    data = json.loads(directory.joinpath("truth.json").read_text())
    return TruthKey(
        card_name=str(data["cardName"]).strip(),
        collector_number=str(data["collectorNumber"]).strip(),
        set_code=(str(data.get("setCode")).strip() or None) if data.get("setCode") is not None else None,
    )


def unique_truths(fixture_root: Path) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for directory in sorted(fixture_root.iterdir()):
        if not directory.is_dir():
            continue
        if not directory.joinpath("truth.json").exists():
            continue
        if not directory.joinpath("source_scan.jpg").exists():
            continue
        truth = truth_from_fixture(directory)
        entry = grouped.setdefault(
            truth.key,
            {
                "truth": truth,
                "fixtures": [],
            },
        )
        entry["fixtures"].append(directory.name)
    return grouped


def candidate_summary(card: dict[str, Any], score: int, reasons: list[str]) -> dict[str, Any]:
    return {
        "providerCardId": card.get("id"),
        "providerName": card.get("name"),
        "providerCollectorNumber": candidate_display_number(card),
        "providerSetId": card.get("set_id") or card.get("setID"),
        "providerSetPtcgoCode": card.get("set_ptcgo_code") or card.get("setPtcgoCode"),
        "providerSetName": card.get("set_name") or card.get("setName"),
        "referenceImageUrl": card.get("reference_image_url") or card.get("imageURL"),
        "sourceProvider": card.get("source") or "scrydex",
        "mappingScore": score,
        "mappingReasons": reasons,
    }


def choose_mapping(
    truth: TruthKey,
    api_key: str | None,
    query_cache: dict[str, list[dict[str, Any]]],
    *,
    allow_live_expansion_lookup: bool = False,
    allow_legacy_set_code_queries: bool = True,
    expansion_snapshot_path: Path | None = None,
) -> dict[str, Any]:
    expansion_resolution = resolve_expansion_token(
        truth.set_code,
        query_cache,
        snapshot_path=expansion_snapshot_path,
        allow_live_lookup=allow_live_expansion_lookup,
    )
    queries = build_card_queries(truth, resolved_expansion=expansion_resolution.get("selected"))
    if not allow_legacy_set_code_queries:
        queries = [query for query in queries if "expansion.code:" not in query]

    candidates_by_id: dict[str, dict[str, Any]] = {}
    attempts: list[dict[str, Any]] = list(expansion_resolution.get("attempts") or [])
    for query in queries:
        for lane in ("global", "ja"):
            cache_key = f"{lane}:{query}"
            cards = query_cache.get(cache_key)
            if cards is None:
                try:
                    cards = search_cards(query, api_key, page_size=12, japanese=(lane == "ja"))
                except Exception as exc:  # noqa: BLE001
                    cards = []
                    attempts.append({"query": f"{lane}:{query}", "resultCount": 0, "error": str(exc)})
                    query_cache[cache_key] = cards
                    continue
                query_cache[cache_key] = cards
            attempts.append({"query": f"{lane}:{query}", "resultCount": len(cards)})
            for card in cards:
                card_id = str(card.get("id") or "")
                if card_id:
                    candidates_by_id[card_id] = card

    scored: list[tuple[int, dict[str, Any], list[str]]] = []
    for card in candidates_by_id.values():
        score, reasons = card_mapping_score(truth, card)
        scored.append((score, card, reasons))
    scored.sort(
        key=lambda item: (
            -item[0],
            str(item[1].get("name") or ""),
            candidate_display_number(item[1]),
        )
    )

    top_candidates = [candidate_summary(card, score, reasons) for score, card, reasons in scored[:5]]
    selected = top_candidates[0] if top_candidates else None
    second_score = top_candidates[1]["mappingScore"] if len(top_candidates) > 1 else None

    provider_supported = False
    mapping_confidence = "unsupported"
    mapping_reason = "No provider candidate was found."
    if selected is not None:
        top_score = int(selected["mappingScore"])
        if top_score >= 210:
            provider_supported = True
            mapping_confidence = "high"
            mapping_reason = "Exact or near-exact card name and collector number match."
        elif top_score >= 170 and (second_score is None or top_score - int(second_score) >= 25):
            provider_supported = True
            mapping_confidence = "medium"
            mapping_reason = "Strong best candidate with clear margin."
        else:
            mapping_confidence = "low"
            mapping_reason = "Candidates were ambiguous or weak; manual review recommended."

    return {
        "providerSupported": provider_supported,
        "mappingConfidence": mapping_confidence,
        "mappingReason": mapping_reason,
        "attempts": attempts,
        "resolvedExpansion": expansion_resolution.get("selected"),
        "expansionResolution": expansion_resolution,
        "candidateSummaries": top_candidates,
        "selected": selected,
    }


def build_manifest(
    fixture_root: Path,
    api_key: str | None,
    query_cache_path: Path,
) -> dict[str, Any]:
    grouped = unique_truths(fixture_root)
    if query_cache_path.exists():
        query_cache = json.loads(query_cache_path.read_text())
    else:
        query_cache = {}
    entries: list[dict[str, Any]] = []
    total = len(grouped)
    for index, grouped_entry in enumerate(grouped.values(), start=1):
        truth: TruthKey = grouped_entry["truth"]
        fixtures: list[str] = grouped_entry["fixtures"]
        print(f"[{index}/{total}] Mapping {truth.card_name} | {truth.collector_number} | {truth.set_code or '-'}")
        mapping = choose_mapping(truth, api_key, query_cache)
        selected = mapping["selected"] or {}
        entries.append(
            {
                "truthKey": truth.key,
                "cardName": truth.card_name,
                "collectorNumber": truth.collector_number,
                "expectedSetCode": truth.set_code,
                "fixtures": fixtures,
                "providerSupported": mapping["providerSupported"],
                "providerCardId": selected.get("providerCardId"),
                "providerName": selected.get("providerName"),
                "providerCollectorNumber": selected.get("providerCollectorNumber"),
                "providerSetId": selected.get("providerSetId"),
                "providerSetPtcgoCode": selected.get("providerSetPtcgoCode"),
                "providerSetName": selected.get("providerSetName"),
                "referenceImageUrl": selected.get("referenceImageUrl"),
                "sourceProvider": selected.get("sourceProvider") or "scrydex",
                "mappingConfidence": mapping["mappingConfidence"],
                "mappingReason": mapping["mappingReason"],
                "resolvedExpansion": mapping.get("resolvedExpansion"),
                "attempts": mapping["attempts"],
                "candidateSummaries": mapping["candidateSummaries"],
            }
        )

    entries.sort(key=lambda item: (item["cardName"], item["collectorNumber"], item.get("expectedSetCode") or ""))
    query_cache_path.parent.mkdir(parents=True, exist_ok=True)
    query_cache_path.write_text(json.dumps(query_cache, indent=2) + "\n")
    return {
        "generatedAt": utc_now_iso(),
        "provider": "scrydex",
        "entryCount": len(entries),
        "supportedEntryCount": sum(1 for entry in entries if entry["providerSupported"]),
        "unsupportedEntryCount": sum(1 for entry in entries if not entry["providerSupported"]),
        "entries": entries,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build provider reference mappings for the raw visual POC seed corpus.")
    parser.add_argument(
        "--fixture-root",
        type=Path,
        default=Path("qa/raw-footer-layout-check"),
        help="Path to the raw footer layout check fixture root.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa/raw-footer-layout-check/provider_reference_manifest.json"),
        help="Path to write the provider reference manifest JSON.",
    )
    parser.add_argument(
        "--query-cache",
        type=Path,
        default=default_raw_footer_layout_query_cache_path(),
        help="Path to cache provider search query results.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fixture_root = args.fixture_root.resolve()
    output_path = args.output.resolve()
    query_cache_path = args.query_cache.resolve()
    api_key = None

    manifest = build_manifest(fixture_root, api_key, query_cache_path)
    output_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"Wrote provider reference manifest to {output_path}")
    print(
        "Supported:",
        manifest["supportedEntryCount"],
        "Unsupported:",
        manifest["unsupportedEntryCount"],
        "Total:",
        manifest["entryCount"],
    )
    low_confidence = [
        entry["truthKey"] for entry in manifest["entries"]
        if entry["providerSupported"] and entry["mappingConfidence"] != "high"
    ]
    if low_confidence:
        print("Supported but non-high-confidence mappings:")
        for truth_key in low_confidence:
            print(f"  - {truth_key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
