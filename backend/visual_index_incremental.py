"""Incremental refresh of the raw-visual reference index.

The catalog DB syncs new Scrydex cards daily, but the visual matcher only sees
cards that have an embedding in the active `.npz` index. This module embeds ONLY
the cards that are in the DB but missing from the index, appends them to the
active artifacts via an atomic temp+rename swap, and hot-reloads the in-memory
index — so new sets become scannable the same day with no VM downtime and
without a 45-minute full rebuild.

Design notes for safety (never take the VM down):
  * Additions-only. Existing rows are never reordered or re-embedded, so the
    existing index is provably unchanged (the full-rebuild parity check on
    2026-06-15 showed re-embedding is identical anyway).
  * The one exception is `prune_excluded_rows`: rows whose card a per-game
    exclusion (VISUAL_INDEX_EXCLUSIONS, e.g. One Piece DON!!) now keeps out of
    the scanner are dropped; every other row keeps its exact embedding, and
    the art-crop sidecar is remapped in the same publish.
  * The live in-memory index is only swapped by `RawVisualIndex.reload()`, which
    validates the new files BEFORE swapping; a bad/half-written refresh raises
    and the previous index keeps serving.
  * The write is atomic (`os.replace`) with a `.pre-append.bak` of the prior
    active, so a crash mid-write can't corrupt the active artifacts.
  * A safety guard refuses to publish an index that would SHRINK (e.g. a Scrydex
    image-CDN outage skipping everything), so a transient failure is a no-op.

The embedding + image download are injected so the core logic is unit-testable
without loading the SigLIP2 model or hitting the network.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

import numpy as np

from raw_visual_art_version import art_crop_path_for_index
from raw_visual_index import RawVisualIndex, is_alt_reference_entry
from visual_index_placeholders import is_card_back_image

try:  # reuse the canonical alias derivation when available
    from catalog_tools import derive_card_title_aliases
except Exception:  # pragma: no cover - fallback keeps the module importable
    derive_card_title_aliases = None  # type: ignore[assignment]

# Supertypes that belong in the visual index (mirrors the full build's defaults).
DEFAULT_ELIGIBLE_SUPERTYPES: tuple[str, ...] = ("pokémon", "pokemon", "trainer", "energy")

POKEMON_GAME = "pokemon"
ONE_PIECE_GAME = "onepiece"
_SEALED_ID_PREFIX = "tcgp-sealed-"
# catalog_tools.TCGPLAYER_ONLY_SOURCE_PROVIDER (this module avoids a hard import).
TCGPLAYER_ONLY_SOURCE_PROVIDER = "tcgplayer"

_IMAGE_USER_AGENT = "Ekalight/0.1 (+https://local.ekalight.app)"
_DOWNLOAD_TIMEOUT_SECONDS = 30

# A pruned index may shrink by at most this fraction in one run; a predicate
# bug that matches most rows must fail loudly instead of emptying the index.
MAX_PRUNE_FRACTION = 0.25

EmbedImagesFn = Callable[[list[Any]], np.ndarray]
DownloadImageFn = Callable[[str], Any]
LogFn = Callable[[str, str], None]

# Serializes refreshes so an overlapping trigger (e.g. a manual call during the
# nightly sync hook) can't double-embed / double-write.
_REFRESH_LOCK = threading.Lock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _log(logger: LogFn | None, severity: str, message: str) -> None:
    if logger is not None:
        logger(severity, message)


def _scrydex_reference_url(card_id: str | None, image_url: str | None) -> str | None:
    # Return only a REAL catalog image_url. We intentionally do NOT fabricate a
    # `https://images.scrydex.com/pokemon/{id}/large` fallback: cards with a NULL
    # image_url are exactly the front-less cards for which Scrydex serves a generic
    # card-back placeholder, and fabricating that URL is one of the two paths that
    # pulled placeholders into the index (see visual_index_placeholders.py).
    return (image_url or "").strip() or None


def _default_download_image(url: str) -> Any:
    from PIL import Image

    request = urllib.request.Request(
        url, headers={"Accept": "image/*", "User-Agent": _IMAGE_USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:
        data = response.read()
    return Image.open(io.BytesIO(data)).convert("RGB")


def _is_one_piece_don_card(card: Mapping[str, Any]) -> bool:
    # DON!! cards are resource tokens nobody scans for value, yet their near-
    # identical art attracts blurry One Piece scans. Only TCGplayer-only rows
    # exist (supertype = TCGplayer's CardType "DON!!"); the name check mirrors
    # tcgplayer_only_catalog.product_class for rows without a card type.
    supertype = str(card.get("supertype") or "").strip().casefold()
    name = str(card.get("name") or "").strip().casefold()
    return supertype == "don!!" or name.startswith("don!!")


# Per-game cards kept in the catalog/search but out of the scanner. Each
# predicate reads `name`/`supertype`, keys shared by `cards` rows and manifest
# entries, so the same rule filters the diff and prunes already-indexed rows.
VISUAL_INDEX_EXCLUSIONS: dict[str, Callable[[Mapping[str, Any]], bool]] = {
    ONE_PIECE_GAME: _is_one_piece_don_card,
}


def is_excluded_from_visual_index(card: Mapping[str, Any], game: str | None) -> bool:
    predicate = VISUAL_INDEX_EXCLUSIONS.get(game or POKEMON_GAME)
    return bool(predicate and predicate(card))


def _eligible_card_rows(connection: Any, supertypes: Iterable[str]) -> list[dict[str, Any]]:
    """All catalog cards whose supertype belongs in the visual index, as dicts
    (works regardless of the connection's row_factory)."""
    allowed = {str(s).strip().lower() for s in supertypes}
    cursor = connection.execute("SELECT * FROM cards")
    columns = [col[0] for col in cursor.description]
    out: list[dict[str, Any]] = []
    for row in cursor:
        card = dict(zip(columns, row))
        supertype = str(card.get("supertype") or "").strip().lower()
        if supertype in allowed:
            out.append(card)
    return out


def _game_card_rows(connection: Any, game: str) -> list[dict[str, Any]]:
    """Index-able catalog cards for one non-Pokémon game. Mirrors the per-game
    full build (tools/build_raw_visual_index.py): that game's rows minus sealed
    product. Supertypes differ per game (Character, Leader, ...), so the Pokémon
    supertype filter must not apply here."""
    try:
        cursor = connection.execute("SELECT * FROM cards WHERE game = ?", (game,))
    except Exception:
        # Pre-multi-game catalog: no `game` column, so no rows for this game.
        return []
    columns = [col[0] for col in cursor.description]
    out: list[dict[str, Any]] = []
    for row in cursor:
        card = dict(zip(columns, row))
        if str(card.get("supertype") or "").strip().lower() == "sealed":
            continue
        if str(card.get("id") or "").startswith(_SEALED_ID_PREFIX):
            continue
        out.append(card)
    return out


def _candidate_rows(
    connection: Any, supertypes: Iterable[str], game: str | None
) -> list[dict[str, Any]]:
    if game is None or game == POKEMON_GAME:
        rows = _eligible_card_rows(connection, supertypes)
    else:
        rows = _game_card_rows(connection, game)
    return [row for row in rows if not is_excluded_from_visual_index(row, game)]


def _base_indexed_ids(entries: Iterable[dict[str, Any]]) -> set[Any]:
    # A card counts as indexed only via its base (Scrydex) row; alt-art rows
    # (TCGplayer products) ride along untouched and never stand in for it.
    return {entry.get("providerCardId") for entry in entries if not is_alt_reference_entry(entry)}


def diff_missing_ids(
    index: RawVisualIndex,
    connection: Any,
    *,
    eligible_supertypes: Iterable[str] = DEFAULT_ELIGIBLE_SUPERTYPES,
    game: str | None = None,
) -> list[str]:
    """Catalog card IDs that belong in the index but have no embedding yet."""
    index.load()
    indexed = _base_indexed_ids(index.entries)
    rows = _candidate_rows(connection, eligible_supertypes, game)
    return [str(r.get("id")) for r in rows if r.get("id") not in indexed]


def _title_aliases(card: dict[str, Any]) -> list[str]:
    name = card.get("name")
    if derive_card_title_aliases is None:
        return [name] if name else []
    source_payload: dict[str, Any] = {}
    raw_payload = card.get("source_payload_json") or card.get("source_payload")
    if isinstance(raw_payload, str) and raw_payload.strip():
        try:
            parsed = json.loads(raw_payload)
            if isinstance(parsed, dict):
                source_payload = parsed
        except Exception:
            source_payload = {}
    elif isinstance(raw_payload, dict):
        source_payload = raw_payload
    try:
        return [
            alias["alias"]
            for alias in derive_card_title_aliases(
                name=name, language=card.get("language"), source_payload=source_payload
            )
        ]
    except Exception:
        return [name] if name else []


def _manifest_entry(
    row_index: int,
    card: dict[str, Any],
    reference_path: Path,
    model_id: str,
    artifact_version: str,
    game: str | None = None,
) -> dict[str, Any]:
    cid = card.get("id")
    entry = {
        "rowIndex": row_index,
        "providerCardId": cid,
        "sourceProvider": card.get("source_provider") or "scrydex",
        "sourceRecordID": cid,
        "name": card.get("name"),
        "titleAliases": _title_aliases(card),
        "collectorNumber": card.get("number"),
        "supertype": card.get("supertype"),
        "language": card.get("language"),
        "setId": card.get("set_id"),
        "setName": card.get("set_name"),
        "setSeries": card.get("set_series"),
        "setPtcgoCode": card.get("set_ptcgo_code"),
        "setReleaseDate": card.get("set_release_date"),
        "imageUrl": _scrydex_reference_url(cid, card.get("image_url")),
        "referenceImagePath": str(reference_path),
        "embeddingModel": model_id,
        "artifactVersion": artifact_version,
        "indexSource": "incremental_append",
    }
    # Same shape as the full build: only non-Pokémon entries carry `game`.
    if game and game != POKEMON_GAME:
        entry["game"] = game
    # A TCGplayer-only card's row IS its base row: metadata only, never
    # `referenceSource` (that tags alt-art rows, which _base_indexed_ids skips).
    if card.get("source_provider") == TCGPLAYER_ONLY_SOURCE_PROVIDER:
        entry["catalogSource"] = TCGPLAYER_ONLY_SOURCE_PROVIDER
    return entry


def _atomic_publish(
    index: RawVisualIndex,
    matrix: np.ndarray,
    entries: list[dict[str, Any]],
    manifest_updates: Mapping[str, Any],
    backup_suffix: str = ".pre-append.bak",
) -> None:
    npz_path = index.npz_path
    manifest_path = index.manifest_path
    npz_tmp = Path(str(npz_path) + ".tmp")
    manifest_tmp = Path(str(manifest_path) + ".tmp")

    # Write via a file handle so numpy doesn't auto-append ".npz" to the temp path.
    with open(npz_tmp, "wb") as handle:
        np.savez_compressed(handle, embeddings=matrix.astype(np.float32))

    # Preserve the existing manifest's top-level provenance (adapter paths, model
    # id, etc.); only the entries + count (+ the caller's stamps) change.
    base_manifest: dict[str, Any] = {}
    try:
        base_manifest = json.loads(manifest_path.read_text())
    except Exception:
        base_manifest = {}
    base_manifest["entries"] = entries
    base_manifest["entryCount"] = len(entries)
    base_manifest.update(manifest_updates)
    manifest_tmp.write_text(json.dumps(base_manifest))

    # Validate the temp pair loads + aligns before we swap anything in place.
    check = np.load(npz_tmp)["embeddings"]
    if check.ndim != 2 or check.shape[0] != len(entries):
        npz_tmp.unlink(missing_ok=True)
        manifest_tmp.unlink(missing_ok=True)
        raise RuntimeError(
            f"refusing to publish: temp npz rows {getattr(check, 'shape', None)} != {len(entries)} entries"
        )

    # Back up the current active (single rolling backup), then atomically swap.
    if npz_path.exists():
        shutil.copy2(npz_path, Path(str(npz_path) + backup_suffix))
    if manifest_path.exists():
        shutil.copy2(manifest_path, Path(str(manifest_path) + backup_suffix))
    os.replace(npz_tmp, npz_path)
    os.replace(manifest_tmp, manifest_path)


def excluded_row_positions(entries: Iterable[Mapping[str, Any]], game: str | None) -> list[int]:
    """Manifest positions whose card is excluded from this game's scanner."""
    return [i for i, entry in enumerate(entries) if is_excluded_from_visual_index(entry, game)]


def _remapped_art_crop_payload(
    art_path: Path,
    *,
    current_index_version: str,
    old_to_new: Mapping[int, int],
    new_index_version: str,
) -> tuple[dict[str, np.ndarray] | None, str]:
    """The art-crop sidecar rewritten for the pruned index (rows renumbered,
    dropped rows removed, stamped with the new index version), or None + why.
    A sidecar that is missing, unreadable or already built for a different index
    version is left alone: the matcher disables it by version mismatch and
    tools/build_visual_artcrop_index.py must be re-run."""
    if not art_path.exists():
        return None, "missing"
    try:
        with np.load(str(art_path), allow_pickle=False) as archive:
            payload = {key: np.asarray(archive[key]) for key in archive.files}
        rows = payload["rows"].reshape(-1)
        file_version = str(payload["index_artifact_version"].item())
    except Exception:  # noqa: BLE001 - a bad sidecar must not block the prune
        return None, "unreadable_left_disabled"
    if file_version != current_index_version:
        return None, "stale_left_disabled"
    keep = [position for position, row in enumerate(rows.tolist()) if int(row) in old_to_new]
    payload["rows"] = np.asarray([old_to_new[int(rows[p])] for p in keep], dtype=rows.dtype)
    payload["embeddings"] = payload["embeddings"][keep]
    payload["index_artifact_version"] = np.array(new_index_version)
    return payload, "remapped"


def _atomic_write_art_crop(art_path: Path, payload: Mapping[str, np.ndarray], backup_suffix: str) -> None:
    tmp = Path(str(art_path) + ".tmp")
    with open(tmp, "wb") as handle:
        np.savez(handle, **payload)
    with np.load(str(tmp), allow_pickle=False) as check:
        if check["rows"].shape[0] != check["embeddings"].shape[0]:
            tmp.unlink(missing_ok=True)
            raise RuntimeError("refusing to publish art-crop sidecar: rows/embeddings mismatch")
    shutil.copy2(art_path, Path(str(art_path) + backup_suffix))
    os.replace(tmp, art_path)


def prune_excluded_rows(
    *,
    index: RawVisualIndex,
    game: str | None,
    logger: LogFn | None = None,
) -> dict[str, Any]:
    """Remove index rows whose card is now excluded (VISUAL_INDEX_EXCLUSIONS),
    e.g. One Piece DON!! rows embedded before the exclusion existed.

    Every other row keeps its exact embedding bytes and manifest entry; only
    `rowIndex` is renumbered to stay equal to the npz position. Removing rows
    shifts row numbers, so the art-crop sidecar (keyed by row number) is
    remapped in the same publish, and the manifest artifactVersion gets a
    `+pruned-<ts>` suffix that the remapped sidecar is stamped with: a process
    still holding the old index (or an old sidecar) sees a version mismatch and
    skips the art rule instead of reading shifted rows.
    """
    index.load()
    entries = list(index.entries)
    remove = excluded_row_positions(entries, game)
    if not remove:
        return {"pruned": 0}
    if len(remove) > MAX_PRUNE_FRACTION * len(entries):
        raise RuntimeError(
            f"refusing to prune {len(remove)} of {len(entries)} rows (> {MAX_PRUNE_FRACTION:.0%}); aborting"
        )

    raw_existing = np.asarray(np.load(index.npz_path)["embeddings"], dtype=np.float32)
    if raw_existing.shape[0] != len(entries):
        raise RuntimeError(
            f"active npz/manifest mismatch ({raw_existing.shape[0]} rows vs {len(entries)} entries); aborting"
        )
    removed = set(remove)
    keep = [i for i in range(len(entries)) if i not in removed]
    old_to_new = {old: new for new, old in enumerate(keep)}
    new_matrix = raw_existing[keep]
    new_entries = []
    for old in keep:
        entry = dict(entries[old])
        entry["rowIndex"] = old_to_new[old]
        new_entries.append(entry)

    current_version = str(index.artifact_version or "")
    stamp = _utc_now().replace("-", "").replace(":", "")
    new_version = f"{current_version or 'unversioned'}+pruned-{stamp}"

    # Build the sidecar in memory first so only file writes remain after the
    # index swap. Index first, sidecar second: in between, the sidecar's old
    # version mismatches the new manifest, so the art rule pauses, never misreads.
    art_path = art_crop_path_for_index(index.npz_path, game or POKEMON_GAME)
    art_payload, art_status = _remapped_art_crop_payload(
        art_path, current_index_version=current_version, old_to_new=old_to_new, new_index_version=new_version
    )

    _atomic_publish(
        index,
        new_matrix,
        new_entries,
        {
            "artifactVersion": new_version,
            "lastPruneAt": _utc_now(),
            "lastPruneRemovedCount": len(remove),
            "lastPruneBaseArtifactVersion": current_version,
        },
        backup_suffix=".pre-prune.bak",
    )
    if art_payload is not None:
        try:
            _atomic_write_art_crop(art_path, art_payload, ".pre-prune.bak")
        except Exception as exc:  # noqa: BLE001 - the index prune already landed
            art_status = "write_failed_left_disabled"
            _log(logger, "WARNING", f"visual_index_prune art-crop write failed game={game} error={exc}")
    new_count = index.reload()
    _log(
        logger,
        "INFO",
        f"visual_index_prune game={game or POKEMON_GAME} pruned={len(remove)} entryCount={new_count} "
        f"artCrop={art_status}",
    )
    return {"pruned": len(remove), "entryCount": new_count, "artCrop": art_status, "artifactVersion": new_version}


def append_missing_cards(
    *,
    index: RawVisualIndex,
    connection: Any,
    embed_images_fn: EmbedImagesFn,
    model_id: str,
    artifact_version: str = "incremental",
    eligible_supertypes: Iterable[str] = DEFAULT_ELIGIBLE_SUPERTYPES,
    download_image_fn: DownloadImageFn | None = None,
    image_cache_root: Path | None = None,
    max_cards: int | None = None,
    logger: LogFn | None = None,
    game: str | None = None,
) -> dict[str, Any]:
    """Prune now-excluded rows, then embed catalog cards missing from the index,
    append them, and hot-reload.

    `game` None/pokemon keeps the Pokémon supertype eligibility; any other game
    diffs that game's catalog rows against its own per-game index.

    Returns a summary dict. A no-op (nothing to prune, nothing missing, or
    everything skipped) does not touch the active artifacts.
    """
    prune = prune_excluded_rows(index=index, game=game, logger=logger)
    result = _append_missing_cards(
        index=index,
        connection=connection,
        embed_images_fn=embed_images_fn,
        model_id=model_id,
        artifact_version=artifact_version,
        eligible_supertypes=eligible_supertypes,
        download_image_fn=download_image_fn,
        image_cache_root=image_cache_root,
        max_cards=max_cards,
        logger=logger,
        game=game,
    )
    result["pruned"] = prune["pruned"]
    if prune["pruned"]:
        result["changed"] = True
        result["artCrop"] = prune["artCrop"]
    return result


def _append_missing_cards(
    *,
    index: RawVisualIndex,
    connection: Any,
    embed_images_fn: EmbedImagesFn,
    model_id: str,
    artifact_version: str,
    eligible_supertypes: Iterable[str],
    download_image_fn: DownloadImageFn | None,
    image_cache_root: Path | None,
    max_cards: int | None,
    logger: LogFn | None,
    game: str | None,
) -> dict[str, Any]:
    download = download_image_fn or _default_download_image

    index.load()
    entries = list(index.entries)
    old_count = len(entries)
    embedding_dim = int(index.matrix.shape[1])

    rows = _candidate_rows(connection, eligible_supertypes, game)
    indexed_ids = _base_indexed_ids(entries)
    missing = [r for r in rows if r.get("id") not in indexed_ids]
    if max_cards is not None:
        missing = missing[: max(0, int(max_cards))]

    if not missing:
        return {"changed": False, "added": 0, "skipped": 0, "entryCount": old_count, "skippedIds": []}

    cache_root = image_cache_root or (index.npz_path.parent / ".cache" / "reference_images")
    cache_root.mkdir(parents=True, exist_ok=True)

    images: list[Any] = []
    kept: list[tuple[dict[str, Any], Path]] = []
    skipped_ids: list[str] = []
    for card in missing:
        cid = str(card.get("id") or "")
        url = _scrydex_reference_url(cid, card.get("image_url"))
        if not cid or not url:
            skipped_ids.append(cid)
            continue
        try:
            image = download(url)
        except Exception:
            # Brand-new sets can lag on Scrydex's image CDN; skip + retry next run.
            skipped_ids.append(cid)
            continue
        ref_path = cache_root / f"{cid}.png"
        try:
            image.save(ref_path)
        except OSError as exc:
            # No cached PNG means the card-back guard below reads a missing file.
            _log(logger, "WARNING", f"visual_index_append reference save failed id={cid} error={exc}")
        # Content guard: even with a real image_url, the URL can SERVE a generic
        # card-back placeholder (the McDonald's promo case). Hash the saved PNG and
        # skip it so the placeholder never becomes a false attractor in the index.
        if is_card_back_image(ref_path):
            skipped_ids.append(cid)
            continue
        images.append(image)
        kept.append((card, ref_path))

    if not images:
        _log(
            logger,
            "INFO",
            f"visual_index_append no-op game={game or POKEMON_GAME} added=0 skipped={len(skipped_ids)}",
        )
        return {
            "changed": False,
            "added": 0,
            "skipped": len(skipped_ids),
            "entryCount": old_count,
            "skippedIds": skipped_ids,
        }

    new_embeddings = np.asarray(embed_images_fn(images), dtype=np.float32)
    if new_embeddings.ndim != 2 or new_embeddings.shape[0] != len(kept):
        raise RuntimeError(
            f"embed returned {new_embeddings.shape} for {len(kept)} images; aborting append"
        )
    if new_embeddings.shape[1] != embedding_dim:
        raise RuntimeError(
            f"embedding dim mismatch: index {embedding_dim} vs new {new_embeddings.shape[1]}"
        )

    # Read the RAW existing rows from disk (the npz stores raw; the loader
    # normalizes). Append the new rows; never reorder existing rows.
    raw_existing = np.asarray(np.load(index.npz_path)["embeddings"], dtype=np.float32)
    if raw_existing.shape[0] != old_count:
        raise RuntimeError(
            f"active npz/manifest mismatch ({raw_existing.shape[0]} rows vs {old_count} entries); aborting"
        )
    new_matrix = np.vstack([raw_existing, new_embeddings])

    new_entries = list(entries)
    for offset, (card, ref_path) in enumerate(kept):
        new_entries.append(
            _manifest_entry(old_count + offset, card, ref_path, model_id, artifact_version, game)
        )

    if new_matrix.shape[0] != len(new_entries):
        raise RuntimeError("row/entry count mismatch after append; aborting")
    # Safety guard: never publish a smaller index than we started with.
    if len(new_entries) < old_count:
        raise RuntimeError("refusing to publish a shrunken index; aborting")

    _atomic_publish(
        index,
        new_matrix,
        new_entries,
        {"lastIncrementalAppendAt": _utc_now(), "lastIncrementalArtifactVersion": artifact_version},
    )
    new_count = index.reload()

    _log(
        logger,
        "INFO",
        f"visual_index_append game={game or POKEMON_GAME} added={len(kept)} "
        f"skipped={len(skipped_ids)} entryCount={new_count}",
    )
    return {
        "changed": True,
        "added": len(kept),
        "skipped": len(skipped_ids),
        "entryCount": new_count,
        "skippedIds": skipped_ids,
    }


def run_refresh(
    *,
    index: RawVisualIndex,
    connection: Any,
    embed_images_fn: EmbedImagesFn,
    model_id: str,
    dry_run: bool = False,
    max_cards: int | None = None,
    eligible_supertypes: Iterable[str] = DEFAULT_ELIGIBLE_SUPERTYPES,
    download_image_fn: DownloadImageFn | None = None,
    logger: LogFn | None = None,
    game_indexes: Mapping[str, RawVisualIndex | None] | None = None,
) -> dict[str, Any]:
    """Lock-guarded entry point used by the ops endpoint / sync hook.

    `index` is the Pokémon index; its result stays at the top level. Each
    non-Pokémon index in `game_indexes` (None = not built on this box) is
    refreshed against its own game's catalog rows and reported under
    ``games[<game>]``. `max_cards` caps each index separately.

    `dry_run` reports how many cards are missing without embedding anything. A
    concurrent refresh returns ``{"busy": True}`` instead of overlapping.
    """
    games = {g: gi for g, gi in (game_indexes or {}).items() if gi is not None and g != POKEMON_GAME}
    if dry_run:
        missing = diff_missing_ids(index, connection, eligible_supertypes=eligible_supertypes)
        result: dict[str, Any] = {
            "dryRun": True,
            "missing": len(missing),
            "missingSample": missing[:20],
            "wouldPrune": len(excluded_row_positions(index.entries, POKEMON_GAME)),
        }
        if games:
            result["games"] = {}
            for game, game_index in games.items():
                try:
                    game_missing = diff_missing_ids(game_index, connection, game=game)
                    result["games"][game] = {
                        "missing": len(game_missing),
                        "missingSample": game_missing[:20],
                        "wouldPrune": len(excluded_row_positions(game_index.entries, game)),
                    }
                except Exception as exc:  # noqa: BLE001 - one bad game must not hide the rest
                    result["games"][game] = {"error": str(exc)}
        return result
    if not _REFRESH_LOCK.acquire(blocking=False):
        return {"busy": True, "changed": False}
    try:
        pokemon_error: Exception | None = None
        try:
            result = append_missing_cards(
                index=index,
                connection=connection,
                embed_images_fn=embed_images_fn,
                model_id=model_id,
                eligible_supertypes=eligible_supertypes,
                download_image_fn=download_image_fn,
                max_cards=max_cards,
                logger=logger,
            )
        except Exception as exc:
            # Still refresh the other games; the Pokémon failure re-raises below.
            pokemon_error = exc
            result = {}
        if games:
            result["games"] = {}
            for game, game_index in games.items():
                try:
                    result["games"][game] = append_missing_cards(
                        index=game_index,
                        connection=connection,
                        embed_images_fn=embed_images_fn,
                        model_id=model_id,
                        download_image_fn=download_image_fn,
                        max_cards=max_cards,
                        logger=logger,
                        game=game,
                    )
                except Exception as exc:  # noqa: BLE001 - a failed game keeps its old index
                    _log(logger, "WARNING", f"visual_index_append failed game={game} error={exc}")
                    result["games"][game] = {"changed": False, "error": str(exc)}
        if pokemon_error is not None:
            raise pokemon_error
        return result
    finally:
        _REFRESH_LOCK.release()
