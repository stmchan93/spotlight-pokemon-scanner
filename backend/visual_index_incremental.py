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
from typing import Any, Callable, Iterable

import numpy as np

from raw_visual_index import RawVisualIndex
from visual_index_placeholders import is_card_back_image

try:  # reuse the canonical alias derivation when available
    from catalog_tools import derive_card_title_aliases
except Exception:  # pragma: no cover - fallback keeps the module importable
    derive_card_title_aliases = None  # type: ignore[assignment]

# Supertypes that belong in the visual index (mirrors the full build's defaults).
DEFAULT_ELIGIBLE_SUPERTYPES: tuple[str, ...] = ("pokémon", "pokemon", "trainer", "energy")

_IMAGE_USER_AGENT = "Ekalight/0.1 (+https://local.ekalight.app)"
_DOWNLOAD_TIMEOUT_SECONDS = 30

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


def diff_missing_ids(
    index: RawVisualIndex,
    connection: Any,
    *,
    eligible_supertypes: Iterable[str] = DEFAULT_ELIGIBLE_SUPERTYPES,
) -> list[str]:
    """Catalog card IDs that belong in the index but have no embedding yet."""
    index.load()
    indexed = {entry.get("providerCardId") for entry in index.entries}
    rows = _eligible_card_rows(connection, eligible_supertypes)
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
    row_index: int, card: dict[str, Any], reference_path: Path, model_id: str, artifact_version: str
) -> dict[str, Any]:
    cid = card.get("id")
    return {
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


def _atomic_publish(
    index: RawVisualIndex, matrix: np.ndarray, entries: list[dict[str, Any]], artifact_version: str
) -> None:
    npz_path = index.npz_path
    manifest_path = index.manifest_path
    npz_tmp = Path(str(npz_path) + ".tmp")
    manifest_tmp = Path(str(manifest_path) + ".tmp")

    # Write via a file handle so numpy doesn't auto-append ".npz" to the temp path.
    with open(npz_tmp, "wb") as handle:
        np.savez_compressed(handle, embeddings=matrix.astype(np.float32))

    # Preserve the existing manifest's top-level provenance (adapter paths, model
    # id, etc.); only the entries + count change.
    base_manifest: dict[str, Any] = {}
    try:
        base_manifest = json.loads(manifest_path.read_text())
    except Exception:
        base_manifest = {}
    base_manifest["entries"] = entries
    base_manifest["entryCount"] = len(entries)
    base_manifest["lastIncrementalAppendAt"] = _utc_now()
    base_manifest["lastIncrementalArtifactVersion"] = artifact_version
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
        shutil.copy2(npz_path, Path(str(npz_path) + ".pre-append.bak"))
    if manifest_path.exists():
        shutil.copy2(manifest_path, Path(str(manifest_path) + ".pre-append.bak"))
    os.replace(npz_tmp, npz_path)
    os.replace(manifest_tmp, manifest_path)


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
) -> dict[str, Any]:
    """Embed catalog cards missing from the index, append them, and hot-reload.

    Returns a summary dict. A no-op (nothing missing, or everything skipped) does
    not touch the active artifacts.
    """
    download = download_image_fn or _default_download_image

    index.load()
    entries = list(index.entries)
    old_count = len(entries)
    embedding_dim = int(index.matrix.shape[1])

    rows = _eligible_card_rows(connection, eligible_supertypes)
    indexed_ids = {entry.get("providerCardId") for entry in entries}
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
        except Exception:
            pass
        # Content guard: even with a real image_url, the URL can SERVE a generic
        # card-back placeholder (the McDonald's promo case). Hash the saved PNG and
        # skip it so the placeholder never becomes a false attractor in the index.
        if is_card_back_image(ref_path):
            skipped_ids.append(cid)
            continue
        images.append(image)
        kept.append((card, ref_path))

    if not images:
        _log(logger, "INFO", f"visual_index_append no-op added=0 skipped={len(skipped_ids)}")
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
        new_entries.append(_manifest_entry(old_count + offset, card, ref_path, model_id, artifact_version))

    if new_matrix.shape[0] != len(new_entries):
        raise RuntimeError("row/entry count mismatch after append; aborting")
    # Safety guard: never publish a smaller index than we started with.
    if len(new_entries) < old_count:
        raise RuntimeError("refusing to publish a shrunken index; aborting")

    _atomic_publish(index, new_matrix, new_entries, artifact_version)
    new_count = index.reload()

    _log(
        logger,
        "INFO",
        f"visual_index_append added={len(kept)} skipped={len(skipped_ids)} entryCount={new_count}",
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
) -> dict[str, Any]:
    """Lock-guarded entry point used by the ops endpoint / sync hook.

    `dry_run` reports how many cards are missing without embedding anything. A
    concurrent refresh returns ``{"busy": True}`` instead of overlapping.
    """
    if dry_run:
        missing = diff_missing_ids(index, connection, eligible_supertypes=eligible_supertypes)
        return {"dryRun": True, "missing": len(missing), "missingSample": missing[:20]}
    if not _REFRESH_LOCK.acquire(blocking=False):
        return {"busy": True, "changed": False}
    try:
        return append_missing_cards(
            index=index,
            connection=connection,
            embed_images_fn=embed_images_fn,
            model_id=model_id,
            eligible_supertypes=eligible_supertypes,
            download_image_fn=download_image_fn,
            max_cards=max_cards,
            logger=logger,
        )
    finally:
        _REFRESH_LOCK.release()
