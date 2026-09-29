"""Decide the TCGplayer-only classifier's REVIEW rows by comparing pictures.

Plan: docs/tcgplayer-only-catalog-plan-2026-09-29.md. The name/number rules in
tcgplayer_only_catalog.py park a product in `review` when it might duplicate a
card we already have. The user's rule (2026-09-29) settles those by image:

    same picture as a card we have  -> a version of that card  (shadow_linked)
    different picture from them all -> a new card              (shadow_missing)

Both pictures go through the scanner's whole-card pipeline (frozen SigLIP2
encoder, no crop, active projection adapter, L2-normalised), so a cosine here
means what it means to the matcher. Candidates are the cards the classifier
said the product might duplicate, widened to every same-name card in the game
(the P0 evidence keeps only 5 candidates and 5 mapped sets).

Only rows whose status is still `review` are read or written. A row this
module cannot decide stays `review` with `evidence.imageResolution.reason`.
Decided rows carry `evidence.resolvedBy = "image"`.
"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np

import tcgplayer_only_catalog as tpo
from catalog_tools import utc_now
from sealed_products import TCGCSV_CATEGORY_GAME
from tcgcsv_adapter import card_numbers_match, normalized_card_number

# Calibrated 2026-09-29 on the P0 run (tools/resolve_tcgplayer_only_review.py
# --calibrate + visual pair sheets). Stamps, holo patterns, "Oversize" and
# "Not Tournament Legal" banners and old-print scans pull SAME-art pairs down
# to ~0.80, while different art of the same Pokémon/character reaches ~0.916
# (Klink 0.909, Sanji 0.916, Simba 0.916). Between the two the picture alone
# cannot tell, so the row stays in review.
SAME_ART_THRESHOLD = 0.93
DIFFERENT_ART_THRESHOLD = 0.80
# Two candidates both past SAME_ART and this close are the same picture
# printed twice (reprints, energies): which card it is cannot be told by image.
TIE_MARGIN = 0.01

MIN_IMAGE_WIDTH = 400
PLACEHOLDER_SHARED_MIN = 3
TCGPLAYER_IMAGE_URL = "https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg"
TCGPLAYER_IMAGE_PREFIX = TCGPLAYER_IMAGE_URL.split("{", 1)[0]
# TCGplayer's CDN and Scrydex's image host both 403 Python's default agent.
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

RESOLVED_BY = "image"

REASON_LINKED = "same-art"
REASON_LINKED_NUMBER_TIEBREAK = "same-art-tie-number-match"
REASON_MISSING = "different-art"
REASON_TIE = "same-art-tie"
REASON_AMBIGUOUS = "similarity-between-thresholds"
REASON_NO_CANDIDATES = "no-candidates"
REASON_CANDIDATE_IMAGES_MISSING = "candidate-images-missing"
REASON_UNCOMPARED_CANDIDATES = "different-art-but-uncompared-candidates"
REASON_BANNER_CLASS = "different-art-but-banner-class"
# Classifier product classes printed with a diagonal banner over the same art
# (World Championship Deck "Not Tournament Legal", jumbo "Oversize"): the banner
# alone drops the cosine to ~0.75, so they may link but never go missing.
NO_MISSING_CLASSES = frozenset({"world_championship_deck", "oversized"})
IMAGE_MISSING = "image-missing"
IMAGE_PLACEHOLDER = "image-placeholder"
IMAGE_LANDSCAPE = "image-landscape"
IMAGE_LOW_RES = "image-low-res"
IMAGE_UNREADABLE = "image-unreadable"
# Guard failures still worth embedding: they may link, never go missing.
EMBEDDABLE_PRODUCT_REASONS = frozenset({None, IMAGE_LOW_RES})


@dataclass(frozen=True)
class Thresholds:
    same_art: float = SAME_ART_THRESHOLD
    different_art: float = DIFFERENT_ART_THRESHOLD
    tie_margin: float = TIE_MARGIN

    def as_dict(self) -> dict[str, float]:
        return {"sameArt": self.same_art, "differentArt": self.different_art, "tieMargin": self.tie_margin}


# --- image guard -----------------------------------------------------------


def image_guard_reason(
    size: tuple[int, int] | None,
    *,
    shared_count: int = 1,
    exists: bool = True,
    min_width: int = MIN_IMAGE_WIDTH,
) -> str | None:
    """None when the picture is usable; otherwise why not. `shared_count` is how
    many distinct products serve these exact bytes (a stock "no image" tile)."""
    if not exists:
        return IMAGE_MISSING
    if size is None:
        return IMAGE_UNREADABLE
    if shared_count >= PLACEHOLDER_SHARED_MIN:
        return IMAGE_PLACEHOLDER
    width, height = size
    if width > height:
        # Cards are portrait; TCGplayer's "Image Coming Soon" tile is landscape.
        return IMAGE_LANDSCAPE
    if width < min_width:
        return IMAGE_LOW_RES
    return None


# --- candidates ------------------------------------------------------------


@dataclass
class ReviewRow:
    product_id: str
    category_id: int
    game_key: str
    version_label: str
    evidence: dict[str, Any]

    @property
    def game_language(self) -> tuple[str, str]:
        return TCGCSV_CATEGORY_GAME.get(self.category_id, (tpo.GAME_POKEMON, "English"))

    @property
    def number(self) -> str:
        return str(self.evidence.get("number") or "")


def load_review_rows(connection: sqlite3.Connection, product_ids: Iterable[str] | None = None) -> list[ReviewRow]:
    rows = connection.execute(
        "SELECT product_id, category_id, game, version_label, evidence_json "
        "FROM tcgplayer_product_classifications WHERE status = ? ORDER BY product_id",
        (tpo.STATUS_REVIEW,),
    ).fetchall()
    wanted = {str(p) for p in product_ids} if product_ids is not None else None
    out = []
    for product_id, category_id, game_key, version_label, evidence_json in rows:
        if wanted is not None and str(product_id) not in wanted:
            continue
        try:
            evidence = json.loads(evidence_json or "{}")
        except ValueError:
            evidence = {}
        out.append(ReviewRow(str(product_id), int(category_id), str(game_key), str(version_label or ""),
                             evidence if isinstance(evidence, dict) else {}))
    return out


def review_candidates(row: ReviewRow, index: tpo.CatalogIndex) -> list[str]:
    """Card ids to compare against: the P0 evidence candidates, the rules'
    candidates recomputed from the evidence, and every same-name card in the
    game. Wider only helps: an extra candidate can turn `missing` into `linked`
    or review, never the reverse."""
    game, language = row.game_language
    scope = index.scope(game, language)
    ordered: dict[str, None] = {}
    for card_id in row.evidence.get("candidates") or []:
        if str(card_id) in scope.by_id:
            ordered[str(card_id)] = None
    base_name, _ = tpo.split_product_name(row.evidence.get("name"))
    name_keys = tpo.product_name_keys(base_name)
    # tpo._decide is the classifier's rules table; reusing it keeps one source
    # of truth for which cards a product might duplicate.
    _, _, _, rule_candidates = tpo._decide(
        game=game,
        category_id=row.category_id,
        name_keys=name_keys,
        raw_number=row.number,
        rarity=tpo.rarity_class(row.evidence.get("rarity")),
        sets=list(row.evidence.get("mappedSets") or []),
        scope=scope,
    )
    for card in rule_candidates:
        ordered[card.id] = None
    for name_key in sorted(name_keys):
        for card in scope.by_name.get(name_key, ()):
            ordered[card.id] = None
    return list(ordered)


# --- decision --------------------------------------------------------------


@dataclass
class Decision:
    status: str  # shadow_linked | shadow_missing | review
    card_id: str | None
    reason: str
    max_cosine: float | None
    similarities: dict[str, float]
    uncompared: list[str] = field(default_factory=list)


def decide(
    product_vector: np.ndarray,
    candidate_vectors: Mapping[str, np.ndarray | None],
    *,
    thresholds: Thresholds = Thresholds(),
    product_number: str = "",
    product_class: str = "",
    candidate_numbers: Mapping[str, str] | None = None,
) -> Decision:
    """Pure threshold logic. `candidate_vectors[id]` is None when that card has
    no usable picture; such a card can still be out-matched (link) but blocks a
    `missing` call, since its picture might be the product's."""
    compared = {cid: v for cid, v in candidate_vectors.items() if v is not None}
    uncompared = sorted(cid for cid, v in candidate_vectors.items() if v is None)
    if not candidate_vectors:
        return Decision(tpo.STATUS_REVIEW, None, REASON_NO_CANDIDATES, None, {})
    if not compared:
        return Decision(tpo.STATUS_REVIEW, None, REASON_CANDIDATE_IMAGES_MISSING, None, {}, uncompared)
    vector = np.asarray(product_vector, dtype=np.float32)
    sims = {cid: round(float(np.dot(vector, np.asarray(v, dtype=np.float32))), 4) for cid, v in compared.items()}
    ranked = sorted(sims.items(), key=lambda kv: (-kv[1], kv[0]))
    best_id, best = ranked[0]
    if best >= thresholds.same_art:
        tied = [cid for cid, sim in ranked if sim >= thresholds.same_art and best - sim < thresholds.tie_margin]
        if len(tied) == 1:
            return Decision(tpo.STATUS_SHADOW_LINKED, best_id, REASON_LINKED, best, sims, uncompared)
        number = normalized_card_number(product_number)
        numbers = candidate_numbers or {}
        numbered = [cid for cid in tied if number and card_numbers_match(normalized_card_number(numbers.get(cid) or ""), number)]
        if len(numbered) == 1:
            return Decision(tpo.STATUS_SHADOW_LINKED, numbered[0], REASON_LINKED_NUMBER_TIEBREAK, sims[numbered[0]], sims, uncompared)
        return Decision(tpo.STATUS_REVIEW, None, REASON_TIE, best, sims, uncompared)
    if best <= thresholds.different_art:
        if uncompared:
            return Decision(tpo.STATUS_REVIEW, None, REASON_UNCOMPARED_CANDIDATES, best, sims, uncompared)
        if product_class in NO_MISSING_CLASSES:
            return Decision(tpo.STATUS_REVIEW, None, REASON_BANNER_CLASS, best, sims, uncompared)
        return Decision(tpo.STATUS_SHADOW_MISSING, None, REASON_MISSING, best, sims, uncompared)
    return Decision(tpo.STATUS_REVIEW, None, REASON_AMBIGUOUS, best, sims, uncompared)


@dataclass
class Resolution:
    product_id: str
    status: str
    card_id: str | None
    proposed_card_id: str | None
    version_label: str
    evidence: dict[str, Any]
    reason: str


def build_resolution(
    row: ReviewRow,
    *,
    candidates: Sequence[str],
    decision: Decision | None,
    product_image_reason: str | None,
    thresholds: Thresholds,
    model_tag: str,
    now: str,
) -> Resolution:
    """The row to write. `decision` is None when the product picture failed the guard."""
    info: dict[str, Any] = {
        "productImageUrl": TCGPLAYER_IMAGE_URL.format(pid=row.product_id),
        "candidateCount": len(candidates),
        "thresholds": thresholds.as_dict(),
        "model": model_tag,
        "at": now,
    }
    if decision is None:
        status, card_id, reason = tpo.STATUS_REVIEW, None, f"product-{product_image_reason}"
    else:
        status, card_id, reason = decision.status, decision.card_id, decision.reason
        top = sorted(decision.similarities.items(), key=lambda kv: (-kv[1], kv[0]))
        info.update({
            "maxCosine": decision.max_cosine,
            "bestCardId": top[0][0] if top else None,
            "top": [{"cardId": cid, "cosine": sim} for cid, sim in top[:5]],
            "comparedCardIds": [cid for cid, _ in top],
            "uncomparedCardIds": decision.uncompared[:20],
        })
    info["decision"] = status
    info["reason"] = reason
    evidence = dict(row.evidence)
    evidence["imageResolution"] = info
    if status != tpo.STATUS_REVIEW:
        evidence["resolvedBy"] = RESOLVED_BY
    game, _ = row.game_language
    version_label = row.version_label
    if status == tpo.STATUS_SHADOW_LINKED and not version_label:
        # A deck/kit reprint's only distinguishing name is its product group.
        version_label = str(row.evidence.get("groupName") or "")
    return Resolution(
        product_id=row.product_id,
        status=status,
        card_id=card_id if status == tpo.STATUS_SHADOW_LINKED else None,
        proposed_card_id=tpo.proposed_card_id(game, row.product_id) if status == tpo.STATUS_SHADOW_MISSING else None,
        version_label=version_label,
        evidence=evidence,
        reason=reason,
    )


def apply_resolutions(connection: sqlite3.Connection, resolutions: Iterable[Resolution], *, now: str | None = None) -> int:
    """Write decisions. The `status = 'review'` guard makes this a no-op for any
    row another process has moved on; the caller commits."""
    now = now or utc_now()
    changed = 0
    for r in resolutions:
        cursor = connection.execute(
            """
            UPDATE tcgplayer_product_classifications
               SET status = ?, card_id = ?, proposed_card_id = ?, version_label = ?,
                   evidence_json = ?, updated_at = ?
             WHERE product_id = ? AND status = ?
            """,
            (
                r.status, r.card_id, r.proposed_card_id, r.version_label or None,
                json.dumps(r.evidence, sort_keys=True, ensure_ascii=False), now,
                r.product_id, tpo.STATUS_REVIEW,
            ),
        )
        changed += cursor.rowcount
    return changed


# --- images ----------------------------------------------------------------


class ImageStore:
    """Disk cache of downloaded pictures keyed by URL, with a persisted
    url -> {md5, w, h, status} ledger so the shared-bytes placeholder guard
    works across nightly batches."""

    def __init__(self, cache_dir: Path, *, concurrency: int = 8, retries: int = 3, timeout: float = 30.0,
                 opener: Callable[[str, float], bytes] | None = None):
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ledger_path = self.dir / "ledger.json"
        self.concurrency = concurrency
        self.retries = retries
        self.timeout = timeout
        self._open = opener or _http_get
        self.missing_recheck_sec = 7 * 86400
        try:
            self.ledger: dict[str, dict[str, Any]] = json.loads(self.ledger_path.read_text())
        except (OSError, ValueError):
            self.ledger = {}

    def path_for(self, url: str) -> Path:
        return self.dir / f"{hashlib.sha1(url.encode()).hexdigest()}.img"

    def _fetch_one(self, url: str) -> dict[str, Any]:
        path = self.path_for(url)
        if not path.exists():
            data, last_error = None, ""
            for attempt in range(self.retries):
                try:
                    data = self._open(url, self.timeout)
                    break
                except HTTPError as exc:
                    last_error = f"http {exc.code}"
                    if exc.code in (403, 404, 410):
                        break
                except (URLError, TimeoutError, OSError) as exc:
                    last_error = type(exc).__name__
                time.sleep(0.5 * (2 ** attempt))
            if not data:
                return {"status": "missing", "error": last_error, "at": time.time()}
            tmp = path.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(path)
        data = path.read_bytes()
        return {"status": "ok", "md5": hashlib.md5(data).hexdigest(), "size": _image_size(data)}

    def _needs_fetch(self, url: str) -> bool:
        entry = self.ledger.get(url) or {}
        if entry.get("status") == "ok":
            return not self.path_for(url).exists()
        # TCGplayer answers 403 for products with no picture (imageCount 0):
        # re-ask weekly, not nightly. Network errors retry every run.
        if entry.get("error") in {"http 403", "http 404", "http 410"}:
            return time.time() - float(entry.get("at") or 0) > self.missing_recheck_sec
        return True

    def fetch(self, urls: Iterable[str], *, log: Callable[[str], None] | None = None) -> None:
        todo = sorted({u for u in urls if u and self._needs_fetch(u)})
        if not todo:
            return
        done = 0
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            for url, entry in zip(todo, pool.map(self._fetch_one, todo)):
                self.ledger[url] = entry
                done += 1
                if log and done % 500 == 0:
                    log(f"[images] {done}/{len(todo)}")
        self.save()

    def save(self) -> None:
        tmp = self.ledger_path.with_suffix(".part")
        tmp.write_text(json.dumps(self.ledger))
        tmp.replace(self.ledger_path)

    def shared_counts(self, *, products: bool | None = None) -> Counter:
        """md5 -> how many URLs serve it; `products` limits the count to
        TCGplayer product pictures (True) or everything else (False)."""
        return Counter(
            e.get("md5") for url, e in self.ledger.items()
            if e.get("status") == "ok" and (products is None or url.startswith(TCGPLAYER_IMAGE_PREFIX) == products)
        )

    def guard(self, url: str, *, shared: Counter | None = None, min_width: int = MIN_IMAGE_WIDTH) -> str | None:
        entry = self.ledger.get(url) or {}
        if entry.get("status") != "ok":
            return image_guard_reason(None, exists=False)
        size = entry.get("size")
        shared = shared if shared is not None else self.shared_counts()
        return image_guard_reason(tuple(size) if size else None, shared_count=shared.get(entry.get("md5"), 1),
                                  min_width=min_width)


def _http_get(url: str, timeout: float) -> bytes:
    with urlopen(Request(url, headers={"User-Agent": BROWSER_UA}), timeout=timeout) as response:
        return response.read()


def _image_size(data: bytes) -> list[int] | None:
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as image:
            return list(image.size)
    except Exception:
        return None


# --- embeddings ------------------------------------------------------------


def _normalize(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    norms = np.linalg.norm(values, axis=-1, keepdims=True)
    norms[norms == 0] = 1.0
    return values / norms


class EmbeddingCache:
    """{key: projected, L2-normalised row}; keys are image URLs (or `card:<id>`
    for rows lifted from a visual index). Dropped when the model tag changes."""

    def __init__(self, path: Path | None, model_tag: str):
        self.path = Path(path) if path else None
        self.model_tag = model_tag
        self.rows: dict[str, np.ndarray] = {}
        if self.path and self.path.exists():
            data = np.load(self.path, allow_pickle=False)
            if str(data["model_tag"]) == model_tag:
                # Read the matrix once: each data[...] access re-decodes the array.
                matrix = np.array(data["embeddings"], dtype=np.float32)
                self.rows = {str(k): matrix[i] for i, k in enumerate(data["keys"])}

    def save(self) -> None:
        if not self.path or not self.rows:
            return
        keys = sorted(self.rows)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".part.npz")
        np.savez(tmp, keys=np.array(keys), embeddings=np.stack([self.rows[k] for k in keys]).astype(np.float32),
                 model_tag=np.array(self.model_tag))
        tmp.replace(self.path)


class ScannerEmbedder:
    """The scanner's whole-card pipeline: ONNX fp32 SigLIP2, no crop, active
    projection adapter, L2-normalise. Heavy imports are lazy."""

    def __init__(self, *, adapter_path: Path, model_id: str = "google/siglip2-base-patch16-384", batch_size: int = 32):
        from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy

        self._project = project_embeddings_numpy
        self.encoder = RawVisualFrozenEncoder(model_id=model_id, device="cpu", backend="onnx", precision="fp32")
        self.adapter = load_projection_adapter(Path(adapter_path), embedding_dim=768, device=self.encoder.device)
        self.batch_size = batch_size
        self.tag = model_tag(adapter_path, model_id)

    def __call__(self, paths: Sequence[Path]) -> np.ndarray:
        from PIL import Image

        images = []
        for path in paths:
            with Image.open(path) as image:
                images.append(image.convert("RGB"))
        raw = self.encoder.embed_images(images, batch_size=self.batch_size)
        return _normalize(self._project(self.adapter, raw, device=self.encoder.device, batch_size=256))


def model_tag(adapter_path: Path, model_id: str = "google/siglip2-base-patch16-384") -> str:
    path = Path(adapter_path)
    return f"{model_id}|onnx-fp32|{path.name}:{path.stat().st_size}"


def load_index_card_vectors(index_pairs: Iterable[tuple[Path, Path]]) -> dict[str, np.ndarray]:
    """{card_id: row} from scanner visual indexes (npz, manifest), base rows only
    (TCGplayer alt-art rows are other products' pictures)."""
    vectors: dict[str, np.ndarray] = {}
    for npz_path, manifest_path in index_pairs:
        manifest = json.loads(Path(manifest_path).read_text())
        matrix = np.load(npz_path)["embeddings"]
        entries = manifest.get("entries") or []
        if len(entries) != matrix.shape[0]:
            raise ValueError(f"row mismatch {npz_path}: {matrix.shape[0]} vs {len(entries)}")
        for i, entry in enumerate(entries):
            if entry.get("referenceSource"):
                continue
            card_id = str(entry.get("providerCardId") or "")
            if card_id and card_id not in vectors:
                vectors[card_id] = _normalize(matrix[i])
    return vectors


def embed_urls(
    urls: Sequence[str],
    *,
    store: ImageStore,
    cache: EmbeddingCache,
    embedder: Callable[[Sequence[Path]], np.ndarray] | None,
    chunk: int = 64,
    log: Callable[[str], None] | None = None,
) -> None:
    todo = [u for u in dict.fromkeys(urls) if u not in cache.rows]
    if not todo:
        return
    if embedder is None:
        raise RuntimeError(f"{len(todo)} images need embedding but no embedder was given")
    for start in range(0, len(todo), chunk):
        batch = todo[start : start + chunk]
        vectors = embedder([store.path_for(u) for u in batch])
        for url, vector in zip(batch, vectors):
            cache.rows[url] = vector
        if log:
            log(f"[embed] {min(start + chunk, len(todo))}/{len(todo)}")
        if (start // chunk) % 20 == 19:
            cache.save()
    cache.save()


# --- orchestration ----------------------------------------------------------


def load_placeholder_card_ids(path: Path | None) -> set[str]:
    if not path:
        return set()
    try:
        return {str(c) for c in json.loads(Path(path).read_text()).get("cardIds") or []}
    except (OSError, ValueError, AttributeError):
        return set()


@dataclass
class RunResult:
    resolutions: list[Resolution]
    counts: dict[str, dict[str, int]]
    written: int
    timings: dict[str, float]


def resolve_review(
    connection: sqlite3.Connection,
    *,
    store: ImageStore,
    cache: EmbeddingCache,
    embedder: Callable[[Sequence[Path]], np.ndarray] | None,
    index_vectors: Mapping[str, np.ndarray] | None = None,
    placeholder_card_ids: set[str] | None = None,
    thresholds: Thresholds = Thresholds(),
    product_ids: Iterable[str] | None = None,
    min_width: int = MIN_IMAGE_WIDTH,
    dry_run: bool = False,
    log: Callable[[str], None] | None = None,
) -> RunResult:
    """Resolve every row still in `review` (optionally only `product_ids`).
    Network: product + candidate pictures not already cached or in an index."""
    log = log or (lambda message: print(message, file=sys.stderr, flush=True))
    timings: dict[str, float] = {}
    t0 = time.time()
    rows = load_review_rows(connection, product_ids)
    index = tpo.load_catalog_index(connection)
    candidates = {row.product_id: review_candidates(row, index) for row in rows}
    all_cards = sorted({cid for ids in candidates.values() for cid in ids})
    card_meta: dict[str, tuple[str, str]] = {}
    for start in range(0, len(all_cards), 900):
        chunk = all_cards[start : start + 900]
        for card_id, image_url, number in connection.execute(
            f"SELECT id, image_url, number FROM cards WHERE id IN ({','.join('?' * len(chunk))})", chunk
        ):
            card_meta[str(card_id)] = (str(image_url or ""), str(number or ""))
    timings["candidatesSec"] = round(time.time() - t0, 1)
    log(f"[resolve] {len(rows)} review rows, {len(all_cards)} candidate cards")

    index_vectors = index_vectors or {}
    placeholder_card_ids = placeholder_card_ids or set()
    card_vectors: dict[str, np.ndarray | None] = {}
    card_urls: dict[str, str] = {}
    for card_id in all_cards:
        if card_id in placeholder_card_ids:
            card_vectors[card_id] = None
        elif card_id in index_vectors:
            card_vectors[card_id] = index_vectors[card_id]
        elif card_meta.get(card_id, ("", ""))[0]:
            card_urls[card_id] = card_meta[card_id][0]
        else:
            card_vectors[card_id] = None
    product_urls = {row.product_id: TCGPLAYER_IMAGE_URL.format(pid=row.product_id) for row in rows}

    t1 = time.time()
    store.fetch([*product_urls.values(), *(u for cid, u in card_urls.items() if u not in cache.rows)], log=log)
    timings["downloadSec"] = round(time.time() - t1, 1)
    shared = store.shared_counts(products=True)
    product_reason = {pid: store.guard(url, shared=shared, min_width=min_width) for pid, url in product_urls.items()}
    shared = store.shared_counts(products=False)
    for card_id, url in card_urls.items():
        if url in cache.rows:
            continue
        # Scrydex reference pictures: only missing/placeholder/landscape disqualify.
        reason = store.guard(url, shared=shared, min_width=1)
        if reason:
            card_vectors[card_id] = None
    t2 = time.time()
    to_embed = [url for pid, url in product_urls.items() if product_reason[pid] in EMBEDDABLE_PRODUCT_REASONS]
    to_embed += [url for cid, url in card_urls.items() if cid not in card_vectors]
    embed_urls(to_embed, store=store, cache=cache, embedder=embedder, log=log)
    timings["embedSec"] = round(time.time() - t2, 1)
    for card_id, url in card_urls.items():
        if card_id not in card_vectors:
            card_vectors[card_id] = cache.rows.get(url)

    now = utc_now()
    resolutions = []
    for row in rows:
        cands = candidates[row.product_id]
        reason = product_reason[row.product_id]
        decision = None
        if reason in EMBEDDABLE_PRODUCT_REASONS:
            decision = decide(
                cache.rows[product_urls[row.product_id]],
                {cid: card_vectors.get(cid) for cid in cands},
                thresholds=thresholds,
                product_number=row.number,
                product_class=str(row.evidence.get("class") or ""),
                candidate_numbers={cid: card_meta.get(cid, ("", ""))[1] for cid in cands},
            )
            if reason and decision.status != tpo.STATUS_SHADOW_LINKED:
                # A small picture can still prove a match, but blur drags the
                # cosine down, so it never proves a picture is different.
                decision = Decision(tpo.STATUS_REVIEW, None, f"product-{reason}", decision.max_cosine,
                                    decision.similarities, decision.uncompared)
            reason = None
        resolutions.append(build_resolution(row, candidates=cands, decision=decision, product_image_reason=reason,
                                            thresholds=thresholds, model_tag=cache.model_tag, now=now))
    counts: dict[str, Counter] = defaultdict(Counter)
    for row, res in zip(rows, resolutions):
        counts[row.game_key][res.status if res.status != tpo.STATUS_REVIEW else f"review:{res.reason}"] += 1
    written = 0 if dry_run else apply_resolutions(connection, resolutions, now=now)
    timings["totalSec"] = round(time.time() - t0, 1)
    return RunResult(resolutions, {g: dict(c) for g, c in counts.items()}, written, timings)
