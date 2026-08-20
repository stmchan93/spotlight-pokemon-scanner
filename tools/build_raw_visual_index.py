#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import sqlite3
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import GAME_POKEMON, derive_card_title_aliases, normalize_game  # noqa: E402
from scrydex_adapter import map_scrydex_catalog_card, scrydex_api_request  # noqa: E402
from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy, resolve_torch_device  # noqa: E402
from visual_index_placeholders import is_card_back_image  # noqa: E402


USER_AGENT = "Ekalight/0.1 (+https://local.ekalight.app)"
DEFAULT_SUPERTYPES = ["pokemon", "trainer", "energy"]
DEFAULT_CROP_PRESET = "none"
ARTWORK_V1_CROP_BOX = (
    30.0 / 630.0,
    80.0 / 880.0,
    570.0 / 630.0,
    440.0 / 880.0,
)


@dataclass(frozen=True)
class BuildArtifactPaths:
    npz_path: Path
    manifest_path: Path
    build_report_path: Path
    metadata_cache_path: Path
    image_cache_root: Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sanitize_model_slug(model_id: str) -> str:
    slug = model_id.split("/")[-1].strip().lower()
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in slug)


def normalize_supertype(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = text.encode("ascii", "ignore").decode("ascii")
    return ascii_text.strip().lower()


def crop_box_for_preset(preset: str) -> tuple[float, float, float, float] | None:
    normalized = preset.strip().lower()
    if normalized in {"", "none", "full_card"}:
        return None
    if normalized == "artwork_v1":
        return ARTWORK_V1_CROP_BOX
    raise SystemExit(f"Unsupported crop preset: {preset}")


def apply_crop_preset(image: Image.Image, preset: str) -> Image.Image:
    crop_box = crop_box_for_preset(preset)
    if crop_box is None:
        return image

    x, y, width, height = crop_box
    image_width, image_height = image.size
    left = max(0, min(image_width - 1, int(round(x * image_width))))
    top = max(0, min(image_height - 1, int(round(y * image_height))))
    right = max(left + 1, min(image_width, int(round((x + width) * image_width))))
    bottom = max(top + 1, min(image_height, int(round((y + height) * image_height))))
    return image.crop((left, top, right, bottom))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build the full offline raw visual reference index from reference images. Card metadata comes "
            "either from the Scrydex API (default, Pokémon supertype-filtered) or, with --database-path, "
            "from our own synced catalog SQLite — the only source that can see non-Pokémon games."
        )
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backend/data/visual-index"),
        help="Directory where the index artifact, manifest, and caches should be written.",
    )
    parser.add_argument(
        "--artifact-version",
        default="v001",
        help="Version label to embed in artifact filenames and manifest metadata.",
    )
    parser.add_argument(
        "--model-id",
        default="openai/clip-vit-base-patch32",
        help="Transformers CLIP model id to use for the full index build.",
    )
    parser.add_argument(
        "--supertypes",
        nargs="+",
        default=DEFAULT_SUPERTYPES,
        help="Scrydex supertypes to fetch and combine into the full reference index. Scrydex-sourced builds only.",
    )
    parser.add_argument(
        "--game",
        default=GAME_POKEMON,
        help="Which TCG to build an index for ('pokemon', 'onepiece'). Non-Pokémon games require --database-path.",
    )
    parser.add_argument(
        "--database-path",
        type=Path,
        default=None,
        help=(
            "Read card metadata from our own synced catalog SQLite instead of the Scrydex API "
            "(SELECT ... FROM cards WHERE game = ?). Costs ZERO Scrydex credits: reference images "
            "come from the image CDN, which needs no API key. Required for non-Pokémon games, whose "
            "cards the supertype-filtered Scrydex fetch structurally cannot see."
        ),
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=250,
        help="Scrydex page size for catalog fetches.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="How many cached images to embed per CLIP batch.",
    )
    parser.add_argument(
        "--download-workers",
        type=int,
        default=12,
        help="How many reference images to fetch/cache in parallel per batch.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional cap on how many cards to embed after metadata fetch. Useful for smoke tests.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device for embedding inference.",
    )
    parser.add_argument(
        "--refresh-metadata",
        action="store_true",
        help="Ignore the cached provider metadata snapshot and fetch card metadata from Scrydex again.",
    )
    parser.add_argument(
        "--crop-preset",
        default=DEFAULT_CROP_PRESET,
        help="Optional image crop preset to apply before embedding. Use 'artwork_v1' for the artwork-only experiment.",
    )
    parser.add_argument(
        "--adapter-checkpoint",
        type=Path,
        default=None,
        help="Optional projection-adapter checkpoint to apply to the reference embeddings before writing the index.",
    )
    parser.add_argument(
        "--adapter-metadata-path",
        type=Path,
        default=None,
        help="Optional adapter metadata JSON path to include in the manifest/build report for provenance.",
    )
    parser.add_argument(
        "--base-index-npz",
        type=Path,
        default=None,
        help="Optional existing base visual index NPZ path. When provided with an adapter, embeddings are projected from this index instead of recomputing image embeddings.",
    )
    parser.add_argument(
        "--base-index-manifest",
        type=Path,
        default=None,
        help="Optional existing base visual index manifest path that matches --base-index-npz.",
    )
    return parser.parse_args()

def load_cached_metadata(metadata_cache_path: Path) -> list[dict[str, Any]] | None:
    if not metadata_cache_path.exists():
        return None
    payload = json.loads(metadata_cache_path.read_text())
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return None
    return [entry for entry in entries if isinstance(entry, dict)]


def save_metadata_cache(metadata_cache_path: Path, *, supertypes: list[str], entries: list[dict[str, Any]]) -> None:
    metadata_cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": utc_now_iso(),
        "provider": "scrydex",
        "sourceQueries": [
            f"/pokemon/v1/cards filtered-supertypes:{supertype}" for supertype in supertypes
        ] + [
            f"/pokemon/v1/ja/cards filtered-supertypes:{supertype}" for supertype in supertypes
        ],
        "entryCount": len(entries),
        "entries": entries,
    }
    metadata_cache_path.write_text(json.dumps(payload, indent=2))


def dedupe_and_sort_cards(cards: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for card in cards:
        card_id = str(card.get("id") or "").strip()
        if not card_id:
            continue
        by_id[card_id] = card
    return sorted(by_id.values(), key=lambda card: str(card.get("id") or ""))


def fetch_scrydex_cards_page(path: str, *, page_size: int, page: int) -> tuple[list[dict[str, Any]], int]:
    payload = scrydex_api_request(path, page_size=str(page_size), page=str(page))
    data = payload.get("data")
    if not isinstance(data, list):
        return [], 0
    total_count = int(payload.get("total_count") or 0)
    return [item for item in data if isinstance(item, dict)], total_count


def fetch_all_catalog_cards(
    *,
    supertypes: list[str],
    page_size: int,
    metadata_cache_path: Path,
    refresh_metadata: bool,
    metadata_limit: int,
) -> list[dict[str, Any]]:
    if not refresh_metadata:
        cached = load_cached_metadata(metadata_cache_path)
        if cached is not None:
            print(f"[metadata] using cached card metadata from {metadata_cache_path} ({len(cached)} entries)")
            return cached

    by_id: dict[str, dict[str, Any]] = {}
    wanted_supertypes = {normalize_supertype(supertype) for supertype in supertypes}
    lanes = [
        ("global", "/pokemon/v1/cards"),
        ("ja", "/pokemon/v1/ja/cards"),
    ]
    for lane_name, lane_path in lanes:
        page = 1
        lane_seen_count = 0
        while True:
            page_cards, total_count = fetch_scrydex_cards_page(lane_path, page_size=page_size, page=page)
            lane_seen_count += len(page_cards)
            kept = 0
            for raw_card in page_cards:
                card = map_scrydex_catalog_card(raw_card)
                card_supertype = normalize_supertype(card.get("supertype"))
                if wanted_supertypes and card_supertype not in wanted_supertypes:
                    continue
                card_id = str(card.get("id") or "").strip()
                if card_id:
                    by_id[card_id] = card
                    kept += 1
            if page == 1 or page % 10 == 0 or not page_cards:
                print(
                    f"[metadata] lane={lane_name} page={page} fetched={len(page_cards)} kept={kept} unique_total={len(by_id)}/{total_count or '?'}",
                    flush=True,
                )
            if metadata_limit > 0 and len(by_id) >= metadata_limit:
                print(f"[metadata] limit={metadata_limit} reached while fetching lane={lane_name}", flush=True)
                break
            if not page_cards or (total_count > 0 and lane_seen_count >= total_count):
                break
            page += 1
        if metadata_limit > 0 and len(by_id) >= metadata_limit:
            break

    deduped = dedupe_and_sort_cards(by_id.values())
    if metadata_limit > 0:
        deduped = deduped[:metadata_limit]
    save_metadata_cache(metadata_cache_path, supertypes=supertypes, entries=deduped)
    print(f"[metadata] wrote cache {metadata_cache_path} ({len(deduped)} unique cards)", flush=True)
    return deduped


def _json_list(value: Any) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _json_object(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def catalog_row_to_card(row: sqlite3.Row) -> dict[str, Any]:
    """Map a `cards` table row onto the SAME dict shape `map_scrydex_catalog_card`
    returns, so the download → embed → manifest pipeline below cannot tell the
    two sources apart."""
    keys = set(row.keys())
    return {
        "id": str(row["id"] or ""),
        "game": normalize_game(row["game"] if "game" in keys else None),
        "name": str(row["name"] or ""),
        "set_name": str(row["set_name"] or ""),
        "number": str(row["number"] or ""),
        "rarity": str(row["rarity"] or "Unknown"),
        "variant": str(row["variant"] or "Raw"),
        "language": str(row["language"] or "English"),
        "reference_image_path": None,
        "reference_image_url": row["image_url"],
        "reference_image_small_url": row["image_small_url"],
        "source": row["source_provider"] or "scrydex",
        "source_record_id": row["source_record_id"] or str(row["id"] or ""),
        "set_id": row["set_id"],
        "set_series": row["set_series"],
        "set_ptcgo_code": row["set_ptcgo_code"],
        "set_release_date": row["set_release_date"],
        "supertype": row["supertype"] or "",
        "subtypes": _json_list(row["subtypes_json"]),
        "types": _json_list(row["types_json"]),
        "artist": row["artist"],
        "regulation_mark": row["regulation_mark"],
        "national_pokedex_numbers": _json_list(row["national_pokedex_numbers_json"]),
        "tcgplayer": {},
        "cardmarket": {},
        "source_payload": _json_object(row["source_payload_json"]),
    }


def load_catalog_cards_from_database(
    *,
    database_path: Path,
    game: str,
    limit: int = 0,
) -> list[dict[str, Any]]:
    """Read index-able cards for one game out of our own synced catalog.

    Zero Scrydex credits: this is a local SQLite read. The only network traffic a
    database-sourced build makes is `download_image()` against the image CDN,
    which carries no API key and is not a billed API request.

    Rows without a usable reference image URL are skipped — they cannot be
    embedded, and letting them through would only produce build-report noise.
    """
    normalized_game = normalize_game(game)
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        connection.row_factory = sqlite3.Row
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(cards)").fetchall()
        }
        if not columns:
            raise SystemExit(f"{database_path} has no `cards` table.")
        where = ["image_url IS NOT NULL", "TRIM(image_url) != ''"]
        params: list[Any] = []
        if "game" in columns:
            where.append("game = ?")
            params.append(normalized_game)
        elif normalized_game != GAME_POKEMON:
            # A pre-multi-game database holds Pokémon only, so any other game
            # would silently return the whole Pokémon catalog.
            raise SystemExit(
                f"{database_path} predates the `cards.game` column; it cannot serve game={normalized_game}."
            )
        query = f"SELECT * FROM cards WHERE {' AND '.join(where)} ORDER BY id"
        if limit > 0:
            query += " LIMIT ?"
            params.append(limit)
        rows = connection.execute(query, params).fetchall()
    finally:
        connection.close()
    return [catalog_row_to_card(row) for row in rows]


def download_image(url: str) -> Image.Image:
    request = Request(url)
    request.add_header("Accept", "image/*")
    request.add_header("User-Agent", USER_AGENT)
    with urlopen(request, timeout=30) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGB")


def load_local_image(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def infer_image_suffix(reference_url: str) -> str:
    normalized = reference_url.lower()
    if normalized.endswith(".jpg") or normalized.endswith(".jpeg"):
        return ".jpg"
    return ".png"


def candidate_display_number(card: dict[str, Any]) -> str:
    return str(card.get("number") or "")


def ensure_cached_reference_image(card: dict[str, Any], image_cache_root: Path) -> Path:
    card_id = str(card.get("id") or "").strip()
    if not card_id:
        raise ValueError("Cannot cache image for a card without an id.")
    reference_url = str(card.get("reference_image_url") or card.get("referenceImageUrl") or "").strip()
    if not reference_url:
        raise ValueError(f"Card {card_id} does not include a usable reference image URL.")

    suffix = infer_image_suffix(reference_url)
    cache_path = image_cache_root / f"{card_id}{suffix}"
    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        image = download_image(reference_url)
        image.save(cache_path)
    return cache_path


def cached_image_for_card(card: dict[str, Any], image_cache_root: Path) -> tuple[dict[str, Any], Path]:
    return card, ensure_cached_reference_image(card, image_cache_root)


def batch_iterable(values: list[dict[str, Any]], batch_size: int) -> Iterable[list[dict[str, Any]]]:
    for index in range(0, len(values), batch_size):
        yield values[index : index + batch_size]


def build_artifact_paths(
    output_dir: Path,
    artifact_version: str,
    model_id: str,
    game: str = GAME_POKEMON,
) -> BuildArtifactPaths:
    """Artifact paths for one build.

    NAMING CONVENTION (kept in sync with `game_index_artifact_names()` in
    backend/raw_visual_matcher.py):

      * Pokémon keeps the historical un-suffixed names — its artifacts are
        already deployed under them.
            visual_index_<version>_<model-slug>.npz / visual_index_<version>_manifest.json
      * every other game inserts the game id:
            visual_index_<version>_<game>_<model-slug>.npz / visual_index_<version>_<game>_manifest.json

    Promoting a build to live means copying it to the matching
    `visual_index_active[_<game>]_…` name the matcher resolves at runtime.
    Caches are per-game too so a One Piece build can never reuse or clobber the
    Pokémon reference-image cache.
    """
    model_slug = sanitize_model_slug(model_id)
    cache_root = output_dir / ".cache"
    normalized_game = normalize_game(game)
    game_suffix = "" if normalized_game == GAME_POKEMON else f"_{normalized_game}"
    cache_suffix = "" if normalized_game == GAME_POKEMON else f"_{normalized_game}"
    return BuildArtifactPaths(
        npz_path=output_dir / f"visual_index_{artifact_version}{game_suffix}_{model_slug}.npz",
        manifest_path=output_dir / f"visual_index_{artifact_version}{game_suffix}_manifest.json",
        build_report_path=output_dir / f"visual_index_{artifact_version}{game_suffix}_build_report.json",
        metadata_cache_path=cache_root / f"scrydex_cards_metadata{cache_suffix}.json",
        image_cache_root=cache_root / f"reference_images{cache_suffix}",
    )


def manifest_entry_for_row(
    *,
    row_index: int,
    card: dict[str, Any],
    reference_image_path: Path,
    artifact_version: str,
    model_id: str,
    game: str | None = None,
) -> dict[str, Any]:
    title_aliases = [
        alias["alias"]
        for alias in derive_card_title_aliases(
            name=card.get("name"),
            language=card.get("language"),
            source_payload=card.get("source_payload") or card.get("sourcePayload") or {},
        )
    ]
    entry: dict[str, Any] = {
        "rowIndex": row_index,
        "providerCardId": card.get("id"),
        "sourceProvider": card.get("source") or "scrydex",
        "sourceRecordID": card.get("source_record_id") or card.get("id"),
        "name": card.get("name"),
        "titleAliases": title_aliases,
        "collectorNumber": candidate_display_number(card),
        "supertype": card.get("supertype"),
        "language": card.get("language"),
        "setId": card.get("set_id") or card.get("setId"),
        "setName": card.get("set_name") or card.get("setName"),
        "setSeries": card.get("set_series") or card.get("setSeries"),
        "setPtcgoCode": card.get("set_ptcgo_code") or card.get("setPtcgoCode"),
        "setReleaseDate": card.get("set_release_date") or card.get("setReleaseDate"),
        "imageUrl": card.get("reference_image_url") or card.get("referenceImageUrl"),
        "referenceImagePath": str(reference_image_path),
        "embeddingModel": model_id,
        "artifactVersion": artifact_version,
    }
    # Pokémon entries keep their exact historical shape (no `game` key) so a
    # Pokémon rebuild is byte-comparable with the index in production today.
    normalized_game = normalize_game(game) if game else None
    if normalized_game is not None and normalized_game != GAME_POKEMON:
        entry["game"] = normalized_game
    return entry


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def load_existing_index(
    *,
    npz_path: Path,
    manifest_path: Path,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    manifest = json.loads(manifest_path.read_text())
    entries = [entry for entry in manifest.get("entries", []) if isinstance(entry, dict)]
    embedding_matrix = np.asarray(np.load(npz_path)["embeddings"], dtype=np.float32)
    if embedding_matrix.ndim != 2 or embedding_matrix.shape[0] != len(entries):
        raise SystemExit("Existing base visual index NPZ/manifest mismatch.")
    return embedding_matrix, entries


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    game = normalize_game(args.game)
    database_path = args.database_path.resolve() if args.database_path else None
    if game != GAME_POKEMON and database_path is None:
        raise SystemExit(
            f"--game {game} requires --database-path: the Scrydex fetch in this tool is Pokémon-supertype "
            "filtered and cannot see other games' cards."
        )

    artifact_paths = build_artifact_paths(output_dir, args.artifact_version, args.model_id, game)
    device = resolve_torch_device(args.device)
    adapter_metadata: dict[str, Any] | None = None
    if args.adapter_metadata_path:
        adapter_metadata = json.loads(args.adapter_metadata_path.resolve().read_text())

    print(f"[build] output_dir={output_dir}", flush=True)
    print(f"[build] artifact_version={args.artifact_version}", flush=True)
    print(f"[build] game={game}", flush=True)
    print(f"[build] card_source={'database:' + str(database_path) if database_path else 'scrydex_api'}", flush=True)
    print(f"[build] model_id={args.model_id}", flush=True)
    print(f"[build] device={device}", flush=True)
    print(f"[build] crop_preset={args.crop_preset}", flush=True)
    print(f"[build] adapter_checkpoint={args.adapter_checkpoint.resolve() if args.adapter_checkpoint else 'none'}", flush=True)

    if database_path is not None:
        # Database-sourced: our own synced catalog, ZERO Scrydex credits.
        catalog_cards = load_catalog_cards_from_database(
            database_path=database_path,
            game=game,
            limit=args.limit,
        )
        print(
            f"[metadata] read {len(catalog_cards)} cards with reference images from {database_path} (game={game})",
            flush=True,
        )
    else:
        catalog_cards = fetch_all_catalog_cards(
            supertypes=[value.lower() for value in args.supertypes],
            page_size=args.page_size,
            metadata_cache_path=artifact_paths.metadata_cache_path,
            refresh_metadata=args.refresh_metadata,
            metadata_limit=args.limit,
        )
    if args.limit > 0:
        catalog_cards = catalog_cards[: args.limit]
        print(f"[build] applying limit={args.limit}; embedding {len(catalog_cards)} cards", flush=True)

    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    adapter = None
    if args.adapter_checkpoint:
        adapter = load_projection_adapter(
            args.adapter_checkpoint.resolve(),
            embedding_dim=encoder.embedding_dim,
            device=device,
        )

    if adapter is not None and args.base_index_npz and args.base_index_manifest:
        base_index_npz_path = args.base_index_npz.resolve()
        base_index_manifest_path = args.base_index_manifest.resolve()
        base_embedding_matrix, base_manifest_entries = load_existing_index(
            npz_path=base_index_npz_path,
            manifest_path=base_index_manifest_path,
        )
        projected_matrix = project_embeddings_numpy(
            adapter,
            base_embedding_matrix,
            device=device,
            batch_size=max(1, args.batch_size),
        ).astype(np.float32)
        manifest_entries = []
        for row_index, entry in enumerate(base_manifest_entries):
            updated_entry = dict(entry)
            updated_entry["rowIndex"] = row_index
            updated_entry["artifactVersion"] = args.artifact_version
            updated_entry["embeddingModel"] = args.model_id
            manifest_entries.append(updated_entry)
        np.savez_compressed(artifact_paths.npz_path, embeddings=projected_matrix)
        save_json(
            artifact_paths.manifest_path,
            {
                "generatedAt": utc_now_iso(),
                "provider": "scrydex",
                "artifactVersion": args.artifact_version,
                "modelId": args.model_id,
                "cropPreset": args.crop_preset,
                "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
                "adapterCheckpointPath": str(args.adapter_checkpoint.resolve()) if args.adapter_checkpoint else None,
                "adapterMetadataPath": str(args.adapter_metadata_path.resolve()) if args.adapter_metadata_path else None,
                "adapterMetadata": adapter_metadata,
                "baseIndexNpzPath": str(base_index_npz_path),
                "baseIndexManifestPath": str(base_index_manifest_path),
                "embeddingDimension": int(projected_matrix.shape[1]),
                "entryCount": len(manifest_entries),
                "entries": manifest_entries,
            },
        )
        save_json(
            artifact_paths.build_report_path,
            {
                "generatedAt": utc_now_iso(),
                "provider": "scrydex",
                "artifactVersion": args.artifact_version,
                "modelId": args.model_id,
                "cropPreset": args.crop_preset,
                "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
                "adapterCheckpointPath": str(args.adapter_checkpoint.resolve()) if args.adapter_checkpoint else None,
                "adapterMetadataPath": str(args.adapter_metadata_path.resolve()) if args.adapter_metadata_path else None,
                "adapterMetadata": adapter_metadata,
                "device": str(device),
                "requestedSupertypes": [value.lower() for value in args.supertypes],
                "pageSize": args.page_size,
                "metadataCachePath": str(artifact_paths.metadata_cache_path),
                "baseIndexNpzPath": str(base_index_npz_path),
                "baseIndexManifestPath": str(base_index_manifest_path),
                "projectionMode": "project_existing_index",
                "entryCount": len(manifest_entries),
                "embeddedCount": len(manifest_entries),
                "skippedCount": 0,
                "skipped": [],
                "npzPath": str(artifact_paths.npz_path),
                "manifestPath": str(artifact_paths.manifest_path),
            },
        )
        print(f"[build] projected {len(manifest_entries)} rows from {base_index_npz_path}", flush=True)
        print(f"[build] wrote {artifact_paths.npz_path}", flush=True)
        print(f"[build] wrote {artifact_paths.manifest_path}", flush=True)
        print(f"[build] wrote {artifact_paths.build_report_path}", flush=True)
        print(f"[build] final embedded entries={len(manifest_entries)} skipped=0", flush=True)
        return 0

    manifest_entries: list[dict[str, Any]] = []
    embeddings: list[np.ndarray] = []
    skipped: list[dict[str, Any]] = []

    total_cards = len(catalog_cards)
    for batch_number, batch_cards in enumerate(batch_iterable(catalog_cards, args.batch_size), start=1):
        batch_cards_with_images: list[tuple[dict[str, Any], Path]] = []

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.download_workers)) as executor:
            future_to_card = {
                executor.submit(cached_image_for_card, card, artifact_paths.image_cache_root): card for card in batch_cards
            }
            for future in concurrent.futures.as_completed(future_to_card):
                card = future_to_card[future]
                try:
                    resolved_card, reference_image_path = future.result()
                    # Content guard: skip cards whose downloaded/cached reference
                    # image is a known generic card-back placeholder, so it never
                    # becomes a false attractor in the index (see
                    # visual_index_placeholders.py).
                    if is_card_back_image(reference_image_path):
                        skipped.append(
                            {
                                "providerCardId": resolved_card.get("id"),
                                "reason": "placeholder_card_back",
                            }
                        )
                        continue
                    batch_cards_with_images.append((resolved_card, reference_image_path))
                except Exception as exc:
                    skipped.append(
                        {
                            "providerCardId": card.get("id"),
                            "reason": f"image_error: {exc}",
                        }
                    )

        batch_cards_with_images.sort(key=lambda row: str(row[0].get("id") or ""))
        loaded_batch_cards_with_images: list[tuple[dict[str, Any], Path]] = []
        batch_images: list[Image.Image] = []
        for card, reference_image_path in batch_cards_with_images:
            try:
                batch_images.append(apply_crop_preset(load_local_image(reference_image_path), args.crop_preset))
                loaded_batch_cards_with_images.append((card, reference_image_path))
            except Exception as exc:
                skipped.append(
                    {
                        "providerCardId": card.get("id"),
                        "reason": f"image_load_error: {exc}",
                    }
                )
        batch_cards_with_images = loaded_batch_cards_with_images

        if not batch_cards_with_images:
            continue

        try:
            batch_embeddings = encoder.embed_images(batch_images, batch_size=args.batch_size)
            if adapter is not None:
                batch_embeddings = project_embeddings_numpy(
                    adapter,
                    batch_embeddings,
                    device=device,
                    batch_size=max(1, args.batch_size),
                )
        except Exception as exc:
            for card, _ in batch_cards_with_images:
                skipped.append(
                    {
                        "providerCardId": card.get("id"),
                        "reason": f"embedding_error: {exc}",
                    }
                )
            continue

        for (card, reference_image_path), embedding in zip(batch_cards_with_images, batch_embeddings):
            row_index = len(manifest_entries)
            manifest_entries.append(
                manifest_entry_for_row(
                    row_index=row_index,
                    card=card,
                    reference_image_path=reference_image_path,
                    artifact_version=args.artifact_version,
                    model_id=args.model_id,
                    game=game,
                )
            )
            embeddings.append(embedding)

        processed = min(batch_number * args.batch_size, total_cards)
        if batch_number == 1 or batch_number % 10 == 0 or processed >= total_cards:
            print(
                f"[build] embedded {processed}/{total_cards} catalog rows ({len(manifest_entries)} successful, {len(skipped)} skipped)",
                flush=True,
            )

    if not embeddings:
        raise SystemExit("No embeddings were produced. Cannot write an empty visual index.")

    embedding_matrix = np.stack(embeddings, axis=0).astype(np.float32)
    np.savez_compressed(artifact_paths.npz_path, embeddings=embedding_matrix)
    save_json(
        artifact_paths.manifest_path,
        {
            "generatedAt": utc_now_iso(),
            "provider": "scrydex",
            "game": game,
            "cardSource": "catalog_database" if database_path else "scrydex_api",
            "databasePath": str(database_path) if database_path else None,
            "artifactVersion": args.artifact_version,
            "modelId": args.model_id,
            "cropPreset": args.crop_preset,
            "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
            "adapterCheckpointPath": str(args.adapter_checkpoint.resolve()) if args.adapter_checkpoint else None,
            "adapterMetadataPath": str(args.adapter_metadata_path.resolve()) if args.adapter_metadata_path else None,
            "adapterMetadata": adapter_metadata,
            "embeddingDimension": int(embedding_matrix.shape[1]),
            "entryCount": len(manifest_entries),
            "entries": manifest_entries,
        },
    )
    save_json(
        artifact_paths.build_report_path,
        {
            "generatedAt": utc_now_iso(),
            "provider": "scrydex",
            "game": game,
            "cardSource": "catalog_database" if database_path else "scrydex_api",
            "databasePath": str(database_path) if database_path else None,
            "artifactVersion": args.artifact_version,
            "modelId": args.model_id,
            "cropPreset": args.crop_preset,
            "cropBoxNormalized": crop_box_for_preset(args.crop_preset),
            "adapterCheckpointPath": str(args.adapter_checkpoint.resolve()) if args.adapter_checkpoint else None,
            "adapterMetadataPath": str(args.adapter_metadata_path.resolve()) if args.adapter_metadata_path else None,
            "adapterMetadata": adapter_metadata,
            "device": str(device),
            "requestedSupertypes": [value.lower() for value in args.supertypes],
            "pageSize": args.page_size,
            "batchSize": args.batch_size,
            "downloadWorkers": args.download_workers,
            "catalogCardCount": total_cards,
            "embeddedEntryCount": len(manifest_entries),
            "skippedCount": len(skipped),
            "npzPath": str(artifact_paths.npz_path),
            "manifestPath": str(artifact_paths.manifest_path),
            "metadataCachePath": str(artifact_paths.metadata_cache_path),
            "imageCacheRoot": str(artifact_paths.image_cache_root),
            "skipped": skipped,
        },
    )

    print(f"[build] wrote {artifact_paths.npz_path}", flush=True)
    print(f"[build] wrote {artifact_paths.manifest_path}", flush=True)
    print(f"[build] wrote {artifact_paths.build_report_path}", flush=True)
    print(f"[build] final embedded entries={len(manifest_entries)} skipped={len(skipped)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
