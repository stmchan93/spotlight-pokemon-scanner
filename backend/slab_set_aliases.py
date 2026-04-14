from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SlabSetAliasResolution:
    scopes: tuple[str, ...]
    matched_alias: str | None
    source: str | None


def resolve_slab_set_aliases(
    *,
    grader: str | None,
    label_text: str,
    parsed_label_text: tuple[str, ...] = (),
) -> SlabSetAliasResolution:
    if _normalize_grader(grader) != "PSA":
        return SlabSetAliasResolution(scopes=(), matched_alias=None, source=None)

    normalized_texts = tuple(
        value
        for value in (
            _normalize_alias_text(text)
            for text in (label_text, *parsed_label_text)
        )
        if value
    )
    if not normalized_texts:
        return SlabSetAliasResolution(scopes=(), matched_alias=None, source=None)

    matches: list[tuple[int, dict[str, Any], str]] = []
    for entry in _load_alias_entries():
        scopes = tuple(
            str(value or "").strip()
            for value in entry.get("scopes") or []
            if str(value or "").strip()
        )
        if not scopes:
            continue
        for alias in entry.get("aliases") or []:
            alias_text = str(alias or "").strip()
            normalized_alias = _normalize_alias_text(alias_text)
            if not normalized_alias:
                continue
            if any(normalized_alias in text for text in normalized_texts):
                matches.append((len(normalized_alias), entry, alias_text))

    if not matches:
        return SlabSetAliasResolution(scopes=(), matched_alias=None, source=None)

    matches.sort(key=lambda item: item[0], reverse=True)
    _, matched_entry, matched_alias = matches[0]
    scopes = tuple(
        dict.fromkeys(
            str(value or "").strip()
            for value in matched_entry.get("scopes") or []
            if str(value or "").strip()
        )
    )
    return SlabSetAliasResolution(
        scopes=scopes,
        matched_alias=matched_alias,
        source="psa_alias_map",
    )


def _normalize_alias_text(value: str) -> str:
    normalized = str(value or "").upper()
    normalized = re.sub(r"\b20\d{2}\b", " ", normalized)
    normalized = normalized.replace("&", " AND ")
    normalized = re.sub(r"[^A-Z0-9]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _normalize_grader(value: str | None) -> str:
    return str(value or "").strip().upper()


@lru_cache(maxsize=1)
def _load_alias_entries() -> tuple[dict[str, Any], ...]:
    for path in _alias_entry_paths():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, list):
            continue
        return tuple(entry for entry in payload if isinstance(entry, dict))
    return ()


def _alias_entry_paths() -> tuple[Path, ...]:
    module_dir = Path(__file__).resolve().parent
    candidates = (
        module_dir / "data" / "slab_set_aliases.json",
        module_dir / "backend" / "data" / "slab_set_aliases.json",
        module_dir.parent / "backend" / "data" / "slab_set_aliases.json",
    )
    # Preserve search order while removing duplicates.
    return tuple(dict.fromkeys(candidates))
