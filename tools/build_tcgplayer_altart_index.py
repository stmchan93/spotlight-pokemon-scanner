#!/usr/bin/env python3
"""Augment a per-game scanner visual index with TCGplayer alt-art rows.

Scrydex gives each card id one reference image. TCGplayer often lists several
products for that same card id (Alt Art, Manga, Special Alt Art, promo art…)
whose ARTWORK differs from the Scrydex image, so a photo of the alt-art
printing has nothing in the index to match. This tool embeds each non-base
TCGplayer product image with the exact runtime pipeline (frozen encoder, no
crop, projection adapter, L2-normalise) and appends a row for it under the
REAL card id, so the matcher's per-card max-collapse lets either art win.

A product is skipped when:
  * its card id is not in the base index (or is a sealed product),
  * it is the card's base product (product_id == cards.tcgplayer_id),
  * its image is missing / shared by several products (placeholder guard),
  * it is the SAME ART as the card's Scrydex row (cosine >= threshold) —
    finish-only products (Normal/Foil/Cold Foil/…) land here,
  * it is the same art as a product already added for that card,
  * its label is finish-only but the art is far from the base row — that is
    a suspected bad mapping (a finish cannot change the art), logged, not added.

Existing rows are never re-embedded or re-projected; the base matrix is copied
verbatim. Re-running on an augmented index first drops its tcgplayer rows, so
the output is idempotent.

    backend/.venv/bin/python tools/build_tcgplayer_altart_index.py \
        --game onepiece \
        --base-npz visual_index_active_onepiece_siglip2-base-patch16-384.npz \
        --base-manifest visual_index_active_onepiece_manifest.json \
        --mapping mapping.json --images-dir img/ \
        --adapter backend/data/visual-models/raw_visual_adapter_siglip2-384-v003-candidate.pt \
        --out-dir out/onepiece

The mapping is a JSON list of either dicts
``{card_id, product_id, variant_label, ordinal, tcgplayer_id}`` (the shape of
a ``card_tcgplayer_products JOIN cards`` export) or lists
``[card_id, ordinal, product_id, variant_label, tcgplayer_id]``. Images are
``<images-dir>/<product_id>.jpg``.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"

REFERENCE_SOURCE = "tcgplayer"
DEFAULT_SUFFIX = "+tcgp-altart-20260928"
DEFAULT_THRESHOLD = 0.97
DEFAULT_SUSPECT_THRESHOLD = 0.80
DEFAULT_FINISH_ONLY_LABELS = (
    "Normal",
    "Foil",
    "Holofoil",
    "Cold Foil",
    "Reverse Holofoil",
    "Jolly Roger Foil",
    "Textured Foil",
    "Reprint",
)
SEALED_PREFIX = "tcgp-sealed"
PLACEHOLDER_SHARED_MIN = 3
TCGPLAYER_IMAGE_URL = "https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg"

SKIP_NOT_IN_INDEX = "skipped_not_in_index"
SKIP_SEALED = "skipped_sealed"
SKIP_BASE = "skipped_base_product"
SKIP_MISSING_IMAGE = "skipped_missing_image"
SKIP_PLACEHOLDER = "skipped_placeholder_image"
SKIP_SAME_ART = "skipped_same_art"
SKIP_DUP_PRODUCT = "skipped_duplicate_product_art"
SKIP_SUSPECT = "skipped_suspect_mapping"
ADDED = "added"


@dataclass
class Candidate:
    card_id: str
    product_id: str
    labels: list[str]
    ordinal: int
    base_product_id: str | None

    @property
    def label(self) -> str:
        return "/".join(self.labels) if self.labels else "Unknown"


@dataclass
class Decision:
    candidate: Candidate
    outcome: str
    base_similarity: float | None = None
    note: str | None = None


@dataclass
class SelectionResult:
    decisions: list[Decision] = field(default_factory=list)
    added: list[tuple[Candidate, np.ndarray]] = field(default_factory=list)


def _clean_id(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def load_mapping_rows(raw: Iterable[Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            rows.append(
                {
                    "card_id": _clean_id(item.get("card_id")),
                    "product_id": _clean_id(item.get("product_id")),
                    "variant_label": item.get("variant_label"),
                    "ordinal": item.get("ordinal"),
                    "tcgplayer_id": _clean_id(item.get("tcgplayer_id")),
                }
            )
        elif isinstance(item, (list, tuple)) and len(item) >= 5:
            card_id, ordinal, product_id, label, base = item[:5]
            rows.append(
                {
                    "card_id": _clean_id(card_id),
                    "product_id": _clean_id(product_id),
                    "variant_label": label,
                    "ordinal": ordinal,
                    "tcgplayer_id": _clean_id(base),
                }
            )
        else:
            raise ValueError(f"Unrecognised mapping row: {item!r}")
    return [row for row in rows if row["card_id"] and row["product_id"]]


def group_candidates(rows: list[dict[str, Any]]) -> list[Candidate]:
    """One candidate per (card_id, product_id); labels merged, lowest ordinal kept."""
    grouped: dict[tuple[str, str], Candidate] = {}
    for row in rows:
        key = (row["card_id"], row["product_id"])
        label = str(row.get("variant_label") or "").strip()
        ordinal = int(row["ordinal"]) if row.get("ordinal") is not None else 0
        existing = grouped.get(key)
        if existing is None:
            grouped[key] = Candidate(
                card_id=row["card_id"],
                product_id=row["product_id"],
                labels=[label] if label else [],
                ordinal=ordinal,
                base_product_id=row.get("tcgplayer_id"),
            )
            continue
        if label and label not in existing.labels:
            existing.labels = sorted([*existing.labels, label])
        existing.ordinal = min(existing.ordinal, ordinal)
        existing.base_product_id = existing.base_product_id or row.get("tcgplayer_id")
    return sorted(grouped.values(), key=lambda c: (c.card_id, c.ordinal, c.product_id))


def strip_tcgplayer_rows(
    entries: list[dict[str, Any]], matrix: np.ndarray
) -> tuple[list[dict[str, Any]], np.ndarray, int]:
    keep = [i for i, e in enumerate(entries) if e.get("referenceSource") != REFERENCE_SOURCE]
    dropped = len(entries) - len(keep)
    if not dropped:
        return list(entries), matrix, 0
    kept_entries = []
    for new_index, old_index in enumerate(keep):
        entry = dict(entries[old_index])
        entry["rowIndex"] = new_index
        kept_entries.append(entry)
    return kept_entries, matrix[keep], dropped


def _normalize_rows(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return values / norms


def is_finish_only(candidate: Candidate, finish_only_labels: set[str]) -> bool:
    return bool(candidate.labels) and all(label in finish_only_labels for label in candidate.labels)


def select_alt_art_rows(
    *,
    base_entries: list[dict[str, Any]],
    base_matrix: np.ndarray,
    candidates: list[Candidate],
    image_path_for: Callable[[str], Path],
    embed_products: Callable[[list[str]], np.ndarray],
    threshold: float,
    suspect_threshold: float,
    finish_only_labels: set[str],
    placeholder_product_ids: set[str] | None = None,
) -> SelectionResult:
    """Decide which products get a row. ``embed_products`` returns projected rows."""
    result = SelectionResult()
    rows_by_card: dict[str, list[int]] = defaultdict(list)
    for index, entry in enumerate(base_entries):
        rows_by_card[str(entry.get("providerCardId"))].append(index)
    placeholder_product_ids = placeholder_product_ids or set()
    base_normed = _normalize_rows(base_matrix)

    pending: list[Candidate] = []
    for candidate in candidates:
        if candidate.card_id.startswith(SEALED_PREFIX):
            result.decisions.append(Decision(candidate, SKIP_SEALED))
        elif candidate.card_id not in rows_by_card:
            result.decisions.append(Decision(candidate, SKIP_NOT_IN_INDEX))
        elif candidate.base_product_id and candidate.product_id == candidate.base_product_id:
            result.decisions.append(Decision(candidate, SKIP_BASE))
        elif not image_path_for(candidate.product_id).exists():
            result.decisions.append(Decision(candidate, SKIP_MISSING_IMAGE))
        elif candidate.product_id in placeholder_product_ids:
            result.decisions.append(Decision(candidate, SKIP_PLACEHOLDER))
        else:
            pending.append(candidate)

    unique_products = sorted({c.product_id for c in pending})
    embeddings = _normalize_rows(embed_products(unique_products)) if unique_products else np.zeros((0, base_matrix.shape[1]), np.float32)
    row_for_product = {pid: embeddings[i] for i, pid in enumerate(unique_products)}

    accepted_by_card: dict[str, list[np.ndarray]] = defaultdict(list)
    for candidate in pending:
        vector = row_for_product[candidate.product_id]
        base_sim = float(np.max(base_normed[rows_by_card[candidate.card_id]] @ vector))
        if base_sim >= threshold:
            result.decisions.append(Decision(candidate, SKIP_SAME_ART, base_sim))
            continue
        if is_finish_only(candidate, finish_only_labels):
            outcome = SKIP_SUSPECT if base_sim < suspect_threshold else SKIP_SAME_ART
            note = "finish-only label but different art" if outcome == SKIP_SUSPECT else "finish-only label"
            result.decisions.append(Decision(candidate, outcome, base_sim, note))
            continue
        prior = accepted_by_card[candidate.card_id]
        if prior and max(float(p @ vector) for p in prior) >= threshold:
            result.decisions.append(Decision(candidate, SKIP_DUP_PRODUCT, base_sim))
            continue
        prior.append(vector)
        result.decisions.append(Decision(candidate, ADDED, base_sim))
        result.added.append((candidate, vector))
    return result


def build_augmented_index(
    *,
    base_manifest: dict[str, Any],
    base_entries: list[dict[str, Any]],
    base_matrix: np.ndarray,
    added: list[tuple[Candidate, np.ndarray]],
    image_path_for: Callable[[str], Path],
    version_suffix: str,
    augmentation_summary: dict[str, Any],
) -> tuple[dict[str, Any], np.ndarray]:
    base_version = str(base_manifest.get("artifactVersion") or "")
    if version_suffix in base_version:
        base_version = base_version.split(version_suffix)[0]
    version = base_version + version_suffix
    by_card = {str(e.get("providerCardId")): e for e in base_entries}
    entries = list(base_entries)
    new_rows: list[np.ndarray] = []
    for candidate, vector in added:
        entry = copy.deepcopy(by_card[candidate.card_id])
        entry["rowIndex"] = len(entries)
        # imageUrl stays the card's Scrydex image: candidate pools can surface
        # it in the app, and TCGplayer images aren't cleared for display.
        entry["tcgplayerImageUrl"] = TCGPLAYER_IMAGE_URL.format(pid=candidate.product_id)
        entry["artifactVersion"] = version
        entry["referenceSource"] = REFERENCE_SOURCE
        entry["variantLabel"] = candidate.label
        entry["tcgplayerProductId"] = candidate.product_id
        entry["tcgplayerOrdinal"] = candidate.ordinal
        entries.append(entry)
        new_rows.append(vector.astype(np.float32))
    matrix = base_matrix.astype(np.float32)
    if new_rows:
        matrix = np.concatenate([matrix, np.stack(new_rows)], axis=0)
    assert matrix.shape[0] == len(entries)
    manifest = {k: v for k, v in base_manifest.items() if k != "entries"}
    manifest["artifactVersion"] = version
    manifest["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest["entryCount"] = len(entries)
    manifest["altArtAugmentation"] = {"baseArtifactVersion": base_version, **augmentation_summary}
    manifest["entries"] = entries
    return manifest, matrix


def placeholder_products(product_ids: Iterable[str], image_path_for: Callable[[str], Path]) -> set[str]:
    by_hash: dict[str, list[str]] = defaultdict(list)
    for pid in product_ids:
        path = image_path_for(pid)
        if path.exists():
            by_hash[hashlib.md5(path.read_bytes()).hexdigest()].append(pid)
    return {pid for pids in by_hash.values() if len(pids) >= PLACEHOLDER_SHARED_MIN for pid in pids}


def summarize(result: SelectionResult) -> dict[str, Any]:
    outcomes = Counter(d.outcome for d in result.decisions)
    per_label: dict[str, Counter] = defaultdict(Counter)
    for decision in result.decisions:
        per_label[decision.candidate.label][decision.outcome] += 1
    return {
        "productsConsidered": len(result.decisions),
        "outcomes": dict(sorted(outcomes.items())),
        "perLabel": {label: dict(sorted(c.items())) for label, c in sorted(per_label.items(), key=lambda kv: -sum(kv[1].values()))},
    }


# --- runtime embedding (lazy heavy imports so the selection logic is testable) ---


class ProductEmbedder:
    def __init__(self, *, model_id: str, adapter_path: Path, image_path_for: Callable[[str], Path], batch_size: int, cache_path: Path | None):
        if str(BACKEND_ROOT) not in sys.path:
            sys.path.insert(0, str(BACKEND_ROOT))
        from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy

        self._project = project_embeddings_numpy
        self.encoder = RawVisualFrozenEncoder(model_id=model_id, device="cpu", backend="onnx")
        self.adapter = load_projection_adapter(adapter_path, embedding_dim=768, device=self.encoder.device)
        self.adapter_tag = f"{adapter_path.name}:{adapter_path.stat().st_size}:{model_id}"
        self.image_path_for = image_path_for
        self.batch_size = batch_size
        self.cache_path = cache_path
        self.cache: dict[str, np.ndarray] = {}
        if cache_path and cache_path.exists():
            data = np.load(cache_path, allow_pickle=False)
            if str(data["adapter_tag"]) == self.adapter_tag:
                self.cache = {str(p): data["embeddings"][i] for i, p in enumerate(data["product_ids"])}
                print(f"[embed] cache hit {len(self.cache)} rows from {cache_path}", flush=True)

    def embed_pil(self, images: list[Any]) -> np.ndarray:
        raw = self.encoder.embed_images(images, batch_size=self.batch_size)
        return _normalize_rows(self._project(self.adapter, raw, device=self.encoder.device, batch_size=256))

    def __call__(self, product_ids: list[str]) -> np.ndarray:
        from PIL import Image

        todo = [pid for pid in product_ids if pid not in self.cache]
        print(f"[embed] {len(product_ids)} products, {len(todo)} to embed", flush=True)
        chunk = 64
        for start in range(0, len(todo), chunk):
            pids = todo[start : start + chunk]
            images = [Image.open(self.image_path_for(pid)).convert("RGB") for pid in pids]
            vectors = self.embed_pil(images)
            for pid, vector in zip(pids, vectors):
                self.cache[pid] = vector
            print(f"[embed] {min(start + chunk, len(todo))}/{len(todo)}", flush=True)
        if todo and self.cache_path:
            keys = sorted(self.cache)
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            np.savez(
                self.cache_path,
                product_ids=np.array(keys),
                embeddings=np.stack([self.cache[k] for k in keys]).astype(np.float32),
                adapter_tag=np.array(self.adapter_tag),
            )
        return np.stack([self.cache[pid] for pid in product_ids]) if product_ids else np.zeros((0, 768), np.float32)


def parity_check(embedder: ProductEmbedder, entries: list[dict[str, Any]], matrix: np.ndarray, count: int) -> float | None:
    """Re-embed a few base rows from their Scrydex image URL; must reproduce the stored rows."""
    import io
    from urllib.request import Request, urlopen

    from PIL import Image

    picks = [i for i in range(0, len(entries), max(1, len(entries) // count))][:count]
    images, rows = [], []
    for index in picks:
        url = entries[index].get("imageUrl")
        if not url:
            continue
        try:
            request = Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36"})
            images.append(Image.open(io.BytesIO(urlopen(request, timeout=30).read())).convert("RGB"))
            rows.append(index)
        except Exception as exc:  # network is best-effort for the check
            print(f"[parity] skip row {index}: {exc}", flush=True)
    if not images:
        return None
    vectors = embedder.embed_pil(images)
    cosines = [float(vectors[i] @ _normalize_rows(matrix[[r]])[0]) for i, r in enumerate(rows)]
    print(f"[parity] {len(cosines)} base rows re-embedded: min cos {min(cosines):.5f} mean {np.mean(cosines):.5f}", flush=True)
    return min(cosines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", required=True)
    parser.add_argument("--base-npz", type=Path, required=True)
    parser.add_argument("--base-manifest", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--images-dir", type=Path, required=True)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--model-id", default="google/siglip2-base-patch16-384")
    parser.add_argument("--same-art-threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--suspect-threshold", type=float, default=DEFAULT_SUSPECT_THRESHOLD,
                        help="Finish-only labels below this base cosine are logged as suspected bad mappings.")
    parser.add_argument("--finish-only-labels", default=",".join(DEFAULT_FINISH_ONLY_LABELS),
                        help="Comma-separated labels that can never change the art.")
    parser.add_argument("--version-suffix", default=DEFAULT_SUFFIX)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--embedding-cache", type=Path, default=None,
                        help="Optional .npz cache of projected product embeddings (keyed by adapter).")
    parser.add_argument("--report-json", type=Path, default=None, help="Write every decision with its similarity.")
    parser.add_argument("--parity-check", type=int, default=0, help="Re-embed N base rows from Scrydex URLs first.")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    base_manifest = json.loads(args.base_manifest.read_text())
    crop = str(base_manifest.get("cropPreset") or "none").lower()
    if crop not in {"none", "full_card", ""}:
        raise SystemExit(f"Base index uses crop preset {crop!r}; this tool only supports full-card indexes.")
    if base_manifest.get("modelId") and base_manifest["modelId"] != args.model_id:
        raise SystemExit(f"Base index model {base_manifest['modelId']} != --model-id {args.model_id}")
    base_matrix = np.load(args.base_npz)["embeddings"].astype(np.float32)
    base_entries = [e for e in base_manifest.get("entries", []) if isinstance(e, dict)]
    if base_matrix.shape[0] != len(base_entries):
        raise SystemExit(f"Row mismatch: npz {base_matrix.shape[0]} vs manifest {len(base_entries)}")
    base_entries, base_matrix, dropped = strip_tcgplayer_rows(base_entries, base_matrix)
    if dropped:
        print(f"[base] dropped {dropped} existing {REFERENCE_SOURCE} rows (re-run)", flush=True)

    images_dir = args.images_dir.resolve()

    def image_path_for(pid: str) -> Path:
        return images_dir / f"{pid}.jpg"

    candidates = group_candidates(load_mapping_rows(json.loads(args.mapping.read_text())))
    placeholders = placeholder_products({c.product_id for c in candidates}, image_path_for)
    embedder = ProductEmbedder(
        model_id=args.model_id,
        adapter_path=args.adapter,
        image_path_for=image_path_for,
        batch_size=args.batch_size,
        cache_path=args.embedding_cache,
    )
    parity = parity_check(embedder, base_entries, base_matrix, args.parity_check) if args.parity_check else None
    if parity is not None and parity < 0.999:
        raise SystemExit(f"Parity check failed (min cos {parity:.5f}): encoder/adapter does not reproduce base rows.")

    finish_only = {s.strip() for s in args.finish_only_labels.split(",") if s.strip()}
    result = select_alt_art_rows(
        base_entries=base_entries,
        base_matrix=base_matrix,
        candidates=candidates,
        image_path_for=image_path_for,
        embed_products=embedder,
        threshold=args.same_art_threshold,
        suspect_threshold=args.suspect_threshold,
        finish_only_labels=finish_only,
        placeholder_product_ids=placeholders,
    )
    summary = summarize(result)
    summary.update(
        {
            "game": args.game,
            "baseRowCount": len(base_entries),
            "addedRowCount": len(result.added),
            "addedCardCount": len({c.card_id for c, _ in result.added}),
            "sameArtThreshold": args.same_art_threshold,
            "suspectThreshold": args.suspect_threshold,
            "finishOnlyLabels": sorted(finish_only),
            "referenceSource": REFERENCE_SOURCE,
            "adapter": args.adapter.name,
            "encoder": f"{args.model_id} (onnx fp32)",
            "parityCosMin": parity,
            "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    )
    print(json.dumps({k: v for k, v in summary.items() if k != "perLabel"}, indent=2))
    print("[per-label outcomes]")
    for label, counts in summary["perLabel"].items():
        print(f"  {label:40s} {counts}")
    suspects = [d for d in result.decisions if d.outcome == SKIP_SUSPECT]
    for d in suspects:
        print(f"[suspect] {d.candidate.card_id} product {d.candidate.product_id} '{d.candidate.label}' base cos {d.base_similarity:.3f}")

    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps([
            {"card_id": d.candidate.card_id, "product_id": d.candidate.product_id, "label": d.candidate.label,
             "ordinal": d.candidate.ordinal, "outcome": d.outcome, "base_similarity": d.base_similarity, "note": d.note}
            for d in result.decisions
        ], indent=1))
    if args.dry_run:
        print("[dry-run] no index written")
        return 0

    manifest, matrix = build_augmented_index(
        base_manifest=base_manifest,
        base_entries=base_entries,
        base_matrix=base_matrix,
        added=result.added,
        image_path_for=image_path_for,
        version_suffix=args.version_suffix,
        augmentation_summary={k: v for k, v in summary.items()},
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    npz_out = args.out_dir / args.base_npz.name
    manifest_out = args.out_dir / args.base_manifest.name
    np.savez(npz_out, embeddings=matrix.astype(np.float32))
    manifest_out.write_text(json.dumps(manifest, indent=2))
    print(f"[write] rows {len(base_entries)} -> {len(manifest['entries'])}")
    print(f"[write] {npz_out}\n[write] {manifest_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
