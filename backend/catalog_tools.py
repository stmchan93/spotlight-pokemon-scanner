from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import re
import sqlite3
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

METADATA_EMBEDDING_DIMENSION = 128
VISION_EMBEDDING_DIMENSION = 768
MATCHER_VERSION = "hybrid-vision-lsh-v2"
VISION_MODEL_ID = "apple-vision-featureprint-v1"
VISION_MODEL_FAMILY = "apple-vision"
METADATA_MODEL_ID = "metadata-hash-v1"
METADATA_MODEL_FAMILY = "prototype-hash"
CARD_REFERENCE_ROLE = "reference_front"
DEFAULT_VISUAL_RETRIEVAL = 0.35
ANN_TABLE_COUNT = 4
ANN_TABLE_BITS = 8
ANN_VISUAL_TARGET = 96
ANN_METADATA_TARGET = 48
LOW_TRUST_CUSTOM_CARD_ID_PATTERN = re.compile(r"^me\d", re.IGNORECASE)
SLAB_GRADER_PSA = "PSA"
RAW_PRICING_MODE = "raw_snapshot"
PSA_GRADE_PRICING_MODE = "psa_grade_estimate"
DEFAULT_PRICING_FRESHNESS_HOURS = 24
DEFAULT_GRADE_CURVE = {
    "10": 1.00,
    "9": 0.60,
    "8": 0.40,
    "7": 0.28,
    "6": 0.20,
    "5": 0.14,
    "4": 0.10,
    "3": 0.075,
    "2": 0.055,
    "1": 0.040,
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def parse_utc_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def pricing_snapshot_age_hours(refreshed_at: str | None) -> float | None:
    refreshed_datetime = parse_utc_timestamp(refreshed_at)
    if refreshed_datetime is None:
        return None
    return max(0.0, round((datetime.now(UTC) - refreshed_datetime).total_seconds() / 3600, 2))


def pricing_snapshot_is_fresh(
    refreshed_at: str | None,
    *,
    freshness_window_hours: int = DEFAULT_PRICING_FRESHNESS_HOURS,
) -> bool:
    age_hours = pricing_snapshot_age_hours(refreshed_at)
    if age_hours is None:
        return False
    return age_hours < freshness_window_hours


def tokenize(value: str) -> list[str]:
    normalized = re.sub(r"[^a-z0-9/]+", " ", value.lower())
    return [token for token in normalized.split() if token]


def canonicalize_collector_number(value: str) -> str:
    normalized = " ".join(tokenize(value))
    compact = normalized.replace(" ", "")
    paired_match = re.fullmatch(r"([a-z]+)?(\d+)\/([a-z]+)?(\d+)", compact)
    if paired_match:
        left_prefix = paired_match.group(1) or ""
        left_number = paired_match.group(2)
        right_prefix = paired_match.group(3) or ""
        right_number = paired_match.group(4)

        if left_prefix and right_prefix == left_prefix:
            return f"{left_prefix}{left_number}/{right_number}"
        return compact

    spaced_match = re.fullmatch(r"([a-z]+)\s+(\d+)", normalized)
    if spaced_match:
        return f"{spaced_match.group(1)} {spaced_match.group(2)}"

    return normalized


def runtime_supported_card_id(card_id: str | None) -> bool:
    if not card_id:
        return False
    return LOW_TRUST_CUSTOM_CARD_ID_PATTERN.search(card_id) is None


def embedding_for_parts(parts: list[str], dimension: int = METADATA_EMBEDDING_DIMENSION) -> list[float]:
    vector = [0.0] * dimension

    for part in parts:
        for token in tokenize(part):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:2], "big") % dimension
            sign = 1.0 if digest[2] % 2 == 0 else -1.0

            weight = 1.0
            if "/" in token:
                weight += 0.75
            if any(character.isdigit() for character in token):
                weight += 0.4
            if token in {"promo", "trainer", "gallery", "energy"}:
                weight += 0.25

            vector[bucket] += sign * weight

    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    return sum(left * right for left, right in zip(lhs, rhs))


def euclidean_distance(lhs: list[float], rhs: list[float]) -> float:
    return math.sqrt(sum((left - right) ** 2 for left, right in zip(lhs, rhs)))


def image_similarity(lhs: list[float], rhs: list[float]) -> float:
    if not lhs or not rhs:
        return DEFAULT_VISUAL_RETRIEVAL

    distance = euclidean_distance(lhs, rhs)
    return 1.0 / (1.0 + distance)


def _hyperplane_seed(model_id: str, table_index: int, bit_index: int, dimension_index: int) -> bytes:
    return f"{model_id}:{table_index}:{bit_index}:{dimension_index}".encode("utf-8")


def deterministic_hyperplane(model_id: str, table_index: int, bit_index: int, dimension: int) -> list[float]:
    plane: list[float] = []
    for dimension_index in range(dimension):
        digest = hashlib.sha256(_hyperplane_seed(model_id, table_index, bit_index, dimension_index)).digest()
        value = int.from_bytes(digest[:8], "big") / float(1 << 64)
        plane.append(value * 2.0 - 1.0)
    return plane


def build_ann_index(
    model_id: str,
    embeddings: list[tuple[int, list[float]]],
    dimension: int,
    table_count: int = ANN_TABLE_COUNT,
    bits_per_table: int = ANN_TABLE_BITS,
) -> ApproximateNeighborIndex | None:
    if not embeddings:
        return None

    hyperplanes = [
        [deterministic_hyperplane(model_id, table_index, bit_index, dimension) for bit_index in range(bits_per_table)]
        for table_index in range(table_count)
    ]
    buckets: list[dict[int, list[int]]] = [dict() for _ in range(table_count)]

    for card_index, embedding in embeddings:
        for table_index in range(table_count):
            signature = signature_for_embedding(embedding, hyperplanes[table_index])
            buckets[table_index].setdefault(signature, []).append(card_index)

    return ApproximateNeighborIndex(
        model_id=model_id,
        dimension=dimension,
        table_count=table_count,
        bits_per_table=bits_per_table,
        hyperplanes=hyperplanes,
        buckets=buckets,
    )


def signature_for_embedding(embedding: list[float], table_hyperplanes: list[list[float]]) -> int:
    signature = 0
    for bit_index, hyperplane in enumerate(table_hyperplanes):
        if cosine_similarity(embedding, hyperplane) >= 0:
            signature |= 1 << bit_index
    return signature


def hamming_neighbors(signature: int, bits_per_table: int) -> list[int]:
    return [signature ^ (1 << bit_index) for bit_index in range(bits_per_table)]


def query_ann_index(
    index: ApproximateNeighborIndex | None,
    embedding: list[float] | None,
    target_candidates: int,
) -> list[int]:
    if index is None or embedding is None:
        return []

    candidate_stats: dict[int, tuple[int, int]] = {}
    signatures = [signature_for_embedding(embedding, table) for table in index.hyperplanes]

    for table_index, signature in enumerate(signatures):
        for card_index in index.buckets[table_index].get(signature, []):
            exact_hits, near_hits = candidate_stats.get(card_index, (0, 0))
            candidate_stats[card_index] = (exact_hits + 1, near_hits)

    if len(candidate_stats) < target_candidates:
        for table_index, signature in enumerate(signatures):
            for neighbor_signature in hamming_neighbors(signature, index.bits_per_table):
                for card_index in index.buckets[table_index].get(neighbor_signature, []):
                    exact_hits, near_hits = candidate_stats.get(card_index, (0, 0))
                    candidate_stats[card_index] = (exact_hits, near_hits + 1)
                if len(candidate_stats) >= target_candidates:
                    break
            if len(candidate_stats) >= target_candidates:
                break

    ranked = sorted(
        candidate_stats.items(),
        key=lambda item: (-item[1][0], -item[1][1], item[0]),
    )
    return [card_index for card_index, _ in ranked[:target_candidates]]


def cleaned_price(value: Any) -> float | None:
    if value is None:
        return None

    try:
        amount = round(float(value), 2)
    except (TypeError, ValueError):
        return None

    if amount <= 0:
        return None

    return amount


def cleaned_high_price(value: Any, reference: float | None) -> float | None:
    amount = cleaned_price(value)
    if amount is None:
        return None

    if amount >= 5_000:
        return None

    if reference is not None and amount > max(reference * 20, 250):
        return None

    return amount


def preferred_tcgplayer_price_entry(prices: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    if not prices:
        return None

    ordered_variants = [
        "normal",
        "holofoil",
        "reverseHolofoil",
        "unlimitedNormal",
        "unlimitedHolofoil",
        "1stEditionNormal",
        "1stEditionHolofoil",
    ]
    candidates: list[tuple[int, str, dict[str, Any]]] = []

    for variant, payload in prices.items():
        if not isinstance(payload, dict):
            continue

        populated = sum(
            1 for field in ("market", "mid", "low", "high", "directLow")
            if cleaned_price(payload.get(field)) is not None
        )
        market_bonus = 2 if cleaned_price(payload.get("market")) is not None else 0
        preferred_bonus = max(0, len(ordered_variants) - ordered_variants.index(variant)) if variant in ordered_variants else 0
        candidates.append((populated + market_bonus + preferred_bonus, variant, payload))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (-item[0], item[1]))
    _, variant, payload = candidates[0]
    return variant, payload


def normalize_price_summary(tcgplayer: dict[str, Any], cardmarket: dict[str, Any]) -> dict[str, Any] | None:
    tcgplayer_prices = (tcgplayer or {}).get("prices") or {}
    preferred_tcgplayer = preferred_tcgplayer_price_entry(tcgplayer_prices)

    if preferred_tcgplayer is not None:
        variant, payload = preferred_tcgplayer
        market_price = cleaned_price(payload.get("market"))
        mid_price = cleaned_price(payload.get("mid"))
        low_price = cleaned_price(payload.get("low"))
        direct_low_price = cleaned_price(payload.get("directLow"))
        reference = market_price or mid_price or low_price
        high_price = cleaned_high_price(payload.get("high"), reference)

        summary = {
            "source": "tcgplayer",
            "currencyCode": "USD",
            "variant": variant,
            "low": low_price,
            "market": market_price,
            "mid": mid_price,
            "high": high_price,
            "directLow": direct_low_price,
            "trend": market_price,
            "updatedAt": (tcgplayer or {}).get("updatedAt"),
            "sourceURL": (tcgplayer or {}).get("url"),
        }
        if any(summary[key] is not None for key in ("low", "market", "mid", "high", "directLow", "trend")):
            return summary

    cardmarket_prices = (cardmarket or {}).get("prices") or {}
    if cardmarket_prices:
        trend_price = cleaned_price(cardmarket_prices.get("trendPrice"))
        mid_price = cleaned_price(cardmarket_prices.get("averageSellPrice")) or cleaned_price(cardmarket_prices.get("avg30")) or cleaned_price(cardmarket_prices.get("avg7"))
        low_price = cleaned_price(cardmarket_prices.get("lowPriceExPlus")) or cleaned_price(cardmarket_prices.get("lowPrice"))
        reference = trend_price or mid_price or low_price
        high_price = cleaned_high_price(cardmarket_prices.get("suggestedPrice"), reference)

        summary = {
            "source": "cardmarket",
            "currencyCode": "EUR",
            "variant": "raw",
            "low": low_price,
            "market": trend_price,
            "mid": mid_price,
            "high": high_price,
            "directLow": None,
            "trend": trend_price,
            "updatedAt": (cardmarket or {}).get("updatedAt"),
            "sourceURL": (cardmarket or {}).get("url"),
        }
        if any(summary[key] is not None for key in ("low", "market", "mid", "high", "trend")):
            return summary

    return None


def collector_number_lookup_keys(value: str) -> set[str]:
    canonical = canonicalize_collector_number(value).lower()
    if not canonical:
        return set()

    keys = {canonical, canonical.replace(" ", "")}

    paired_match = re.fullmatch(r"([a-z]+)?(\d+)\/([a-z]+)?(\d+)", canonical.replace(" ", ""))
    if paired_match:
        left_prefix = paired_match.group(1) or ""
        left_number = paired_match.group(2)
        left_compact = f"{left_prefix}{left_number}" if left_prefix else left_number
        keys.add(left_compact)
        keys.add(left_number)
        keys.add(left_number.lstrip("0") or "0")

    spaced_match = re.fullmatch(r"([a-z]+)\s+(\d+)", canonical)
    if spaced_match:
        raw_number = spaced_match.group(2)
        keys.add(raw_number)
        keys.add(raw_number.lstrip("0") or "0")

    return {key for key in keys if key}


def collector_prefix(value: str) -> str | None:
    canonical = canonicalize_collector_number(value).lower()
    spaced_match = re.fullmatch(r"([a-z]+)\s+(\d+)", canonical)
    if spaced_match:
        return spaced_match.group(1)
    return None


def collector_number_has_alpha_hint(value: str) -> bool:
    canonical = canonicalize_collector_number(value).lower()
    return bool(canonical and re.search(r"[a-z]", canonical))


def collector_numbers_equivalent(left: str, right: str) -> bool:
    left_canonical = canonicalize_collector_number(left).lower().replace(" ", "")
    right_canonical = canonicalize_collector_number(right).lower().replace(" ", "")
    if not left_canonical or not right_canonical:
        return False

    if left_canonical == right_canonical:
        return True

    paired_pattern = re.compile(r"([a-z]+)?(\d+)\/([a-z]+)?(\d+)")
    left_match = paired_pattern.fullmatch(left_canonical)
    right_match = paired_pattern.fullmatch(right_canonical)
    if left_match and right_match:
        left_left_prefix = left_match.group(1) or ""
        left_right_prefix = left_match.group(3) or ""
        right_left_prefix = right_match.group(1) or ""
        right_right_prefix = right_match.group(3) or ""
        if left_left_prefix != right_left_prefix or left_right_prefix != right_right_prefix:
            return False

        left_left_number = left_match.group(2).lstrip("0") or "0"
        left_right_number = left_match.group(4).lstrip("0") or "0"
        right_left_number = right_match.group(2).lstrip("0") or "0"
        right_right_number = right_match.group(4).lstrip("0") or "0"
        return left_left_number == right_left_number and left_right_number == right_right_number

    spaced_pattern = re.compile(r"([a-z]+)(\d+)")
    left_spaced = spaced_pattern.fullmatch(left_canonical)
    right_spaced = spaced_pattern.fullmatch(right_canonical)
    if left_spaced and right_spaced:
        return (
            left_spaced.group(1) == right_spaced.group(1)
            and (left_spaced.group(2).lstrip("0") or "0") == (right_spaced.group(2).lstrip("0") or "0")
        )

    return False


def normalized_set_hint_tokens(recognized_text: str) -> set[str]:
    normalized: set[str] = set()

    for token in tokenize(recognized_text):
        normalized.add(token)
        if token.endswith("en") and len(token) > 3:
            normalized.add(token[:-2])
        if token.endswith("jp") and len(token) > 3:
            normalized.add(token[:-2])
        if token.endswith("de") and len(token) > 3:
            normalized.add(token[:-2])

    return normalized


def recognized_text_for_payload(payload: dict[str, Any]) -> str:
    return " ".join(
        part for part in [
            payload.get("bottomLeftRecognizedText") or "",
            payload.get("bottomRightRecognizedText") or "",
            payload.get("metadataStripRecognizedText") or "",
            payload.get("topLabelRecognizedText") or "",
            payload.get("fullRecognizedText") or "",
        ]
        if part
    )


def structured_set_hints_for_payload(payload: dict[str, Any]) -> set[str]:
    hints = {
        token
        for token in normalized_set_hint_tokens(" ".join(str(value) for value in (payload.get("setHintTokens") or [])))
        if token and not token.isdigit()
    }
    prefix = (payload.get("promoCodeHint") or collector_prefix(payload.get("collectorNumber") or "") or "").lower()
    if prefix:
        hints.add(prefix)
    return hints


def trusted_set_hints_for_payload(payload: dict[str, Any]) -> set[str]:
    hints = structured_set_hints_for_payload(payload)
    return {
        token
        for token in hints
        if token in TRUSTED_SET_HINT_TOKENS or OFFICIAL_SET_HINT_PATTERN.fullmatch(token)
    }


def recognized_pokedex_number_hints(recognized_text: str) -> set[str]:
    normalized = recognized_text.upper()
    matches = set()

    for pattern in [
        r"#\s*(\d{1,4})\b",
        r"\bNO\.?\s*(\d{1,4})\b",
    ]:
        for match in re.findall(pattern, normalized):
            matches.add(match.lstrip("0") or "0")

    return matches


def recognized_artist_tokens(recognized_text: str) -> set[str]:
    return {
        token
        for token in tokenize(recognized_text)
        if len(token) > 2 and token not in {"illus", "illustration", "artist"}
    }


GENERIC_ARTIST_CREDIT_TOKENS = {
    "5ban",
    "graphics",
    "graphic",
    "studio",
    "planeta",
    "aky",
    "works",
    "cg",
}


def has_specific_artist_credit_signal(recognized_text: str) -> bool:
    for match in re.findall(r"\billus\.?\s*([A-Za-z0-9'’.\-]+(?:\s+[A-Za-z0-9'’.\-]+){0,3})", recognized_text, re.IGNORECASE):
        tokens = {
            token
            for token in tokenize(match)
            if len(token) > 1
        }
        if tokens and not tokens.issubset(GENERIC_ARTIST_CREDIT_TOKENS):
            return True
    return False


def collector_number_api_query_values(value: str) -> list[str]:
    canonical = canonicalize_collector_number(value).lower().replace(" ", "")
    if not canonical:
        return []

    values: list[str] = []

    paired_match = re.fullmatch(r"([a-z]+)?(\d+)\/([a-z]+)?(\d+)", canonical)
    if paired_match:
        left_prefix = paired_match.group(1) or ""
        left_number = paired_match.group(2)
        prefixed = f"{left_prefix}{left_number}" if left_prefix else left_number
        stripped = left_number.lstrip("0") or "0"
        values.extend([prefixed, stripped])
    else:
        values.append(canonical)

    seen: set[str] = set()
    deduped: list[str] = []
    for item in values:
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def collector_number_printed_total(value: str) -> int | None:
    canonical = canonicalize_collector_number(value).lower().replace(" ", "")
    paired_match = re.fullmatch(r"(?:[a-z]+)?\d+/(?:[a-z]+)?(\d+)", canonical)
    if not paired_match:
        return None

    try:
        printed_total = int(paired_match.group(1))
    except ValueError:
        return None

    return printed_total if printed_total > 0 else None


def resolver_mode_for_payload(payload: dict[str, Any]) -> str:
    hint = str(payload.get("resolverModeHint") or "").strip().lower()
    label_text = normalize_label_text(
        " ".join(
            part for part in [
                payload.get("topLabelRecognizedText") or "",
                payload.get("fullRecognizedText") or "",
            ]
            if part
        )
    )
    if is_psa_label_text(label_text):
        return "psa_slab"

    if hint in {"raw_card", "psa_slab", "unknown_fallback"}:
        return hint

    if payload.get("collectorNumber"):
        return "raw_card"

    return "unknown_fallback"


def normalize_label_text(value: str) -> str:
    return " ".join(tokenize(value.upper()))


def is_psa_label_text(value: str) -> bool:
    slab_tokens = {
        "psa",
        "gem",
        "mt",
        "mint",
        "nm",
        "cert",
        "edition",
    }
    tokens = set(tokenize(value))
    has_keyword = not tokens.isdisjoint(slab_tokens)
    has_cert_like_number = re.search(r"\b\d{7,8}\b", value) is not None
    has_label_shape = "pokemon" in tokens and ("#" in value or has_cert_like_number)
    return has_keyword or has_label_shape


def normalize_grade(value: str | None) -> str | None:
    if value is None:
        return None

    cleaned = str(value).strip().upper().replace(".0", "")
    if not cleaned:
        return None

    number_match = re.fullmatch(r"(10|[1-9])(?:\.(5))?", cleaned)
    if number_match:
        if number_match.group(2):
            return f"{number_match.group(1)}.5"
        return number_match.group(1)

    return cleaned


def parse_datetime_value(value: str | None) -> datetime | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    cleaned = cleaned.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        try:
            parsed = datetime.strptime(cleaned, "%Y-%m-%d")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def numeric_grade_value(value: str | None) -> float | None:
    normalized = normalize_grade(value)
    if normalized is None:
        return None

    try:
        return float(normalized)
    except ValueError:
        return None


def parse_psa_grade(label_text: str) -> str | None:
    normalized = normalize_label_text(label_text)
    if not normalized:
        return None

    grade_patterns = [
        r"\bgem mt\s+(10|[1-9])\b",
        r"\bgem mint\s+(10|[1-9])\b",
        r"\bmint\s+(10|[1-9])\b",
        r"\bnm mt\s+(10|[1-9])\b",
        r"\bnm-mt\s+(10|[1-9])\b",
        r"\bex mt\s+(10|[1-9])\b",
        r"\bex-mt\s+(10|[1-9])\b",
        r"\bvg ex\s+(10|[1-9])\b",
        r"\bvg-ex\s+(10|[1-9])\b",
        r"\bgood\s+(10|[1-9])\b",
        r"\bfair\s+(10|[1-9])\b",
        r"\bpr\s+(10|[1-9])\b",
    ]

    for pattern in grade_patterns:
        match = re.search(pattern, normalized)
        if match:
            return normalize_grade(match.group(1))

    adjective_only_patterns = [
        (r"\bgem mt\b", "10"),
        (r"\bgem mint\b", "10"),
        (r"\bmint\b", "9"),
        (r"\bnm mt\b", "8"),
        (r"\bnm-mt\b", "8"),
        (r"\bex mt\b", "6"),
        (r"\bex-mt\b", "6"),
        (r"\bvg ex\b", "4"),
        (r"\bvg-ex\b", "4"),
        (r"\bgood\b", "2"),
        (r"\bfair\b", "1.5"),
        (r"\bpr\b", "1"),
    ]

    for pattern, grade in adjective_only_patterns:
        if re.search(pattern, normalized):
            return normalize_grade(grade)

    return None


def parse_psa_cert_number(label_text: str) -> str | None:
    normalized = normalize_label_text(label_text)
    match = re.search(r"\b(\d{7,8})\b", normalized)
    return match.group(1) if match else None


def slab_context_from_payload(payload: dict[str, Any]) -> dict[str, str] | None:
    label_text = " ".join(
        part for part in [
            payload.get("topLabelRecognizedText") or "",
            payload.get("fullRecognizedText") or "",
        ]
        if part
    )
    if not label_text:
        return None

    if not is_psa_label_text(normalize_label_text(label_text)):
        return None

    grade = parse_psa_grade(label_text)
    cert_number = parse_psa_cert_number(label_text)

    context: dict[str, str] = {"grader": SLAB_GRADER_PSA}
    if grade is not None:
        context["grade"] = grade
    if cert_number is not None:
        context["certNumber"] = cert_number
    return context


def psa_label_number_hints(recognized_text: str) -> set[str]:
    normalized = recognized_text.upper()
    matches = set()

    for pattern in [
        r"#\s*([A-Z0-9-]{1,8})\b",
        r"\bNO\.?\s*([A-Z0-9-]{1,8})\b",
    ]:
        for match in re.findall(pattern, normalized):
            matches.add(match)

    return {
        key
        for match in matches
        for key in collector_number_lookup_keys(match)
        if key
    }


@dataclass(frozen=True)
class IndexedCard:
    id: str
    name: str
    set_name: str
    set_id: str | None
    set_ptcgo_code: str | None
    number: str
    rarity: str
    variant: str
    language: str
    artist: str | None
    national_pokedex_numbers: tuple[str, ...]
    reference_image_path: str | None
    image_embedding: list[float] | None
    metadata_embedding: list[float]
    pricing: dict[str, Any] | None

    def as_candidate(
        self,
        pricing_override: dict[str, Any] | None = None,
        *,
        allow_embedded_pricing: bool = True,
    ) -> dict[str, Any]:
        candidate = {
            "id": self.id,
            "name": self.name,
            "setName": self.set_name,
            "number": self.number,
            "rarity": self.rarity,
            "variant": self.variant,
            "language": self.language,
        }
        pricing = pricing_override if pricing_override is not None else self.pricing if allow_embedded_pricing else None
        if pricing:
            candidate["pricing"] = pricing
        return candidate


@dataclass(frozen=True)
class QueryEmbedding:
    image_embedding: list[float] | None
    metadata_embedding: list[float]


@dataclass(frozen=True)
class ApproximateNeighborIndex:
    model_id: str
    dimension: int
    table_count: int
    bits_per_table: int
    hyperplanes: list[list[list[float]]]
    buckets: list[dict[int, list[int]]]


@dataclass(frozen=True)
class CatalogIndex:
    cards: list[IndexedCard]
    visual_ann: ApproximateNeighborIndex | None
    metadata_ann: ApproximateNeighborIndex | None
    collector_number_lookup: dict[str, list[int]]

    def __len__(self) -> int:
        return len(self.cards)


KNOWN_SET_ALIASES: dict[str, set[str]] = {
    "obsidian flame": {"obf"},
    "obsidian flames": {"obf"},
    "paldea evolved": {"pal"},
    "scarlet violet promo": {"svp", "prsv", "pr-sv"},
    "scarlet violet black star promos": {"svp", "prsv", "pr-sv"},
    "151": {"mew"},
    "crown zenith galarian gallery": {"gg", "crz"},
    "destined rivals": {"dri"},
    "surging sparks": {"ssp"},
    "paradox rift": {"par"},
    "scarlet violet": {"svi"},
    "brilliant stars": {"brs"},
    "lost origin": {"lor"},
    "ascended heroes": {"m2a"},
}


KNOWN_SET_ID_ALIASES: dict[str, set[str]] = {
    "sv2": {"pal"},
    "sv3": {"obf"},
    "svp": {"svp", "prsv", "pr-sv"},
    "sv3pt5": {"mew"},
    "swsh12pt5gg": {"gg", "crz"},
}

TRUSTED_SET_HINT_TOKENS: set[str] = {
    token
    for values in [
        set(KNOWN_SET_ALIASES.keys()),
        *KNOWN_SET_ALIASES.values(),
        set(KNOWN_SET_ID_ALIASES.keys()),
        *KNOWN_SET_ID_ALIASES.values(),
    ]
    for token in values
} | {"tg"}
OFFICIAL_SET_HINT_PATTERN = re.compile(
    r"^(?:"
    r"base\d|gym\d|neo\d|ecard\d|"
    r"ex\d+|dp\d+|pl\d+|bw\d+|xy\d+|sm\d+(?:tg)?|"
    r"swsh\d+(?:tg|pt5gg)?|swshp|sv\d+(?:pt5)?|svp|"
    r"det1|si1|pop\d+|ru1|cel25c|cel25|mcd\d+"
    r")$",
    re.IGNORECASE,
)


def generate_set_code_variations(set_id: str) -> set[str]:
    """
    Automatically generate set code variations from set_id.

    Examples:
        swsh9tg → {swsh9, swsh09, swsh9tg, tg}
        sv3pt5 → {sv3, sv03, sv3pt5, sv3.5}
        swsh12pt5gg → {swsh12, swsh12pt5gg, gg}
    """
    if not set_id:
        return set()

    variations = {set_id.lower()}
    import re

    # Extract base prefix (letters) and number
    match = re.match(r'^([a-z]+)(\d+)', set_id.lower())
    if match:
        prefix, number = match.groups()
        num_int = int(number)

        # Add zero-padded version (swsh9 → swsh09)
        if num_int < 10:
            variations.add(f"{prefix}0{number}")
            variations.add(f"{prefix.upper()}0{number}")

        # Add uppercase version (swsh9 → SWSH9)
        variations.add(f"{prefix.upper()}{number}")

        # Add base without number (swsh9tg → swsh9)
        variations.add(f"{prefix}{number}")

    # Extract suffix codes (swsh9tg → tg, swsh12pt5gg → gg)
    suffix_match = re.search(r'(\d+)([a-z]+)$', set_id.lower())
    if suffix_match:
        suffix = suffix_match.group(2)
        # Common suffixes that should be added as aliases
        if suffix in {'tg', 'gg', 'pt5', 'pt'}:
            variations.add(suffix)

    # Handle "pt5" as ".5" variation (sv3pt5 → sv3.5)
    if 'pt5' in set_id.lower():
        base = re.sub(r'pt5.*', '', set_id.lower())
        if base:
            variations.add(f"{base}.5")

    return variations


GENERIC_CARD_NAME_TOKENS = {
    "mega",
    "ex",
    "gx",
    "v",
    "vmax",
    "vstar",
    "vm",
    "tag",
    "team",
    "star",
    "holo",
    "reverse",
    "foil",
    "promo",
    "basic",
    "stage",
}


def additional_set_aliases_for_card(card: IndexedCard) -> set[str]:
    aliases: set[str] = set()

    # Manual overrides for specific set names
    normalized_name = " ".join(tokenize(card.set_name))
    aliases.update(KNOWN_SET_ALIASES.get(normalized_name, set()))

    # Generic set code variations (swsh9tg → swsh9, swsh09, tg, etc.)
    if card.set_id:
        aliases.update(generate_set_code_variations(card.set_id))
        # Manual overrides for specific set IDs
        aliases.update(KNOWN_SET_ID_ALIASES.get(card.set_id.lower(), set()))

    # Collector number prefix (TG23/30 → tg)
    prefix = collector_prefix(card.number)
    if prefix:
        aliases.add(prefix.lower())

    return aliases


def card_matches_set_hint(card: IndexedCard, set_hints: set[str]) -> bool:
    if not set_hints:
        return False

    candidate_tokens = set(tokenize(card.set_name))
    if card.set_id:
        candidate_tokens.add(card.set_id.lower())
    if card.set_ptcgo_code:
        candidate_tokens.add(card.set_ptcgo_code.lower())
    candidate_tokens.update(additional_set_aliases_for_card(card))

    return not candidate_tokens.isdisjoint(set_hints)


def load_cards_json(cards_path: Path) -> list[dict[str, Any]]:
    return json.loads(cards_path.read_text())


def upsert_card_in_catalog_snapshot(cards_path: Path, card: dict[str, Any]) -> dict[str, int]:
    cards_by_id: dict[str, dict[str, Any]] = {}
    if cards_path.exists():
        for existing_card in load_cards_json(cards_path):
            cards_by_id[str(existing_card["id"])] = existing_card

    card_id = str(card["id"])
    changed = 0 if cards_by_id.get(card_id) == card else 1
    added = 0 if card_id in cards_by_id else 1
    cards_by_id[card_id] = card

    cards_path.parent.mkdir(parents=True, exist_ok=True)
    cards_output = sorted(
        cards_by_id.values(),
        key=lambda item: (
            item.get("set_release_date") or "",
            item.get("set_name") or "",
            item.get("name") or "",
            item.get("number") or "",
        ),
    )
    cards_path.write_text(json.dumps(cards_output, indent=2, sort_keys=True))
    return {
        "added": added,
        "updated": changed - added if changed and not added else 0,
        "total": len(cards_output),
    }


def resolve_catalog_json_path(backend_root: Path, explicit_path: str | None = None) -> Path:
    if explicit_path:
        path = Path(explicit_path)
        if not path.is_absolute():
            path = (backend_root.parent / path).resolve()
        return path

    imported_path = backend_root / "catalog" / "pokemontcg" / "cards.json"
    if imported_path.exists():
        return imported_path

    return backend_root / "catalog" / "cards.sample.json"


def connect(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def apply_schema(connection: sqlite3.Connection, schema_path: Path) -> None:
    connection.executescript(schema_path.read_text())
    connection.commit()


def ensure_featureprint_binary(repo_root: Path) -> Path:
    source_path = repo_root / "tools" / "vision_featureprint.swift"
    build_directory = repo_root / ".build"
    binary_path = build_directory / "vision_featureprint"

    build_directory.mkdir(parents=True, exist_ok=True)

    if not binary_path.exists() or binary_path.stat().st_mtime < source_path.stat().st_mtime:
        process = subprocess.run(
            ["swiftc", str(source_path), "-o", str(binary_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.strip() or "Failed to compile vision_featureprint.swift")

    return binary_path


def resolve_reference_image_path(repo_root: Path, image_path_value: str | None) -> Path | None:
    if not image_path_value:
        return None

    path = Path(image_path_value)
    if not path.is_absolute():
        path = repo_root / path

    return path if path.exists() else None


def load_featureprint(image_path: Path, repo_root: Path) -> tuple[list[float], int, int]:
    binary_path = ensure_featureprint_binary(repo_root)
    process = subprocess.run(
        [str(binary_path), "--image", str(image_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or f"Failed to generate a feature print for {image_path}")

    payload = json.loads(process.stdout)
    return payload["vector"], int(payload["width"]), int(payload["height"])


def image_suffix_for_bytes(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    return ".img"


def decode_base64_image(payload_value: str) -> bytes:
    if payload_value.startswith("data:") and "," in payload_value:
        payload_value = payload_value.split(",", 1)[1]
    return base64.b64decode(payload_value)


def featureprint_for_bytes(image_bytes: bytes, repo_root: Path) -> list[float] | None:
    suffix = image_suffix_for_bytes(image_bytes)
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary_file:
        temporary_file.write(image_bytes)
        temporary_path = Path(temporary_file.name)

    try:
        vector, _, _ = load_featureprint(temporary_path, repo_root)
        return vector
    except Exception:
        return None
    finally:
        temporary_path.unlink(missing_ok=True)


def upsert_catalog_card(
    connection: sqlite3.Connection,
    card: dict[str, Any],
    repo_root: Path,
    now: str,
    refresh_embeddings: bool = True,
) -> None:
    if not runtime_supported_card_id(card.get("id")):
        return

    connection.execute(
        """
        INSERT OR REPLACE INTO cards (id, name, set_name, number, rarity, variant, language, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card["id"],
            card["name"],
            card["set_name"],
            card["number"],
            card["rarity"],
            card["variant"],
            card["language"],
            now,
        ),
    )

    connection.execute(
        """
        INSERT OR REPLACE INTO card_catalog_metadata (
            card_id,
            source,
            source_record_id,
            set_id,
            set_series,
            set_ptcgo_code,
            set_release_date,
            supertype,
            subtypes_json,
            types_json,
            national_pokedex_numbers_json,
            artist,
            regulation_mark,
            images_small_url,
            images_large_url,
            tcgplayer_json,
            cardmarket_json,
            source_payload_json,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card["id"],
            card.get("source", "local_seed"),
            card.get("source_record_id", card["id"]),
            card.get("set_id"),
            card.get("set_series"),
            card.get("set_ptcgo_code"),
            card.get("set_release_date"),
            card.get("supertype"),
            json.dumps(card.get("subtypes", [])),
            json.dumps(card.get("types", [])),
            json.dumps(card.get("national_pokedex_numbers", [])),
            card.get("artist"),
            card.get("regulation_mark"),
            card.get("reference_image_small_url"),
            card.get("reference_image_url"),
            json.dumps(card.get("tcgplayer", {})),
            json.dumps(card.get("cardmarket", {})),
            json.dumps(card.get("source_payload", card), sort_keys=True),
            now,
        ),
    )

    pricing_summary = normalize_price_summary(
        card.get("tcgplayer", {}),
        card.get("cardmarket", {}),
    )
    if pricing_summary is not None:
        connection.execute(
            """
            INSERT OR REPLACE INTO card_price_summaries (
                card_id,
                source,
                currency_code,
                variant,
                low_price,
                market_price,
                mid_price,
                high_price,
                direct_low_price,
                trend_price,
                source_updated_at,
                source_url,
                source_payload_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                card["id"],
                pricing_summary["source"],
                pricing_summary["currencyCode"],
                pricing_summary.get("variant"),
                pricing_summary.get("low"),
                pricing_summary.get("market"),
                pricing_summary.get("mid"),
                pricing_summary.get("high"),
                pricing_summary.get("directLow"),
                pricing_summary.get("trend"),
                pricing_summary.get("updatedAt"),
                pricing_summary.get("sourceURL"),
                json.dumps(
                    {
                        "tcgplayer": card.get("tcgplayer", {}),
                        "cardmarket": card.get("cardmarket", {}),
                    },
                    sort_keys=True,
                ),
                now,
            ),
        )
    else:
        connection.execute(
            "DELETE FROM card_price_summaries WHERE card_id = ?",
            (card["id"],),
        )

    image_id: str | None = None
    if refresh_embeddings:
        connection.execute(
            "DELETE FROM card_images WHERE card_id = ? AND role = ?",
            (card["id"], CARD_REFERENCE_ROLE),
        )
        connection.execute(
            "DELETE FROM card_embeddings WHERE card_id = ? AND model_id = ?",
            (card["id"], VISION_MODEL_ID),
        )

        reference_image_path = resolve_reference_image_path(repo_root, card.get("reference_image_path"))
        if reference_image_path is not None:
            try:
                featureprint_vector, width, height = load_featureprint(reference_image_path, repo_root)
                image_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{card['id']}:{reference_image_path}:{CARD_REFERENCE_ROLE}"))
                image_sha256 = hashlib.sha256(reference_image_path.read_bytes()).hexdigest()

                connection.execute(
                    """
                    INSERT OR REPLACE INTO card_images (
                        id,
                        card_id,
                        role,
                        source_url,
                        local_path,
                        image_sha256,
                        width,
                        height,
                        created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        image_id,
                        card["id"],
                        CARD_REFERENCE_ROLE,
                        card.get("reference_image_url"),
                        str(reference_image_path),
                        image_sha256,
                        width,
                        height,
                        now,
                    ),
                )
                connection.execute(
                    """
                    INSERT OR REPLACE INTO card_embeddings (id, card_id, image_id, model_id, vector_json, vector_norm, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid5(uuid.NAMESPACE_URL, f"{card['id']}:{VISION_MODEL_ID}")),
                        card["id"],
                        image_id,
                        VISION_MODEL_ID,
                        json.dumps(featureprint_vector),
                        1.0,
                        now,
                    ),
                )
            except Exception as error:
                print(f"warning: failed to build feature print for {reference_image_path}: {error}")

    metadata_embedding = embedding_for_parts(
        [
            card["name"],
            card["set_name"],
            card["number"],
            card["rarity"],
            card["variant"],
            card["language"],
        ]
    )
    connection.execute(
        """
        INSERT OR REPLACE INTO card_embeddings (id, card_id, image_id, model_id, vector_json, vector_norm, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"{card['id']}:{METADATA_MODEL_ID}")),
            card["id"],
            image_id,
            METADATA_MODEL_ID,
            json.dumps(metadata_embedding),
            1.0,
            now,
        ),
    )


def seed_catalog(connection: sqlite3.Connection, cards: list[dict[str, Any]], repo_root: Path) -> None:
    now = utc_now()

    if cards:
        incoming_ids = [card["id"] for card in cards]
        placeholders = ",".join("?" for _ in incoming_ids)

        connection.execute(
            f"DELETE FROM scan_candidates WHERE card_id NOT IN ({placeholders})",
            incoming_ids,
        )
        connection.execute(
            f"DELETE FROM card_catalog_metadata WHERE card_id NOT IN ({placeholders})",
            incoming_ids,
        )
        connection.execute(
            f"DELETE FROM card_price_summaries WHERE card_id NOT IN ({placeholders})",
            incoming_ids,
        )
        connection.execute(
            f"DELETE FROM card_embeddings WHERE card_id NOT IN ({placeholders})",
            incoming_ids,
        )
        connection.execute(
            f"DELETE FROM card_images WHERE card_id NOT IN ({placeholders})",
            incoming_ids,
        )
        connection.execute(
            f"DELETE FROM cards WHERE id NOT IN ({placeholders})",
            incoming_ids,
        )

    connection.execute(
        """
        INSERT OR REPLACE INTO embedding_models (id, family, version, modality, dimension, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (VISION_MODEL_ID, VISION_MODEL_FAMILY, "v1", "image", VISION_EMBEDDING_DIMENSION, now),
    )
    connection.execute(
        """
        INSERT OR REPLACE INTO embedding_models (id, family, version, modality, dimension, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (METADATA_MODEL_ID, METADATA_MODEL_FAMILY, "v1", "text", METADATA_EMBEDDING_DIMENSION, now),
    )

    for card in cards:
        upsert_catalog_card(connection, card, repo_root, now, refresh_embeddings=True)

    connection.commit()


def load_index(connection: sqlite3.Connection) -> CatalogIndex:
    rows = connection.execute(
        """
        SELECT
            cards.id,
            cards.name,
            cards.set_name,
            card_catalog_metadata.set_id AS set_id,
            card_catalog_metadata.set_ptcgo_code AS set_ptcgo_code,
            cards.number,
            cards.rarity,
            cards.variant,
            cards.language,
            card_catalog_metadata.artist AS artist,
            card_catalog_metadata.national_pokedex_numbers_json AS national_pokedex_numbers_json,
            card_images.local_path AS reference_image_path,
            image_embeddings.vector_json AS image_vector_json,
            metadata_embeddings.vector_json AS metadata_vector_json,
            card_price_summaries.source AS pricing_source,
            card_price_summaries.currency_code AS pricing_currency_code,
            card_price_summaries.variant AS pricing_variant,
            card_price_summaries.low_price AS pricing_low_price,
            card_price_summaries.market_price AS pricing_market_price,
            card_price_summaries.mid_price AS pricing_mid_price,
            card_price_summaries.high_price AS pricing_high_price,
            card_price_summaries.direct_low_price AS pricing_direct_low_price,
            card_price_summaries.trend_price AS pricing_trend_price,
            card_price_summaries.source_updated_at AS pricing_updated_at,
            card_price_summaries.source_url AS pricing_source_url,
            card_price_summaries.updated_at AS pricing_refreshed_at
        FROM cards
        LEFT JOIN card_images
            ON card_images.card_id = cards.id
           AND card_images.role = ?
        LEFT JOIN card_catalog_metadata
            ON card_catalog_metadata.card_id = cards.id
        LEFT JOIN card_price_summaries
            ON card_price_summaries.card_id = cards.id
        LEFT JOIN card_embeddings AS image_embeddings
            ON image_embeddings.card_id = cards.id
           AND image_embeddings.model_id = ?
        JOIN card_embeddings AS metadata_embeddings
            ON metadata_embeddings.card_id = cards.id
           AND metadata_embeddings.model_id = ?
        ORDER BY cards.name, cards.set_name, cards.number
        """,
        (CARD_REFERENCE_ROLE, VISION_MODEL_ID, METADATA_MODEL_ID),
    ).fetchall()

    cards = [
        IndexedCard(
            id=row["id"],
            name=row["name"],
            set_name=row["set_name"],
            set_id=row["set_id"],
            set_ptcgo_code=row["set_ptcgo_code"],
            number=row["number"],
            rarity=row["rarity"],
            variant=row["variant"],
            language=row["language"],
            artist=row["artist"],
            national_pokedex_numbers=tuple(
                str(value).lstrip("0") or "0"
                for value in json.loads(row["national_pokedex_numbers_json"] or "[]")
            ),
            reference_image_path=row["reference_image_path"],
            image_embedding=json.loads(row["image_vector_json"]) if row["image_vector_json"] else None,
            metadata_embedding=json.loads(row["metadata_vector_json"]),
            pricing=pricing_summary_from_row(row),
        )
        for row in rows
        if runtime_supported_card_id(row["id"])
    ]

    collector_number_lookup: dict[str, list[int]] = {}
    for index, card in enumerate(cards):
        for key in collector_number_lookup_keys(card.number):
            collector_number_lookup.setdefault(key, []).append(index)

    visual_ann = build_ann_index(
        model_id=VISION_MODEL_ID,
        embeddings=[(index, card.image_embedding) for index, card in enumerate(cards) if card.image_embedding is not None],
        dimension=VISION_EMBEDDING_DIMENSION,
    )
    metadata_ann = build_ann_index(
        model_id=METADATA_MODEL_ID,
        embeddings=[(index, card.metadata_embedding) for index, card in enumerate(cards)],
        dimension=METADATA_EMBEDDING_DIMENSION,
    )

    # Allow empty database - cards will be auto-imported on request
    if metadata_ann is None:
        print("⚠️  Warning: Starting with empty card database. Cards will be auto-imported on request.")

    return CatalogIndex(
        cards=cards,
        visual_ann=visual_ann,
        metadata_ann=metadata_ann,
        collector_number_lookup=collector_number_lookup,
    )


def search_cards(connection: sqlite3.Connection, query: str, limit: int = 8) -> list[dict[str, Any]]:
    query_tokens = tokenize(query)
    if not query_tokens:
        return []
    canonical_query_number = canonicalize_collector_number(query)
    query_token_variants = [(token, canonicalize_collector_number(token)) for token in query_tokens]

    rows = connection.execute(
        """
        SELECT
            cards.id,
            cards.name,
            cards.set_name,
            cards.number,
            cards.rarity,
            cards.variant,
            cards.language,
            card_price_summaries.source AS pricing_source,
            card_price_summaries.currency_code AS pricing_currency_code,
            card_price_summaries.variant AS pricing_variant,
            card_price_summaries.low_price AS pricing_low_price,
            card_price_summaries.market_price AS pricing_market_price,
            card_price_summaries.mid_price AS pricing_mid_price,
            card_price_summaries.high_price AS pricing_high_price,
            card_price_summaries.direct_low_price AS pricing_direct_low_price,
            card_price_summaries.trend_price AS pricing_trend_price,
            card_price_summaries.source_updated_at AS pricing_updated_at,
            card_price_summaries.source_url AS pricing_source_url,
            card_price_summaries.updated_at AS pricing_refreshed_at
        FROM cards
        LEFT JOIN card_price_summaries ON card_price_summaries.card_id = cards.id
        ORDER BY name, set_name, number
        """
    ).fetchall()

    scored: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        candidate = {
            "id": row["id"],
            "name": row["name"],
            "setName": row["set_name"],
            "number": row["number"],
            "rarity": row["rarity"],
            "variant": row["variant"],
            "language": row["language"],
        }
        pricing = pricing_summary_from_row(row)
        if pricing:
            candidate["pricing"] = pricing
        normalized_number = canonicalize_collector_number(row["number"])
        haystack_tokens = set(
            tokenize(
                " ".join(
                    [
                        row["name"],
                        row["set_name"],
                        row["number"],
                        normalized_number,
                        row["rarity"],
                        row["variant"],
                        row["language"],
                    ]
                )
            )
        )

        number_match = canonical_query_number and canonical_query_number == normalized_number
        if not number_match and not all(
            token in haystack_tokens or canonical_token in haystack_tokens
            for token, canonical_token in query_token_variants
        ):
            continue

        score = sum(
            1
            for token, canonical_token in query_token_variants
            if token in haystack_tokens or canonical_token in haystack_tokens
        )
        if number_match:
            score += 3
        scored.append((score, candidate))

    scored.sort(key=lambda item: (-item[0], item[1]["name"], item[1]["number"]))
    return [candidate for _, candidate in scored[:limit]]


def pricing_summary_from_row(
    row: sqlite3.Row,
    *,
    pricing_mode: str = RAW_PRICING_MODE,
    freshness_window_hours: int = DEFAULT_PRICING_FRESHNESS_HOURS,
    grader: str | None = None,
    grade: str | None = None,
    pricing_tier: str | None = None,
    confidence_label: str | None = None,
    confidence_level: int | None = None,
    comp_count: int | None = None,
    recent_comp_count: int | None = None,
    last_sold_price: float | None = None,
    last_sold_at: str | None = None,
    bucket_key: str | None = None,
    methodology_summary: str | None = None,
) -> dict[str, Any] | None:
    if "pricing_source" not in row.keys() or row["pricing_source"] is None:
        return None

    refreshed_at = row["pricing_refreshed_at"]
    snapshot_age_hours = pricing_snapshot_age_hours(refreshed_at)

    return {
        "source": row["pricing_source"],
        "currencyCode": row["pricing_currency_code"],
        "variant": row["pricing_variant"],
        "low": row["pricing_low_price"],
        "market": row["pricing_market_price"],
        "mid": row["pricing_mid_price"],
        "high": row["pricing_high_price"],
        "directLow": row["pricing_direct_low_price"],
        "trend": row["pricing_trend_price"],
        "updatedAt": row["pricing_updated_at"],
        "refreshedAt": refreshed_at,
        "sourceURL": row["pricing_source_url"],
        "pricingMode": pricing_mode,
        "snapshotAgeHours": snapshot_age_hours,
        "freshnessWindowHours": freshness_window_hours,
        "isFresh": pricing_snapshot_is_fresh(
            refreshed_at,
            freshness_window_hours=freshness_window_hours,
        ),
        "grader": grader,
        "grade": grade,
        "pricingTier": pricing_tier,
        "confidenceLabel": confidence_label,
        "confidenceLevel": confidence_level,
        "compCount": comp_count,
        "recentCompCount": recent_comp_count,
        "lastSoldPrice": last_sold_price,
        "lastSoldAt": last_sold_at,
        "bucketKey": bucket_key,
        "methodologySummary": methodology_summary,
    }


def weighted_average_amount(entries: list[tuple[float, datetime]]) -> float | None:
    if not entries:
        return None

    now = datetime.now(UTC)
    weighted_sum = 0.0
    total_weight = 0.0
    for amount, sold_at in entries:
        age_days = max((now - sold_at).total_seconds() / 86_400, 0.0)
        weight = 1.0 / (1.0 + age_days / 45.0)
        weighted_sum += amount * weight
        total_weight += weight

    if total_weight <= 0:
        return None

    return round(weighted_sum / total_weight, 2)


def confidence_level_for_sales(most_recent_sale_at: datetime | None, comp_count: int) -> tuple[int, str]:
    if most_recent_sale_at is None:
        return 1, "Low"

    age_days = (datetime.now(UTC) - most_recent_sale_at).total_seconds() / 86_400
    if age_days <= 14 and comp_count >= 3:
        return 5, "High"
    if age_days <= 30 and comp_count >= 2:
        return 4, "High"
    if age_days <= 90 and comp_count >= 2:
        return 3, "Medium"
    if age_days <= 180:
        return 2, "Medium"
    return 1, "Low"


def bucket_key_for_card_row(row: sqlite3.Row) -> str:
    set_series = (row["set_series"] or "").strip().lower()
    set_name = (row["set_name"] or "").strip().lower().replace(" ", "-")
    rarity = (row["rarity"] or "").strip().lower().replace(" ", "-")
    supertype = (row["supertype"] or "").strip().lower().replace(" ", "-")
    return ":".join(part for part in [set_series or set_name, supertype, rarity] if part) or "pokemon:unknown"


def bucket_key_for_card(connection: sqlite3.Connection, card_id: str) -> str | None:
    row = connection.execute(
        """
        SELECT cards.set_name, cards.rarity, card_catalog_metadata.set_series, card_catalog_metadata.supertype
        FROM cards
        LEFT JOIN card_catalog_metadata ON card_catalog_metadata.card_id = cards.id
        WHERE cards.id = ?
        LIMIT 1
        """,
        (card_id,),
    ).fetchone()
    if row is None:
        return None
    return bucket_key_for_card_row(row)


def card_row_for_pricing_provider(connection: sqlite3.Connection, card_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            cards.id,
            cards.name,
            cards.set_name,
            cards.number,
            cards.rarity,
            cards.variant,
            cards.language,
            card_catalog_metadata.set_id,
            card_catalog_metadata.set_series,
            card_catalog_metadata.supertype
        FROM cards
        LEFT JOIN card_catalog_metadata ON card_catalog_metadata.card_id = cards.id
        WHERE cards.id = ?
        LIMIT 1
        """,
        (card_id,),
    ).fetchone()


def external_price_mapping_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    provider: str,
) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT external_id, title, url, payload_json, updated_at
        FROM external_price_mappings
        WHERE card_id = ? AND provider = ?
        LIMIT 1
        """,
        (card_id, provider),
    ).fetchone()
    if row is None:
        return None
    return {
        "externalID": row["external_id"],
        "title": row["title"],
        "url": row["url"],
        "payload": json.loads(row["payload_json"] or "{}"),
        "updatedAt": row["updated_at"],
    }


def upsert_external_price_mapping(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    provider: str,
    external_id: str,
    title: str | None,
    url: str | None,
    payload: dict[str, Any],
    now: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO external_price_mappings (
            card_id,
            provider,
            external_id,
            title,
            url,
            payload_json,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card_id,
            provider,
            external_id,
            title,
            url,
            json.dumps(payload, sort_keys=True),
            now or utc_now(),
        ),
    )


def upsert_card_price_summary(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    source: str,
    currency_code: str,
    variant: str | None,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    direct_low_price: float | None,
    trend_price: float | None,
    source_updated_at: str | None,
    source_url: str | None,
    payload: dict[str, Any] | None = None,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO card_price_summaries (
            card_id,
            source,
            currency_code,
            variant,
            low_price,
            market_price,
            mid_price,
            high_price,
            direct_low_price,
            trend_price,
            source_updated_at,
            source_url,
            source_payload_json,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card_id,
            source,
            currency_code,
            variant,
            low_price,
            market_price,
            mid_price,
            high_price,
            direct_low_price,
            trend_price,
            source_updated_at,
            source_url,
            json.dumps(payload or {}, sort_keys=True),
            utc_now(),
        ),
    )
    connection.commit()


def log_catalog_sync_run(
    connection: sqlite3.Connection,
    *,
    started_at: str,
    completed_at: str | None,
    sync_mode: str,
    trigger_source: str | None,
    query_text: str | None,
    status: str,
    cards_before: int,
    cards_after: int,
    cards_added: int,
    cards_updated: int,
    missing_after_sync: int = 0,
    summary: dict[str, Any] | None = None,
    error_text: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO catalog_sync_runs (
            started_at,
            completed_at,
            sync_mode,
            trigger_source,
            query_text,
            status,
            cards_before,
            cards_after,
            cards_added,
            cards_updated,
            missing_after_sync,
            summary_json,
            error_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            started_at,
            completed_at,
            sync_mode,
            trigger_source,
            query_text,
            status,
            cards_before,
            cards_after,
            cards_added,
            cards_updated,
            missing_after_sync,
            json.dumps(summary or {}, sort_keys=True),
            error_text,
        ),
    )
    connection.commit()
    return int(cursor.lastrowid)


def latest_catalog_sync_run(connection: sqlite3.Connection) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT *
        FROM catalog_sync_runs
        ORDER BY started_at DESC, id DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "startedAt": row["started_at"],
        "completedAt": row["completed_at"],
        "syncMode": row["sync_mode"],
        "triggerSource": row["trigger_source"],
        "queryText": row["query_text"],
        "status": row["status"],
        "cardsBefore": row["cards_before"],
        "cardsAfter": row["cards_after"],
        "cardsAdded": row["cards_added"],
        "cardsUpdated": row["cards_updated"],
        "missingAfterSync": row["missing_after_sync"],
        "summary": json.loads(row["summary_json"] or "{}"),
        "errorText": row["error_text"],
    }


def catalog_sync_runs(connection: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT *
        FROM catalog_sync_runs
        ORDER BY started_at DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
            "syncMode": row["sync_mode"],
            "triggerSource": row["trigger_source"],
            "queryText": row["query_text"],
            "status": row["status"],
            "cardsBefore": row["cards_before"],
            "cardsAfter": row["cards_after"],
            "cardsAdded": row["cards_added"],
            "cardsUpdated": row["cards_updated"],
            "missingAfterSync": row["missing_after_sync"],
            "summary": json.loads(row["summary_json"] or "{}"),
            "errorText": row["error_text"],
        }
        for row in rows
    ]


def log_pricing_refresh_failure(
    connection: sqlite3.Connection,
    *,
    card_id: str | None,
    grader: str | None,
    grade: str | None,
    source: str,
    error_text: str,
    created_at: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO pricing_refresh_failures (
            card_id,
            grader,
            grade,
            source,
            error_text,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            card_id,
            grader,
            grade,
            source,
            error_text,
            created_at or utc_now(),
        ),
    )
    connection.commit()
    return int(cursor.lastrowid)


def pricing_refresh_failures(connection: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT *
        FROM pricing_refresh_failures
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "cardID": row["card_id"],
            "grader": row["grader"],
            "grade": row["grade"],
            "source": row["source"],
            "errorText": row["error_text"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def raw_pricing_summary_for_card(connection: sqlite3.Connection, card_id: str, *, pricing_mode: str = RAW_PRICING_MODE) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT
            card_price_summaries.source AS pricing_source,
            card_price_summaries.currency_code AS pricing_currency_code,
            card_price_summaries.variant AS pricing_variant,
            card_price_summaries.low_price AS pricing_low_price,
            card_price_summaries.market_price AS pricing_market_price,
            card_price_summaries.mid_price AS pricing_mid_price,
            card_price_summaries.high_price AS pricing_high_price,
            card_price_summaries.direct_low_price AS pricing_direct_low_price,
            card_price_summaries.trend_price AS pricing_trend_price,
            card_price_summaries.source_updated_at AS pricing_updated_at,
            card_price_summaries.source_url AS pricing_source_url,
            card_price_summaries.updated_at AS pricing_refreshed_at
        FROM card_price_summaries
        WHERE card_id = ?
        LIMIT 1
        """,
        (card_id,),
    ).fetchone()
    if row is None:
        return None
    return pricing_summary_from_row(row, pricing_mode=pricing_mode)


def grade_curve_multiplier(target_grade: str, source_grade: str) -> float | None:
    target_anchor = DEFAULT_GRADE_CURVE.get(normalize_grade(target_grade) or "")
    source_anchor = DEFAULT_GRADE_CURVE.get(normalize_grade(source_grade) or "")
    if target_anchor is None or source_anchor is None or source_anchor == 0:
        return None
    return target_anchor / source_anchor


def card_specific_grade_ratio(connection: sqlite3.Connection, card_id: str, target_grade: str, source_grade: str, grader: str) -> float | None:
    row = connection.execute(
        """
        WITH target AS (
            SELECT AVG(sale_price) AS avg_price
            FROM slab_sales
            WHERE card_id = ? AND grader = ? AND grade = ? AND accepted = 1
        ),
        source AS (
            SELECT AVG(sale_price) AS avg_price
            FROM slab_sales
            WHERE card_id = ? AND grader = ? AND grade = ? AND accepted = 1
        )
        SELECT target.avg_price AS target_avg, source.avg_price AS source_avg
        FROM target, source
        """,
        (card_id, grader, target_grade, card_id, grader, source_grade),
    ).fetchone()
    if row is None or row["target_avg"] is None or row["source_avg"] in {None, 0}:
        return None
    return float(row["target_avg"]) / float(row["source_avg"])


def upsert_slab_sale(connection: sqlite3.Connection, sale: dict[str, Any], now: str | None = None) -> None:
    now = now or utc_now()
    bucket_key = sale.get("bucketKey") or bucket_key_for_card(connection, sale["cardID"])
    connection.execute(
        """
        INSERT INTO slab_sales (
            card_id,
            grader,
            grade,
            sale_price,
            currency_code,
            sale_date,
            source,
            source_listing_id,
            source_url,
            cert_number,
            title,
            bucket_key,
            accepted,
            source_payload_json,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sale["cardID"],
            sale["grader"],
            normalize_grade(sale["grade"]),
            sale["salePrice"],
            sale.get("currencyCode", "USD"),
            sale["saleDate"],
            sale["source"],
            sale.get("sourceListingID"),
            sale.get("sourceURL"),
            sale.get("certNumber"),
            sale.get("title"),
            bucket_key,
            1 if sale.get("accepted", True) else 0,
            json.dumps(sale.get("sourcePayload", sale), sort_keys=True),
            now,
        ),
    )


def normalize_slab_sale_input(sale: dict[str, Any]) -> dict[str, Any]:
    card_id = sale.get("cardID") or sale.get("card_id")
    grader = str(sale.get("grader") or "").strip().upper()
    grade = normalize_grade(sale.get("grade"))
    sale_price = cleaned_price(sale.get("salePrice", sale.get("sale_price")))
    currency_code = str(sale.get("currencyCode", sale.get("currency_code")) or "USD").strip().upper()
    sale_date = parse_datetime_value(sale.get("saleDate") or sale.get("sale_date"))
    source = str(sale.get("source") or "manual_import").strip().lower()
    source_listing_id = sale.get("sourceListingID") or sale.get("source_listing_id")
    source_url = sale.get("sourceURL") or sale.get("source_url")
    cert_number = sale.get("certNumber") or sale.get("cert_number")
    title = sale.get("title")

    if not card_id:
        raise ValueError("Missing cardID")
    if not grader:
        raise ValueError("Missing grader")
    if grade is None:
        raise ValueError("Missing or invalid grade")
    if sale_price is None:
        raise ValueError("Missing or invalid salePrice")
    if sale_date is None:
        raise ValueError("Missing or invalid saleDate")

    normalized = {
        "cardID": str(card_id),
        "grader": grader,
        "grade": grade,
        "salePrice": sale_price,
        "currencyCode": currency_code,
        "saleDate": sale_date.isoformat(),
        "source": source,
        "sourceListingID": str(source_listing_id) if source_listing_id else None,
        "sourceURL": str(source_url) if source_url else None,
        "certNumber": str(cert_number) if cert_number else None,
        "title": str(title) if title else None,
        "bucketKey": sale.get("bucketKey"),
        "accepted": bool(sale.get("accepted", True)),
        "sourcePayload": sale.get("sourcePayload", sale),
    }
    return normalized


def slab_sale_exists(connection: sqlite3.Connection, sale: dict[str, Any]) -> bool:
    if sale.get("sourceListingID"):
        row = connection.execute(
            """
            SELECT 1
            FROM slab_sales
            WHERE source = ? AND source_listing_id = ?
            LIMIT 1
            """,
            (sale["source"], sale["sourceListingID"]),
        ).fetchone()
        return row is not None

    row = connection.execute(
        """
        SELECT 1
        FROM slab_sales
        WHERE card_id = ?
          AND grader = ?
          AND grade = ?
          AND sale_price = ?
          AND sale_date = ?
          AND source = ?
          AND COALESCE(cert_number, '') = ?
          AND COALESCE(title, '') = ?
        LIMIT 1
        """,
        (
            sale["cardID"],
            sale["grader"],
            sale["grade"],
            sale["salePrice"],
            sale["saleDate"],
            sale["source"],
            sale.get("certNumber") or "",
            sale.get("title") or "",
        ),
    ).fetchone()
    return row is not None


def affected_grade_targets_for_card(connection: sqlite3.Connection, card_id: str, grader: str) -> set[str]:
    rows = connection.execute(
        """
        SELECT grade
        FROM slab_sales
        WHERE card_id = ? AND grader = ? AND accepted = 1
        UNION
        SELECT grade
        FROM slab_price_snapshots
        WHERE card_id = ? AND grader = ?
        """,
        (card_id, grader, card_id, grader),
    ).fetchall()
    return {row["grade"] for row in rows if row["grade"]}


def import_slab_sales(connection: sqlite3.Connection, sales: list[dict[str, Any]]) -> dict[str, Any]:
    inserted = 0
    skipped_duplicates = 0
    errors: list[dict[str, Any]] = []
    affected_pairs: set[tuple[str, str]] = set()

    for index, raw_sale in enumerate(sales):
        try:
            normalized = normalize_slab_sale_input(raw_sale)
            if slab_sale_exists(connection, normalized):
                skipped_duplicates += 1
                continue

            upsert_slab_sale(connection, normalized)
            inserted += 1
            affected_pairs.add((normalized["cardID"], normalized["grader"]))
        except Exception as error:
            errors.append({
                "index": index,
                "error": str(error),
                "cardID": raw_sale.get("cardID") or raw_sale.get("card_id"),
            })

    recomputed: list[dict[str, str]] = []
    for card_id, grader in sorted(affected_pairs):
        for grade in sorted(affected_grade_targets_for_card(connection, card_id, grader)):
            snapshot = recompute_slab_price_snapshot(connection, card_id, grader, grade)
            if snapshot is not None:
                recomputed.append({"cardID": card_id, "grader": grader, "grade": grade})

    return {
        "inserted": inserted,
        "skippedDuplicates": skipped_duplicates,
        "recomputed": recomputed,
        "errors": errors,
    }


def slab_sales_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    grader: str | None = None,
    grade: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    clauses = ["card_id = ?"]
    parameters: list[Any] = [card_id]

    if grader:
        clauses.append("grader = ?")
        parameters.append(grader)
    if grade:
        clauses.append("grade = ?")
        parameters.append(normalize_grade(grade))

    parameters.append(limit)
    rows = connection.execute(
        f"""
        SELECT
            card_id,
            grader,
            grade,
            sale_price,
            currency_code,
            sale_date,
            source,
            source_listing_id,
            source_url,
            cert_number,
            title,
            bucket_key,
            accepted
        FROM slab_sales
        WHERE {' AND '.join(clauses)}
        ORDER BY sale_date DESC, id DESC
        LIMIT ?
        """,
        parameters,
    ).fetchall()

    return [
        {
            "cardID": row["card_id"],
            "grader": row["grader"],
            "grade": row["grade"],
            "salePrice": row["sale_price"],
            "currencyCode": row["currency_code"],
            "saleDate": row["sale_date"],
            "source": row["source"],
            "sourceListingID": row["source_listing_id"],
            "sourceURL": row["source_url"],
            "certNumber": row["cert_number"],
            "title": row["title"],
            "bucketKey": row["bucket_key"],
            "accepted": bool(row["accepted"]),
        }
        for row in rows
    ]


def load_slab_sales_file(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    payload = json.loads(path.read_text())
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("sales"), list):
        return payload["sales"]
    raise ValueError("Unsupported slab sales file format")


def upsert_slab_price_snapshot(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    grader: str,
    grade: str,
    pricing_tier: str,
    currency_code: str,
    low_price: float | None,
    market_price: float | None,
    mid_price: float | None,
    high_price: float | None,
    last_sale_price: float | None,
    last_sale_date: str | None,
    comp_count: int,
    recent_comp_count: int,
    confidence_level: int,
    confidence_label: str,
    bucket_key: str | None,
    source_url: str | None,
    source: str,
    summary: str,
    payload: dict[str, Any] | None = None,
) -> None:
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        raise ValueError("Missing or invalid slab grade")

    source_payload = dict(payload or {})
    source_payload.setdefault("source", source)
    source_payload.setdefault("summary", summary)

    connection.execute(
        """
        INSERT OR REPLACE INTO slab_price_snapshots (
            card_id,
            grader,
            grade,
            pricing_tier,
            currency_code,
            low_price,
            market_price,
            mid_price,
            high_price,
            last_sale_price,
            last_sale_date,
            comp_count,
            recent_comp_count,
            confidence_level,
            confidence_label,
            bucket_key,
            source_url,
            source_payload_json,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card_id,
            grader,
            normalized_grade,
            pricing_tier,
            currency_code,
            low_price,
            market_price,
            mid_price,
            high_price,
            last_sale_price,
            last_sale_date,
            comp_count,
            recent_comp_count,
            confidence_level,
            confidence_label,
            bucket_key,
            source_url,
            json.dumps(source_payload, sort_keys=True),
            utc_now(),
        ),
    )
    connection.commit()


def slab_price_snapshot_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    grader: str,
    grade: str,
) -> dict[str, Any] | None:
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    row = connection.execute(
        """
        SELECT *
        FROM slab_price_snapshots
        WHERE card_id = ? AND grader = ? AND grade = ?
        LIMIT 1
        """,
        (card_id, grader, normalized_grade),
    ).fetchone()
    if row is None:
        return None

    source_payload = json.loads(row["source_payload_json"] or "{}")
    source = source_payload.get("source", "psa_comp_model")

    return {
        "source": source,
        "currencyCode": row["currency_code"],
        "variant": f"{grader} {normalized_grade}",
        "low": row["low_price"],
        "market": row["market_price"],
        "mid": row["mid_price"],
        "high": row["high_price"],
        "directLow": None,
        "trend": row["market_price"],
        "updatedAt": row["updated_at"],
        "refreshedAt": row["updated_at"],
        "sourceURL": row["source_url"],
        "pricingMode": PSA_GRADE_PRICING_MODE,
        "snapshotAgeHours": pricing_snapshot_age_hours(row["updated_at"]),
        "freshnessWindowHours": DEFAULT_PRICING_FRESHNESS_HOURS,
        "isFresh": pricing_snapshot_is_fresh(
            row["updated_at"],
            freshness_window_hours=DEFAULT_PRICING_FRESHNESS_HOURS,
        ),
        "grader": grader,
        "grade": normalized_grade,
        "pricingTier": row["pricing_tier"],
        "confidenceLabel": row["confidence_label"],
        "confidenceLevel": row["confidence_level"],
        "compCount": row["comp_count"],
        "recentCompCount": row["recent_comp_count"],
        "lastSoldPrice": row["last_sale_price"],
        "lastSoldAt": row["last_sale_date"],
        "bucketKey": row["bucket_key"],
        "methodologySummary": source_payload.get("summary"),
    }


def contextual_pricing_summary_for_card(
    connection: sqlite3.Connection,
    card_id: str,
    *,
    grader: str | None = None,
    grade: str | None = None,
) -> dict[str, Any] | None:
    if grader and grade:
        slab_summary = slab_price_snapshot_for_card(connection, card_id, grader, grade)
        if slab_summary is None:
            slab_summary = recompute_slab_price_snapshot(connection, card_id, grader, grade)
        return slab_summary

    return raw_pricing_summary_for_card(connection, card_id, pricing_mode=RAW_PRICING_MODE)


def recompute_slab_price_snapshot(
    connection: sqlite3.Connection,
    card_id: str,
    grader: str,
    grade: str,
) -> dict[str, Any] | None:
    normalized_grade = normalize_grade(grade)
    if normalized_grade is None:
        return None

    bucket_key = bucket_key_for_card(connection, card_id)
    now = datetime.now(UTC)
    recent_cutoff = (now - timedelta(days=365)).isoformat()

    exact_rows = connection.execute(
        """
        SELECT sale_price, sale_date, currency_code, source_url
        FROM slab_sales
        WHERE card_id = ? AND grader = ? AND grade = ? AND accepted = 1
        ORDER BY sale_date DESC
        """,
        (card_id, grader, normalized_grade),
    ).fetchall()

    recent_exact_rows = [row for row in exact_rows if row["sale_date"] >= recent_cutoff]
    exact_entries = [
        (float(row["sale_price"]), datetime.fromisoformat(row["sale_date"].replace("Z", "+00:00")))
        for row in recent_exact_rows
    ]
    exact_all_entries = [
        (float(row["sale_price"]), datetime.fromisoformat(row["sale_date"].replace("Z", "+00:00")))
        for row in exact_rows
    ]

    snapshot: dict[str, Any] | None = None

    if exact_entries:
        market_price = weighted_average_amount(exact_entries)
        low_price = round(min(amount for amount, _ in exact_entries), 2)
        high_price = round(max(amount for amount, _ in exact_entries), 2)
        most_recent_amount, most_recent_at = exact_all_entries[0]
        confidence_level, confidence_label = confidence_level_for_sales(most_recent_at, len(exact_entries))

        snapshot = {
            "source": "psa_comp_model",
            "pricingTier": "exact_same_grade",
            "currencyCode": recent_exact_rows[0]["currency_code"],
            "low": low_price,
            "market": market_price,
            "mid": market_price,
            "high": high_price,
            "lastSalePrice": round(most_recent_amount, 2),
            "lastSaleDate": most_recent_at.isoformat(),
            "compCount": len(exact_rows),
            "recentCompCount": len(exact_entries),
            "confidenceLevel": confidence_level,
            "confidenceLabel": confidence_label,
            "bucketKey": bucket_key,
            "sourceURL": recent_exact_rows[0]["source_url"],
            "summary": "Exact same card and PSA grade comps.",
        }

    if snapshot is None:
        neighbor_rows = connection.execute(
            """
            SELECT grade, sale_price, sale_date, currency_code
            FROM slab_sales
            WHERE card_id = ? AND grader = ? AND grade != ? AND accepted = 1
            ORDER BY sale_date DESC
            """,
            (card_id, grader, normalized_grade),
        ).fetchall()

        neighbor_groups: dict[str, list[tuple[float, datetime, str]]] = {}
        for row in neighbor_rows:
            if row["sale_date"] < recent_cutoff:
                continue
            sale_date = datetime.fromisoformat(row["sale_date"].replace("Z", "+00:00"))
            neighbor_groups.setdefault(row["grade"], []).append((float(row["sale_price"]), sale_date, row["currency_code"]))

        estimates: list[tuple[float, float, str]] = []
        for source_grade, entries in neighbor_groups.items():
            average = weighted_average_amount([(amount, sold_at) for amount, sold_at, _ in entries])
            if average is None:
                continue
            multiplier = card_specific_grade_ratio(connection, card_id, normalized_grade, source_grade, grader)
            if multiplier is None:
                multiplier = grade_curve_multiplier(normalized_grade, source_grade)
            if multiplier is None:
                continue

            source_grade_value = numeric_grade_value(source_grade)
            target_grade_value = numeric_grade_value(normalized_grade)
            if source_grade_value is None or target_grade_value is None:
                continue

            distance = abs(target_grade_value - source_grade_value)
            weight = 1.0 / (1.0 + distance)
            estimates.append((round(average * multiplier, 2), weight, entries[0][2]))

        if estimates:
            weighted_sum = sum(value * weight for value, weight, _ in estimates)
            total_weight = sum(weight for _, weight, _ in estimates)
            market_price = round(weighted_sum / total_weight, 2)
            low_price = round(min(value for value, _, _ in estimates), 2)
            high_price = round(max(value for value, _, _ in estimates), 2)
            currency_code = estimates[0][2]
            snapshot = {
                "source": "psa_comp_model",
                "pricingTier": "same_card_grade_ladder",
                "currencyCode": currency_code,
                "low": low_price,
                "market": market_price,
                "mid": market_price,
                "high": high_price,
                "lastSalePrice": None,
                "lastSaleDate": None,
                "compCount": len(neighbor_rows),
                "recentCompCount": len(estimates),
                "confidenceLevel": 2,
                "confidenceLabel": "Medium",
                "bucketKey": bucket_key,
                "sourceURL": None,
                "summary": "Modeled from nearby PSA grades of the same card.",
            }

    if snapshot is None and bucket_key and exact_all_entries:
        target_last_amount, target_last_at = exact_all_entries[0]
        current_bucket_rows = connection.execute(
            """
            SELECT sale_price
            FROM slab_sales
            WHERE bucket_key = ? AND grader = ? AND grade = ? AND accepted = 1 AND sale_date >= ?
            """,
            (bucket_key, grader, normalized_grade, recent_cutoff),
        ).fetchall()

        historical_window_start = (target_last_at - timedelta(days=60)).isoformat()
        historical_window_end = (target_last_at + timedelta(days=60)).isoformat()
        historical_bucket_rows = connection.execute(
            """
            SELECT sale_price
            FROM slab_sales
            WHERE bucket_key = ? AND grader = ? AND grade = ? AND accepted = 1 AND sale_date BETWEEN ? AND ?
            """,
            (bucket_key, grader, normalized_grade, historical_window_start, historical_window_end),
        ).fetchall()

        if current_bucket_rows and historical_bucket_rows:
            current_average = sum(float(row["sale_price"]) for row in current_bucket_rows) / len(current_bucket_rows)
            historical_average = sum(float(row["sale_price"]) for row in historical_bucket_rows) / len(historical_bucket_rows)
            if historical_average > 0:
                market_price = round(float(target_last_amount) * (current_average / historical_average), 2)
                snapshot = {
                    "source": "psa_comp_model",
                    "pricingTier": "bucket_index_model",
                    "currencyCode": "USD",
                    "low": round(market_price * 0.9, 2),
                    "market": market_price,
                    "mid": market_price,
                    "high": round(market_price * 1.1, 2),
                    "lastSalePrice": round(target_last_amount, 2),
                    "lastSaleDate": target_last_at.isoformat(),
                    "compCount": len(exact_rows) + len(current_bucket_rows),
                    "recentCompCount": len(current_bucket_rows),
                    "confidenceLevel": 1,
                    "confidenceLabel": "Low",
                    "bucketKey": bucket_key,
                    "sourceURL": None,
                    "summary": "Modeled from the card's last slab sale adjusted by its broader bucket.",
                }

    if snapshot is None:
        connection.execute(
            "DELETE FROM slab_price_snapshots WHERE card_id = ? AND grader = ? AND grade = ?",
            (card_id, grader, normalized_grade),
        )
        connection.commit()
        return None

    upsert_slab_price_snapshot(
        connection,
        card_id=card_id,
        grader=grader,
        grade=normalized_grade,
        pricing_tier=snapshot["pricingTier"],
        currency_code=snapshot["currencyCode"],
        low_price=snapshot["low"],
        market_price=snapshot["market"],
        mid_price=snapshot["mid"],
        high_price=snapshot["high"],
        last_sale_price=snapshot["lastSalePrice"],
        last_sale_date=snapshot["lastSaleDate"],
        comp_count=snapshot["compCount"],
        recent_comp_count=snapshot["recentCompCount"],
        confidence_level=snapshot["confidenceLevel"],
        confidence_label=snapshot["confidenceLabel"],
        bucket_key=snapshot["bucketKey"],
        source_url=snapshot["sourceURL"],
        source=snapshot["source"],
        summary=snapshot["summary"],
        payload={"bucketKey": snapshot["bucketKey"]},
    )
    return slab_price_snapshot_for_card(connection, card_id, grader, normalized_grade)


def recompute_all_slab_price_snapshots(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        """
        SELECT DISTINCT card_id, grader, grade
        FROM slab_sales
        WHERE accepted = 1
        ORDER BY card_id, grader, grade
        """
    ).fetchall()

    for row in rows:
        recompute_slab_price_snapshot(connection, row["card_id"], row["grader"], row["grade"])


def build_query_embedding(payload: dict[str, Any], repo_root: Path) -> QueryEmbedding:
    token_strings = [token["text"] for token in payload.get("recognizedTokens", [])]
    canonical_collector_number = canonicalize_collector_number(payload.get("collectorNumber") or "")
    parts = token_strings + [
        payload.get("fullRecognizedText") or "",
        payload.get("metadataStripRecognizedText") or "",
        payload.get("topLabelRecognizedText") or "",
        payload.get("bottomLeftRecognizedText") or "",
        payload.get("bottomRightRecognizedText") or "",
        payload.get("collectorNumber") or "",
        canonical_collector_number,
        payload.get("promoCodeHint") or "",
        " ".join(payload.get("setHintTokens") or []),
    ]
    metadata_embedding = embedding_for_parts(parts, dimension=METADATA_EMBEDDING_DIMENSION)

    image_embedding: list[float] | None = None
    encoded_image = payload.get("image", {}).get("jpegBase64")
    if encoded_image:
        try:
            image_embedding = featureprint_for_bytes(decode_base64_image(encoded_image), repo_root)
        except Exception:
            image_embedding = None

    return QueryEmbedding(
        image_embedding=image_embedding,
        metadata_embedding=metadata_embedding,
    )


def direct_lookup_candidate_indices(index: CatalogIndex, payload: dict[str, Any]) -> list[int]:
    collector_number = payload.get("collectorNumber") or ""
    canonical_collector_number = canonicalize_collector_number(collector_number).lower()
    collector_keys = collector_number_lookup_keys(collector_number)
    if not collector_keys:
        return []

    recognized_text = recognized_text_for_payload(payload)
    set_hints = structured_set_hints_for_payload(payload)
    pokedex_hints = recognized_pokedex_number_hints(recognized_text)

    candidate_indices: list[int] = []
    seen: set[int] = set()
    preferred_keys: list[str] = []
    if "/" in canonical_collector_number and canonical_collector_number in index.collector_number_lookup:
        preferred_keys.append(canonical_collector_number)
    if not preferred_keys:
        preferred_keys = sorted(collector_keys, key=lambda key: ("/" not in key, -len(key)))

    for key in preferred_keys:
        for card_index in index.collector_number_lookup.get(key, []):
            if card_index in seen:
                continue
            seen.add(card_index)
            candidate_indices.append(card_index)

    if not candidate_indices:
        return []

    if set_hints:
        set_filtered = [
            card_index for card_index in candidate_indices
            if card_matches_set_hint(index.cards[card_index], set_hints)
        ]
        if not set_filtered:
            return []

    exact_number = canonicalize_collector_number(collector_number).lower()
    query_tokens = set(tokenize(recognized_text))

    def candidate_sort_key(card_index: int) -> tuple[int, int, int, str, str]:
        card = index.cards[card_index]
        exact_number_match = 1 if collector_numbers_equivalent(collector_number, card.number) else 0
        set_hint_match = 1 if card_matches_set_hint(card, set_hints) else 0
        pokedex_match = 1 if pokedex_hints and not set(card.national_pokedex_numbers).isdisjoint(pokedex_hints) else 0
        name_overlap = len(query_tokens & set(tokenize(card.name)))
        return (-exact_number_match, -set_hint_match, -pokedex_match, -name_overlap, card.name, card.number)

    candidate_indices.sort(key=candidate_sort_key)
    return candidate_indices[:12]


def direct_lookup_has_name_support(index: CatalogIndex, payload: dict[str, Any], candidate_indices: list[int]) -> bool:
    if not candidate_indices:
        return False

    query_tokens = {
        token
        for token in tokenize(recognized_text_for_payload(payload))
        if len(token) > 1 and token not in GENERIC_CARD_NAME_TOKENS
    }
    if not query_tokens:
        return False

    for card_index in candidate_indices[:3]:
        name_tokens = {
            token
            for token in tokenize(index.cards[card_index].name)
            if len(token) > 1 and token not in GENERIC_CARD_NAME_TOKENS
        }
        if name_tokens and not name_tokens.isdisjoint(query_tokens):
            return True

    return False


def direct_lookup_has_exact_candidate(index: CatalogIndex, payload: dict[str, Any], candidate_indices: list[int]) -> bool:
    collector_number = payload.get("collectorNumber") or ""
    if not collector_number or not candidate_indices:
        return False

    for card_index in candidate_indices[:3]:
        if collector_numbers_equivalent(collector_number, index.cards[card_index].number):
            return True

    return False


def psa_label_candidate_indices(index: CatalogIndex, payload: dict[str, Any]) -> list[int]:
    label_text = " ".join(
        part for part in [
            payload.get("topLabelRecognizedText") or "",
            payload.get("fullRecognizedText") or "",
        ]
        if part
    )
    label_tokens = set(tokenize(label_text))
    if not label_tokens:
        return []

    number_hints = set(psa_label_number_hints(label_text))
    if payload.get("collectorNumber"):
        number_hints.update(collector_number_lookup_keys(payload["collectorNumber"]))

    scored: list[tuple[float, int]] = []
    for index_value, card in enumerate(index.cards):
        name_tokens = set(tokenize(card.name))
        set_tokens = set(tokenize(card.set_name))
        card_number_keys = collector_number_lookup_keys(card.number)

        name_overlap = len(label_tokens & name_tokens) / max(len(name_tokens), 1)
        set_overlap = len(label_tokens & set_tokens) / max(len(set_tokens), 1)
        number_match = 1.0 if number_hints and not card_number_keys.isdisjoint(number_hints) else 0.0

        score = number_match * 8.0 + name_overlap * 4.5 + set_overlap * 3.5
        if score > 0:
            scored.append((score, index_value))

    scored.sort(key=lambda item: (-item[0], index.cards[item[1]].name, index.cards[item[1]].number))
    return [card_index for _, card_index in scored[:20]]


def top_metadata_candidates(cards: list[IndexedCard], query_embedding: QueryEmbedding, limit: int) -> list[int]:
    scored = [
        (
            (cosine_similarity(query_embedding.metadata_embedding, card.metadata_embedding) + 1.0) / 2.0,
            index,
        )
        for index, card in enumerate(cards)
    ]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [index for _, index in scored[:limit]]


def approximate_candidate_indices(index: CatalogIndex, query_embedding: QueryEmbedding) -> list[int]:
    visual_candidates = query_ann_index(
        index.visual_ann,
        query_embedding.image_embedding,
        target_candidates=ANN_VISUAL_TARGET,
    )
    metadata_candidates = query_ann_index(
        index.metadata_ann,
        query_embedding.metadata_embedding,
        target_candidates=ANN_METADATA_TARGET,
    )

    merged: list[int] = []
    seen: set[int] = set()
    for card_index in visual_candidates + metadata_candidates:
        if card_index in seen:
            continue
        seen.add(card_index)
        merged.append(card_index)

    if len(merged) < 24:
        for card_index in top_metadata_candidates(index.cards, query_embedding, limit=48):
            if card_index in seen:
                continue
            seen.add(card_index)
            merged.append(card_index)
            if len(merged) >= 48:
                break

    if not merged:
        return list(range(len(index.cards)))

    return merged


def direct_lookup_score(card: IndexedCard, payload: dict[str, Any]) -> tuple[float, list[str], float, float]:
    collector_number = canonicalize_collector_number(payload.get("collectorNumber") or "").lower()
    recognized_text = recognized_text_for_payload(payload)
    set_hints = structured_set_hints_for_payload(payload)
    pokedex_hints = recognized_pokedex_number_hints(recognized_text)
    query_artist_tokens = recognized_artist_tokens(recognized_text)

    reasons: list[str] = ["Direct collector lookup"]
    retrieval_score = 0.36
    rerank_score = 0.0

    normalized_card_number = canonicalize_collector_number(card.number).lower()
    if collector_numbers_equivalent(collector_number, normalized_card_number):
        rerank_score += 0.34
        reasons.append("Collector number exact match")
    elif collector_number and (collector_number in normalized_card_number or normalized_card_number in collector_number):
        rerank_score += 0.08
        reasons.append("Collector number partial match")

    if card_matches_set_hint(card, set_hints):
        rerank_score += 0.05
        reasons.append("Set hint match")

    if pokedex_hints and not set(card.national_pokedex_numbers).isdisjoint(pokedex_hints):
        rerank_score += 0.10
        reasons.append("Pokedex number hint match")

    artist_tokens = {
        token
        for token in tokenize(card.artist or "")
        if len(token) > 2 and token not in {"illus", "illustration", "artist"}
    }
    if artist_tokens:
        artist_overlap = len(query_artist_tokens & artist_tokens)
        if artist_overlap >= min(2, len(artist_tokens)):
            rerank_score += 0.03
            reasons.append("Artist hint match")

    query_tokens = set(tokenize(recognized_text))
    card_name_tokens = set(tokenize(card.name))
    if card_name_tokens:
        name_overlap = len(query_tokens & card_name_tokens) / len(card_name_tokens)
        if name_overlap > 0:
            rerank_score += min(0.04, name_overlap * 0.04)
            reasons.append("Name tokens overlap")

    final_score = min(0.99, retrieval_score + rerank_score)
    return final_score, reasons, retrieval_score, rerank_score


def psa_label_score(card: IndexedCard, payload: dict[str, Any]) -> tuple[float, list[str], float, float]:
    label_text = " ".join(
        part for part in [
            payload.get("topLabelRecognizedText") or "",
            payload.get("fullRecognizedText") or "",
        ]
        if part
    )
    label_tokens = set(tokenize(label_text))
    card_name_tokens = set(tokenize(card.name))
    card_set_tokens = set(tokenize(card.set_name))
    number_hints = psa_label_number_hints(label_text)
    if payload.get("collectorNumber"):
        number_hints.update(collector_number_lookup_keys(payload["collectorNumber"]))

    reasons: list[str] = ["PSA label lookup"]
    retrieval_score = 0.42
    rerank_score = 0.0

    if number_hints and not collector_number_lookup_keys(card.number).isdisjoint(number_hints):
        rerank_score += 0.22
        reasons.append("Label number match")

    if card_name_tokens:
        name_overlap = len(label_tokens & card_name_tokens) / len(card_name_tokens)
        if name_overlap > 0:
            rerank_score += min(0.28, name_overlap * 0.28)
            reasons.append("Label name overlap")

    if card_set_tokens:
        set_overlap = len(label_tokens & card_set_tokens) / len(card_set_tokens)
        if set_overlap > 0:
            rerank_score += min(0.18, set_overlap * 0.18)
            reasons.append("Label set overlap")

    final_score = min(0.99, retrieval_score + rerank_score)
    return final_score, reasons, retrieval_score, rerank_score


def candidate_has_exact_structured_match(
    candidate: dict[str, Any],
    payload: dict[str, Any],
    resolver_path: str,
) -> bool:
    number = candidate.get("candidate", {}).get("number")
    if not number:
        return False

    candidate_number = canonicalize_collector_number(str(number)).lower()
    if not candidate_number:
        return False

    if resolver_path == "direct_lookup":
        collector_number = payload.get("collectorNumber") or ""
        canonical_query = canonicalize_collector_number(collector_number).lower()
        if not canonical_query:
            return False
        if collector_numbers_equivalent(collector_number, candidate_number):
            return True
        query_keys = collector_number_lookup_keys(collector_number)
        if not query_keys:
            return False
        return candidate_number in query_keys or not collector_number_lookup_keys(candidate_number).isdisjoint(query_keys)

    if resolver_path == "psa_label":
        candidate_keys = collector_number_lookup_keys(candidate_number)
        label_hints = psa_label_number_hints(payload.get("topLabelRecognizedText") or "")
        if payload.get("collectorNumber"):
            label_hints.update(collector_number_lookup_keys(payload["collectorNumber"]))
        return not candidate_keys.isdisjoint(label_hints)

    return False


def rerank_card(card: IndexedCard, payload: dict[str, Any], query_embedding: QueryEmbedding) -> tuple[float, list[str], float, float]:
    recognized_text = (payload.get("fullRecognizedText") or "").lower()
    collector_number = canonicalize_collector_number(payload.get("collectorNumber") or "").lower()
    query_tokens = set(tokenize(recognized_text))
    card_name_tokens = set(tokenize(card.name))
    card_set_tokens = set(tokenize(card.set_name))

    reasons: list[str] = []
    metadata_similarity = (cosine_similarity(query_embedding.metadata_embedding, card.metadata_embedding) + 1.0) / 2.0
    visual_similarity = None

    if query_embedding.image_embedding is not None and card.image_embedding is not None:
        visual_similarity = image_similarity(query_embedding.image_embedding, card.image_embedding)
        reasons.append("Image feature print match")
    else:
        reasons.append("Metadata retrieval fallback")

    retrieval_score = (
        visual_similarity * 0.82 + metadata_similarity * 0.18
        if visual_similarity is not None
        else metadata_similarity
    )

    rerank_score = 0.0
    if collector_number:
        normalized_card_number = canonicalize_collector_number(card.number)
        normalized_collector_number = collector_number

        if normalized_collector_number == normalized_card_number:
            rerank_score += 0.52
            reasons.append("Collector number exact match")
        elif normalized_collector_number in normalized_card_number or normalized_card_number in normalized_collector_number:
            rerank_score += 0.22
            reasons.append("Collector number partial match")

    if card_name_tokens:
        name_overlap = len(query_tokens & card_name_tokens) / len(card_name_tokens)
        if name_overlap > 0:
            rerank_score += name_overlap * 0.34
            reasons.append("Name tokens overlap")

    if card_set_tokens:
        set_overlap = len(query_tokens & card_set_tokens) / len(card_set_tokens)
        if set_overlap > 0:
            rerank_score += set_overlap * 0.14
            reasons.append("Set tokens overlap")

    final_score = min(0.99, retrieval_score * 0.56 + rerank_score)
    return final_score, reasons, retrieval_score, rerank_score


def confidence_for_candidates(
    candidates: list[dict[str, Any]],
    has_collector_number: bool,
    resolver_path: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    if not candidates:
        return "low"

    top = candidates[0]
    delta = top["finalScore"] - candidates[1]["finalScore"] if len(candidates) > 1 else top["finalScore"]
    exact_structured_match = (
        candidate_has_exact_structured_match(top, payload or {}, resolver_path or "")
        if resolver_path in {"direct_lookup", "psa_label"}
        else False
    )

    if exact_structured_match and top["finalScore"] >= 0.72:
        return "high"
    if exact_structured_match and top["finalScore"] >= 0.56:
        return "medium"

    # Visual fallback with very high confidence: allow reasonable thresholds
    if resolver_path == "visual_fallback":
        # High confidence: excellent match with clear winner
        if top["finalScore"] >= 0.92 and delta >= 0.10 and has_collector_number:
            return "high"
        # Medium-high: very good match, slightly lower bar
        if top["finalScore"] >= 0.85 and delta >= 0.08 and has_collector_number:
            return "high"
        # Medium confidence
        if top["finalScore"] >= 0.70 and delta >= 0.08:
            return "medium"
        return "low"

    # Direct lookup or standard matching
    if top["finalScore"] >= 0.76 and delta >= 0.12 and has_collector_number:
        return "high"
    if top["finalScore"] >= 0.44 and delta >= 0.06:
        return "medium"
    return "low"
