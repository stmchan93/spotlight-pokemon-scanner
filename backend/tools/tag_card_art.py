"""Offline job: tag each card ARTWORK once with a vision model (Message Batches API).

Flow (never run inside the server):

  --estimate            token + $ estimate for the selected groups, no network
  --dry-run             fetch images, write the batch JSONL + manifest locally
  --submit              same, then POST the batch(es) to Anthropic
  --collect BATCH_ID    fetch results, validate, write groups/members/tags
  --sync-members        rewrite membership of already-tagged groups (no network)

Selection: art groups (art_groups.py) with no tags yet, or tagged under an older
PROMPT_VERSION / VOCAB_VERSION. Narrow with --limit N and --card-ids-file.

Catalog facts (artist, set, rarity, language, types, main Pokémon dex) are never
asked of the model; the palette is computed locally with Pillow.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import os
import json
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from anthropic_adapter import ANTHROPIC_VERSION, anthropic_api_key  # noqa: E402
from art_groups import ArtGroup, compute_art_groups  # noqa: E402
from art_search import (  # noqa: E402
    ART_FACETS,
    MIN_CONFIDENCE,
    PALETTE_COLORS,
    POKEMON_ROLES,
    VOCAB_VERSION,
    build_pokemon_name_index,
    resolve_pokemon_name,
)
from catalog_tools import apply_schema, connect, utc_now  # noqa: E402

PROMPT_VERSION = "p1"
DEFAULT_MODEL = "claude-sonnet-5-5"
# List $/MTok (input, output); the Batches API bills half of these.
MODEL_PRICES = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
}
BATCH_DISCOUNT = 0.5
MAX_TOKENS = 4096
MAX_EDGE = 768
JPEG_QUALITY = 85
MAX_OBJECTS = 8
MAX_CHARACTERS = 5
MAX_PER_LIST = 4
# Nominal 63x88mm card at 768px long edge, for --estimate without fetching.
NOMINAL_IMAGE_SIZE = (550, 768)
EST_OUTPUT_TOKENS = 450
DEFAULT_BATCH_SIZE = 1000
ANTHROPIC_BATCHES_URL = "https://api.anthropic.com/v1/messages/batches"
DEFAULT_OUT_DIR = BACKEND_ROOT / "data" / "art_tag_batches"
_CUSTOM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

MODEL_LIST_FACETS = ("scene", "weather_time", "activity", "mood", "objects")
MODEL_SINGLE_FACETS = ("art_style", "composition")

SYSTEM_PROMPT = f"""You tag the ARTWORK of one Pokémon trading card for a picture search ("Pikachu sleeping", "beach", "rain").

Describe only what is visible in the illustration. Ignore card text, borders, attack boxes, HP, set symbols and rarity marks.

Fields:
- scene, weather_time, activity, mood, objects: pick from the allowed values only; each entry has a confidence from 0 to 1 (how sure you are it is clearly in the picture). Up to {MAX_PER_LIST} entries each ({MAX_OBJECTS} for objects). Use an empty list when nothing fits; never guess to fill a field.
- art_style: the single best rendering style. composition: the single best framing.
- appearing_pokemon: every Pokémon you can identify in the picture, by English species name (for example "Pikachu", "Mr. Mime"), with role main (the card's subject), secondary, background or cameo, and a confidence from 0 to 1. Leave out any creature you cannot name with confidence.
- characters: names of human trainers or characters shown, only if you are sure (at most {MAX_CHARACTERS}); otherwise an empty list.
- alt_text: one plain sentence describing the picture for a screen reader.

Weather "none_visible" means the sky/time cannot be seen. Use "other" only when something is clearly present but no value fits."""


def output_schema() -> dict[str, Any]:
    def scored(values: tuple[str, ...]) -> dict[str, Any]:
        return {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["value", "confidence"],
                "properties": {
                    "value": {"type": "string", "enum": list(values)},
                    "confidence": {"type": "number"},
                },
            },
        }

    properties: dict[str, Any] = {facet: scored(ART_FACETS[facet]) for facet in MODEL_LIST_FACETS}
    for facet in MODEL_SINGLE_FACETS:
        properties[facet] = {"type": "string", "enum": list(ART_FACETS[facet])}
    properties["appearing_pokemon"] = {
        "type": "array",
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["name", "role", "confidence"],
            "properties": {
                "name": {"type": "string"},
                "role": {"type": "string", "enum": list(POKEMON_ROLES)},
                "confidence": {"type": "number"},
            },
        },
    }
    properties["characters"] = {"type": "array", "items": {"type": "string"}}
    properties["alt_text"] = {"type": "string"}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties),
        "properties": properties,
    }


# --- selection ----------------------------------------------------------------


@dataclass
class Candidate:
    group: ArtGroup
    card_name: str
    image_url: str


def select_groups(
    conn: sqlite3.Connection,
    groups: list[ArtGroup],
    *,
    card_ids: set[str] | None = None,
    limit: int | None = None,
    prompt_version: str = PROMPT_VERSION,
    vocab_version: str = VOCAB_VERSION,
) -> list[Candidate]:
    existing = {
        str(r[0]): (str(r[1]), str(r[2]), str(r[3]))
        for r in conn.execute("SELECT art_group_id, prompt_version, vocab_version, review_state FROM card_art_groups")
    }
    picked: list[Candidate] = []
    for group in groups:
        if card_ids is not None and not card_ids.intersection(group.members):
            continue
        current = existing.get(group.art_group_id)
        # Human-reviewed groups are never overwritten by an automatic re-tag.
        if current is not None and (current[:2] == (prompt_version, vocab_version) or current[2] != "auto"):
            continue
        row = conn.execute(
            "SELECT name, image_url FROM cards WHERE id = ?", (group.representative_card_id,)
        ).fetchone()
        if row is None or not row[1]:
            continue
        picked.append(Candidate(group, str(row[0] or ""), str(row[1])))
        if limit is not None and len(picked) >= limit:
            break
    return picked


# --- images -------------------------------------------------------------------


def fetch_image(url: str, *, timeout: int = 20) -> bytes:
    request = Request(url, headers={"User-Agent": "spotlight-art-tagger/1"})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def nearest_palette_color(rgb: tuple[int, int, int]) -> str:
    return min(
        PALETTE_COLORS,
        key=lambda name: sum((a - b) ** 2 for a, b in zip(rgb, PALETTE_COLORS[name])),
    )


def compute_palette(image: Any, *, max_colors: int = 3, min_share: float = 0.08) -> list[dict[str, Any]]:
    """Quantize to 8 colours, snap each to the named palette, keep the top shares."""
    small = image.convert("RGB")
    small.thumbnail((128, 128))
    quantized = small.quantize(colors=8)
    palette = quantized.getpalette() or []
    counts = quantized.getcolors() or []
    total = sum(count for count, _ in counts) or 1
    shares: dict[str, float] = {}
    for count, index in counts:
        rgb = tuple(palette[index * 3 : index * 3 + 3])
        if len(rgb) != 3:
            continue
        name = nearest_palette_color(rgb)  # type: ignore[arg-type]
        shares[name] = shares.get(name, 0.0) + count / total
    ranked = sorted(shares.items(), key=lambda item: -item[1])
    return [{"color": name, "share": round(share, 3)} for name, share in ranked[:max_colors] if share >= min_share]


def prepare_image(raw: bytes) -> tuple[bytes, tuple[int, int], list[dict[str, Any]]]:
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as source:
        image = source.convert("RGB")
    longest = max(image.size)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / float(longest)
        image = image.resize(
            (max(1, round(image.size[0] * scale)), max(1, round(image.size[1] * scale))),
            Image.LANCZOS,
        )
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue(), image.size, compute_palette(image)


# --- request building ---------------------------------------------------------


def custom_id_for(art_group_id: str) -> str:
    # Batch custom_ids allow [A-Za-z0-9_-]{1,64}; other ids get a stable hash and
    # the manifest maps it back.
    if _CUSTOM_ID_RE.match(art_group_id):
        return art_group_id
    return "g_" + hashlib.sha1(art_group_id.encode("utf-8")).hexdigest()[:40]


def build_request(candidate: Candidate, jpeg_bytes: bytes, *, model: str) -> dict[str, Any]:
    return {
        "custom_id": custom_id_for(candidate.group.art_group_id),
        "params": {
            "model": model,
            "max_tokens": MAX_TOKENS,
            "system": SYSTEM_PROMPT,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": base64.standard_b64encode(jpeg_bytes).decode("ascii"),
                            },
                        },
                        {"type": "text", "text": f"Card name: {candidate.card_name}. Tag this artwork."},
                    ],
                }
            ],
            "output_config": {
                "effort": "low",
                "format": {"type": "json_schema", "schema": output_schema()},
            },
        },
    }


def prepare_batch(
    candidates: list[Candidate],
    *,
    model: str,
    fetcher: Callable[[str], bytes] | None = None,
    workers: int = 8,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """(requests, manifest keyed by custom_id, failed art_group_ids)."""
    fetch = fetcher or fetch_image

    def work(candidate: Candidate) -> tuple[Candidate, Any]:
        try:
            return candidate, prepare_image(fetch(candidate.image_url))
        except Exception as error:  # noqa: BLE001
            return candidate, error

    requests: list[dict[str, Any]] = []
    manifest: dict[str, Any] = {}
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for candidate, result in pool.map(work, candidates):
            if isinstance(result, Exception):
                print(f"[art-tag] image failed {candidate.group.art_group_id}: {result}", file=sys.stderr)
                failed.append(candidate.group.art_group_id)
                continue
            jpeg, size, palette = result
            request = build_request(candidate, jpeg, model=model)
            requests.append(request)
            manifest[request["custom_id"]] = {
                **candidate.group.as_dict(),
                "palette": palette,
                "image_size": list(size),
            }
    return requests, manifest, failed


# --- estimate -----------------------------------------------------------------


def estimate_cost(
    n_requests: int,
    *,
    model: str,
    image_sizes: Iterable[tuple[int, int]] | None = None,
) -> dict[str, Any]:
    price_in, price_out = MODEL_PRICES[model]
    sizes = list(image_sizes) if image_sizes is not None else [NOMINAL_IMAGE_SIZE] * n_requests
    image_tokens = sum(w * h / 750.0 for w, h in sizes)
    text_tokens = (len(SYSTEM_PROMPT) / 4.0 + len(json.dumps(output_schema())) / 4.0 + 20) * n_requests
    input_tokens = image_tokens + text_tokens
    output_tokens = EST_OUTPUT_TOKENS * n_requests
    list_cost = input_tokens / 1e6 * price_in + output_tokens / 1e6 * price_out
    return {
        "model": model,
        "requests": n_requests,
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "list_usd": round(list_cost, 4),
        "batch_usd": round(list_cost * BATCH_DISCOUNT, 4),
    }


# --- HTTP (same raw urllib style as anthropic_adapter) ---------------------------


def _api(method: str, url: str, payload: dict[str, Any] | None = None, *, timeout: int = 120) -> bytes:
    api_key = anthropic_api_key()
    if api_key is None:
        raise ValueError("ANTHROPIC_API_KEY is not configured")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=body, method=method)
    request.add_header("x-api-key", api_key)
    request.add_header("anthropic-version", ANTHROPIC_VERSION)
    # Keys not scoped to a workspace must name one per request.
    workspace_id = str(os.environ.get("ANTHROPIC_WORKSPACE_ID") or "").strip()
    if workspace_id:
        request.add_header("anthropic-workspace-id", workspace_id)
    if body is not None:
        request.add_header("content-type", "application/json")
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.read()
    except HTTPError as error:
        detail = error.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"Anthropic {method} {url} -> HTTP {error.code}: {detail}") from None
    except URLError as error:
        raise RuntimeError(f"Anthropic {method} {url} failed: {error.reason}") from None


def submit_batch(requests: list[dict[str, Any]]) -> dict[str, Any]:
    return json.loads(_api("POST", ANTHROPIC_BATCHES_URL, {"requests": requests}))


def retrieve_batch(batch_id: str) -> dict[str, Any]:
    return json.loads(_api("GET", f"{ANTHROPIC_BATCHES_URL}/{batch_id}"))


def fetch_results(batch: dict[str, Any]) -> list[dict[str, Any]]:
    url = batch.get("results_url") or f"{ANTHROPIC_BATCHES_URL}/{batch['id']}/results"
    raw = _api("GET", url, timeout=300).decode("utf-8")
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


# --- result parsing -----------------------------------------------------------


def _confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, number))


def parse_result_line(line: dict[str, Any]) -> tuple[str, dict[str, Any] | None, str | None]:
    """(custom_id, model JSON or None, error or None). Errored/expired/canceled
    results and refusals/truncations come back as errors, never as tags."""
    custom_id = str(line.get("custom_id") or "")
    result = line.get("result") or {}
    kind = result.get("type")
    if kind != "succeeded":
        error = result.get("error") or {}
        inner = error.get("error") if isinstance(error.get("error"), dict) else error
        return custom_id, None, f"{kind}: {inner.get('type', '')} {inner.get('message', '')}".strip()
    message = result.get("message") or {}
    stop_reason = message.get("stop_reason")
    if stop_reason not in ("end_turn", "stop_sequence"):
        return custom_id, None, f"stop_reason={stop_reason}"
    text = "".join(b.get("text", "") for b in message.get("content") or [] if b.get("type") == "text")
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return custom_id, None, "unparseable JSON"
    if not isinstance(parsed, dict):
        return custom_id, None, "JSON is not an object"
    return custom_id, parsed, None


def normalize_tags(
    raw: dict[str, Any],
    *,
    name_index: dict[str, int],
    palette: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[tuple[str, str, str | None, float]], str | None]:
    """Validate model output against the v1 vocab.

    Returns (tags_json dict, flat (facet, value, role, confidence) rows, alt_text).
    Out-of-vocab values are dropped; unresolvable Pokémon names are dropped."""
    tags: dict[str, Any] = {}
    flat: dict[tuple[str, str], tuple[str | None, float]] = {}

    def put(facet: str, value: str, role: str | None, confidence: float) -> None:
        key = (facet, value)
        if key not in flat or confidence > flat[key][1]:
            flat[key] = (role, confidence)

    for facet in MODEL_LIST_FACETS:
        allowed = ART_FACETS[facet]
        cap = MAX_OBJECTS if facet == "objects" else MAX_PER_LIST
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in raw.get(facet) or []:
            if not isinstance(entry, dict):
                continue
            value = str(entry.get("value") or "").strip().lower()
            if value not in allowed or value in seen:
                continue
            seen.add(value)
            confidence = _confidence(entry.get("confidence"))
            item: dict[str, Any] = {"value": value, "confidence": round(confidence, 3)}
            if confidence < MIN_CONFIDENCE:
                item["low_confidence"] = True
            items.append(item)
            put(facet, value, None, confidence)
            if len(items) >= cap:
                break
        tags[facet] = items

    for facet in MODEL_SINGLE_FACETS:
        value = str(raw.get(facet) or "").strip().lower()
        tags[facet] = value if value in ART_FACETS[facet] else None
        if tags[facet]:
            put(facet, value, None, 1.0)

    pokemon: list[dict[str, Any]] = []
    for entry in raw.get("appearing_pokemon") or []:
        if not isinstance(entry, dict):
            continue
        dex = resolve_pokemon_name(entry.get("name"), name_index)
        if dex is None:
            continue
        role = str(entry.get("role") or "").strip().lower()
        role = role if role in POKEMON_ROLES else "secondary"
        confidence = _confidence(entry.get("confidence"))
        item = {"name": str(entry.get("name")).strip(), "dex": dex, "role": role, "confidence": round(confidence, 3)}
        if confidence < MIN_CONFIDENCE:
            item["low_confidence"] = True
        pokemon.append(item)
        put("pokemon", str(dex), role, confidence)
    tags["appearing_pokemon"] = pokemon

    characters: list[str] = []
    for name in raw.get("characters") or []:
        text = " ".join(str(name or "").split())[:60]
        if text and text.casefold() not in {c.casefold() for c in characters}:
            characters.append(text)
            put("character", text.casefold(), None, 1.0)
        if len(characters) >= MAX_CHARACTERS:
            break
    tags["characters"] = characters

    palette_items = [p for p in palette or [] if p.get("color") in PALETTE_COLORS]
    tags["palette"] = palette_items
    for item in palette_items:
        put("palette", str(item["color"]), None, 1.0)

    alt_text = " ".join(str(raw.get("alt_text") or "").split()) or None
    rows = [(facet, value, role, conf) for (facet, value), (role, conf) in sorted(flat.items())]
    return tags, rows, alt_text


# --- writing ------------------------------------------------------------------


def write_members(conn: sqlite3.Connection, art_group_id: str, members: dict[str, str]) -> None:
    conn.execute("DELETE FROM card_art_group_members WHERE art_group_id = ?", (art_group_id,))
    conn.executemany(
        "INSERT OR REPLACE INTO card_art_group_members (card_id, art_group_id, link_source) VALUES (?, ?, ?)",
        [(card_id, art_group_id, source) for card_id, source in sorted(members.items())],
    )


def write_tagged_groups(
    conn: sqlite3.Connection,
    entries: list[dict[str, Any]],
    *,
    model: str,
    prompt_version: str = PROMPT_VERSION,
    vocab_version: str = VOCAB_VERSION,
) -> int:
    """entries: {art_group_id, representative_card_id, members, tags, rows, alt_text}.
    One transaction for the whole collect: group, then members, then tags."""
    now = utc_now()
    with conn:
        for entry in entries:
            group_id = entry["art_group_id"]
            conn.execute(
                """
                INSERT INTO card_art_groups (
                    art_group_id, representative_card_id, tags_json, alt_text,
                    tagger_model, prompt_version, vocab_version, review_state, tagged_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)
                ON CONFLICT(art_group_id) DO UPDATE SET
                    representative_card_id = excluded.representative_card_id,
                    tags_json = excluded.tags_json,
                    alt_text = excluded.alt_text,
                    tagger_model = excluded.tagger_model,
                    prompt_version = excluded.prompt_version,
                    vocab_version = excluded.vocab_version,
                    review_state = 'auto',
                    tagged_at = excluded.tagged_at
                """,
                (
                    group_id,
                    entry["representative_card_id"],
                    json.dumps(entry["tags"], sort_keys=True),
                    entry["alt_text"],
                    model,
                    prompt_version,
                    vocab_version,
                    now,
                ),
            )
            write_members(conn, group_id, entry["members"])
            conn.execute("DELETE FROM card_art_tags WHERE art_group_id = ?", (group_id,))
            conn.executemany(
                "INSERT INTO card_art_tags (art_group_id, facet, value, role, confidence) VALUES (?, ?, ?, ?, ?)",
                [(group_id, facet, value, role, conf) for facet, value, role, conf in entry["rows"]],
            )
    return len(entries)


def collect_entries(
    conn: sqlite3.Connection,
    result_lines: list[dict[str, Any]],
    manifest: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Keyed by custom_id (results arrive in any order). Returns (entries, errors)."""
    name_index = build_pokemon_name_index(conn)
    entries: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    for line in result_lines:
        custom_id, parsed, error = parse_result_line(line)
        meta = manifest.get(custom_id)
        if meta is None:
            errors[custom_id] = "custom_id not in manifest"
            continue
        if error is not None or parsed is None:
            errors[custom_id] = error or "no output"
            continue
        tags, rows, alt_text = normalize_tags(parsed, name_index=name_index, palette=meta.get("palette"))
        entries.append(
            {
                "art_group_id": meta["art_group_id"],
                "representative_card_id": meta["representative_card_id"],
                "members": meta["members"],
                "tags": tags,
                "rows": rows,
                "alt_text": alt_text,
            }
        )
    return entries, errors


def sync_members(conn: sqlite3.Connection, groups: list[ArtGroup]) -> int:
    tagged = {str(r[0]) for r in conn.execute("SELECT art_group_id FROM card_art_groups")}
    count = 0
    with conn:
        for group in groups:
            if group.art_group_id in tagged:
                write_members(conn, group.art_group_id, group.members)
                count += 1
    return count


# --- CLI ----------------------------------------------------------------------


def _write_local(out_dir: Path, stem: str, requests: list[dict[str, Any]], manifest: dict[str, Any], model: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl = out_dir / f"{stem}.requests.jsonl"
    with jsonl.open("w", encoding="utf-8") as handle:
        for request in requests:
            handle.write(json.dumps(request) + "\n")
    (out_dir / f"{stem}.manifest.json").write_text(
        json.dumps({"model": model, "prompt_version": PROMPT_VERSION, "vocab_version": VOCAB_VERSION, "groups": manifest})
    )
    return jsonl


def _chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", default=str(BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--estimate", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--submit", action="store_true")
    mode.add_argument("--collect", metavar="BATCH_ID")
    mode.add_argument("--sync-members", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(MODEL_PRICES))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--card-ids-file", help="newline-separated card ids (bake-off subset)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args(argv)

    conn = connect(args.database)
    # Art tables may not exist yet on a DB the server hasn't migrated.
    apply_schema(conn, BACKEND_ROOT / "schema.sql")
    out_dir = Path(args.out)
    try:
        if args.collect:
            manifest_path = out_dir / f"{args.collect}.manifest.json"
            manifest_doc = json.loads(manifest_path.read_text())
            batch = retrieve_batch(args.collect)
            if batch.get("processing_status") != "ended":
                print(f"batch {args.collect} is {batch.get('processing_status')}; counts={batch.get('request_counts')}")
                return 0
            entries, errors = collect_entries(conn, fetch_results(batch), manifest_doc["groups"])
            written = write_tagged_groups(conn, entries, model=manifest_doc["model"])
            for custom_id, error in sorted(errors.items()):
                print(f"[art-tag] {custom_id}: {error}", file=sys.stderr)
            print(json.dumps({"written": written, "errors": len(errors)}))
            return 0

        groups = compute_art_groups(conn)
        if args.sync_members:
            print(json.dumps({"groups_synced": sync_members(conn, groups)}))
            return 0

        card_ids = None
        if args.card_ids_file:
            card_ids = {line.strip() for line in Path(args.card_ids_file).read_text().splitlines() if line.strip()}
        candidates = select_groups(conn, groups, card_ids=card_ids, limit=args.limit)
        if args.estimate:
            print(json.dumps(estimate_cost(len(candidates), model=args.model), indent=2))
            return 0

        requests, manifest, failed = prepare_batch(candidates, model=args.model)
        print(json.dumps(estimate_cost(len(requests), model=args.model, image_sizes=[tuple(m["image_size"]) for m in manifest.values()])))
        if args.dry_run:
            path = _write_local(out_dir, f"dry-run-{int(time.time())}", requests, manifest, args.model)
            print(f"wrote {len(requests)} requests to {path} ({len(failed)} image failures)")
            return 0

        for chunk in _chunks(requests, max(1, args.batch_size)):
            batch = submit_batch(chunk)
            chunk_manifest = {r["custom_id"]: manifest[r["custom_id"]] for r in chunk}
            _write_local(out_dir, str(batch["id"]), chunk, chunk_manifest, args.model)
            print(f"submitted {batch['id']} ({len(chunk)} requests)")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
