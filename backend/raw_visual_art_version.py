"""Art-crop rules (non-Pokémon only; no-ops without a valid art file).

VERSION rule: pick which version row (base vs a TCGplayer alt-art row) of the
ALREADY-CHOSEN top-1 card the scan is, when the whole-card match can't tell
them apart. It never changes which card is returned or the card ranking.

CARD rerank: when the whole-card top candidates are a near-tie, promote the
candidate whose artwork clearly matches the query's art crop better. Needs an
art file built with ``--all-cards`` (every row covered, plus edge maps for the
same-drawing guard). Never for Pokémon: reprints share art across cards.

The art file is a sibling of the per-game index npz,
``visual_index_active_<game>_artcrop.npz``, holding v003-projected embeddings
of an upper-art crop of each covered reference row:
  rows                   int32 [N]   index row numbers
  embeddings             f16 [N, D]  L2-normalized art-crop embeddings
  region                 f32 [4]     crop box (x0, y0, x1, y1) fractions
  adapter                0-d str     adapter artifactVersion used
  index_artifact_version 0-d str     index manifest artifactVersion built against
Optional (``--all-cards`` builds only):
  coverage               0-d str     "all_cards": every index row is covered
  edge_maps              int8 [N, E] edge-structure map of each row's art crop
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

ART_VERSION_SWITCH_REASON = "art_version_switch"
DEFAULT_ART_VERSION_WINDOW = 0.05
DEFAULT_ART_VERSION_MARGIN = 0.03
ART_CARD_RERANK_REASON = "art_card_rerank"
# Validated 2026-09-29 (weekend benchmark, QA 42, prod non-Pokémon scans,
# synthetic re-captures): fixes near-ties where the art is clearly different.
DEFAULT_ART_RERANK_WINDOW = 0.03
DEFAULT_ART_RERANK_TOP_K = 3
DEFAULT_ART_RERANK_MARGIN = 0.10
# Below this whole-card similarity the scan is junk / another game; art is noise.
DEFAULT_ART_RERANK_MIN_SIMILARITY = 0.45
# Edge-structure correlation at/above which two art crops are the same drawing.
SAME_DRAWING_EDGE_THRESHOLD = 0.25
ART_COVERAGE_ALL_CARDS = "all_cards"
EDGE_MAP_SIZE = (48, 32)  # (width, height) of the edge-structure map
_EDGE_BLUR_SIGMA = 0.75
# The builder crops reference images resized to the normalized card size; the
# query is resized the same way before cropping (validated 2026-09-28).
ART_CROP_CANVAS_SIZE = (630, 880)

LogFn = Callable[..., None]


def art_crop_path_for_index(index_npz_path: Path, game: str) -> Path:
    return Path(index_npz_path).parent / f"visual_index_active_{game}_artcrop.npz"


@dataclass(frozen=True)
class ArtCropIndex:
    path: Path
    embeddings: np.ndarray  # float32, L2-normalized, one row per covered index row
    region: tuple[float, float, float, float]
    position_by_row: dict[int, int]
    # Only cards with >=2 covered version rows can have their version re-chosen.
    rows_by_card: dict[str, list[int]]
    # Every covered row per card (the card rerank's view).
    card_rows: dict[str, list[int]] | None = None
    # int8 edge maps aligned with `embeddings` (kept int8: only two rows are
    # ever compared per scan); set only for an all-cards file, which is what
    # enables the card rerank.
    edge_maps: np.ndarray | None = None

    @property
    def supports_card_rerank(self) -> bool:
        return self.edge_maps is not None and self.card_rows is not None


def load_art_crop_index(
    path: Path,
    *,
    index_artifact_version: str | None,
    adapter_version: str | None,
    entries: list[dict[str, Any]],
    log: LogFn,
    game: str,
) -> ArtCropIndex | None:
    """Load + validate the art file. Any mismatch disables the rule for the game
    (returns None with a warning) — stale rows must never be used."""
    if not path.exists():
        log("WARNING", "visual_art_version_unavailable", game=game, path=str(path), reason="missing_file")
        return None
    try:
        archive = np.load(str(path), allow_pickle=False)
        rows = np.asarray(archive["rows"], dtype=np.int64).reshape(-1)
        embeddings = np.asarray(archive["embeddings"], dtype=np.float32)
        # Round away float32 noise (0.9 -> 0.89999998) so int() crop edges match
        # the builder's/experiment's float64 boxes exactly.
        region = tuple(round(float(value), 6) for value in np.asarray(archive["region"]).reshape(-1))
        file_adapter = str(archive["adapter"].item())
        file_index_version = str(archive["index_artifact_version"].item())
        coverage = str(archive["coverage"].item()) if "coverage" in archive.files else ""
        raw_edges = np.asarray(archive["edge_maps"]) if "edge_maps" in archive.files else None
    except Exception as exc:  # noqa: BLE001 - a bad sidecar must never break scans
        log("WARNING", "visual_art_version_unavailable", game=game, path=str(path), reason="load_failed", error=str(exc))
        return None

    reason = None
    if file_index_version != (index_artifact_version or ""):
        reason = "index_version_mismatch"
    elif file_adapter != (adapter_version or ""):
        reason = "adapter_mismatch"
    elif embeddings.ndim != 2 or embeddings.shape[0] != rows.shape[0]:
        reason = "shape_mismatch"
    elif len(region) != 4 or not (0.0 <= region[0] < region[2] <= 1.0 and 0.0 <= region[1] < region[3] <= 1.0):
        reason = "invalid_region"
    elif rows.size and (rows.min() < 0 or rows.max() >= len(entries)):
        reason = "row_out_of_range"
    if reason is not None:
        log(
            "WARNING",
            "visual_art_version_unavailable",
            game=game,
            path=str(path),
            reason=reason,
            fileIndexArtifactVersion=file_index_version,
            indexArtifactVersion=index_artifact_version,
            fileAdapter=file_adapter,
            adapter=adapter_version,
        )
        return None

    embeddings = np.nan_to_num(embeddings, nan=0.0, posinf=0.0, neginf=0.0)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    position_by_row = {int(row): position for position, row in enumerate(rows.tolist())}
    rows_by_card: dict[str, list[int]] = {}
    for row in position_by_row:
        card_id = str(entries[row].get("providerCardId") or "").strip()
        if card_id:
            rows_by_card.setdefault(card_id, []).append(row)
    card_rows = {card_id: sorted(rows_for_card) for card_id, rows_for_card in rows_by_card.items()}
    rows_by_card = {card_id: rows_for_card for card_id, rows_for_card in card_rows.items() if len(rows_for_card) >= 2}
    edge_maps = None
    if coverage == ART_COVERAGE_ALL_CARDS:
        if raw_edges is not None and raw_edges.ndim == 2 and raw_edges.shape[0] == rows.shape[0]:
            edge_maps = raw_edges.astype(np.int8, copy=False)
        else:
            log("WARNING", "visual_art_rerank_unavailable", game=game, path=str(path), reason="edge_maps_invalid")
    log(
        "INFO",
        "visual_art_version_loaded",
        game=game,
        path=str(path),
        rowCount=int(rows.shape[0]),
        cardCount=len(rows_by_card),
        coveredCardCount=len(card_rows),
        cardRerank=edge_maps is not None,
        region=[round(value, 4) for value in region],
    )
    return ArtCropIndex(
        path=path,
        embeddings=embeddings / norms,
        region=region,  # type: ignore[arg-type]
        position_by_row=position_by_row,
        rows_by_card=rows_by_card,
        card_rows=card_rows if edge_maps is not None else None,
        edge_maps=edge_maps,
    )


def art_crop_query_image(image: Any, region: tuple[float, float, float, float]) -> Any:
    from PIL import Image

    canvas = image.convert("RGB").resize(ART_CROP_CANVAS_SIZE, Image.LANCZOS)
    width, height = canvas.size
    return canvas.crop(
        (int(region[0] * width), int(region[1] * height), int(region[2] * width), int(region[3] * height))
    )


def art_version_candidates(
    winner_row: int,
    adjusted_by_row: dict[int, float],
    *,
    window: float,
) -> list[int] | None:
    """Trigger: the winning row and the card's best OTHER version row are within
    ``window`` on (penalty-adjusted) whole-card similarity. Returns the version
    rows within the window of the winner, best whole-card first, or None."""
    if winner_row not in adjusted_by_row or len(adjusted_by_row) < 2:
        return None
    winner_score = adjusted_by_row[winner_row]
    best_other = max(score for row, score in adjusted_by_row.items() if row != winner_row)
    if winner_score - best_other > window:
        return None
    candidates = [row for row, score in adjusted_by_row.items() if score >= winner_score - window]
    return sorted(candidates, key=lambda row: (row != winner_row, -adjusted_by_row[row]))


def pick_art_version(
    winner_row: int,
    candidates: list[int],
    art_similarity_by_row: dict[int, float],
    *,
    margin: float,
) -> int:
    """Switch only when the art-best row beats the current winner's art
    similarity by at least ``margin``; otherwise keep the whole-card choice."""
    best_row = max(candidates, key=lambda row: art_similarity_by_row[row])
    if best_row != winner_row and art_similarity_by_row[best_row] - art_similarity_by_row[winner_row] >= margin:
        return best_row
    return winner_row


# --- reference preparation (shared by the builder and the incremental append) ---


def card_edge_bbox(image: Any, threshold: int = 245, fraction: float = 0.6) -> tuple[int, int, int, int] | None:
    """Bounding box of rows/columns that are mostly non-white (the card body)."""
    gray = np.asarray(image.convert("L")).astype(int)
    dark = gray < threshold
    rows = np.where(dark.mean(1) > fraction)[0]
    cols = np.where(dark.mean(0) > fraction)[0]
    if not len(rows) or not len(cols):
        return None
    return (int(cols[0]), int(rows[0]), int(cols[-1] + 1), int(rows[-1] + 1))


def trim_to_card_edge(image: Any) -> Any:
    """Drop TCGplayer's white product-shot margin; no-op when the box is implausible."""
    box = card_edge_bbox(image)
    width, height = image.size
    if box and (box[2] - box[0]) > 0.5 * width and (box[3] - box[1]) > 0.5 * height and box != (0, 0, width, height):
        image = image.crop(box)
    return image


def flatten_to_rgb(image: Any) -> Any:
    from PIL import Image

    if image.mode in ("P", "LA", "RGBA"):
        image = image.convert("RGBA")
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        image = background
    return image.convert("RGB")


def reference_is_tcgplayer_image(entry: dict[str, Any]) -> bool:
    """TCGplayer product shots (alt-art rows AND TCGplayer-only cards, whose base
    row points at the TCGplayer CDN) carry a white margin that must be trimmed."""
    if str(entry.get("referenceSource") or "") == "tcgplayer" or str(entry.get("catalogSource") or "") == "tcgplayer":
        return True
    return "tcgplayer-cdn.tcgplayer.com" in str(entry.get("imageUrl") or "")


def prepare_art_reference(image: Any, *, trim_margin: bool) -> Any:
    from PIL import Image

    image = flatten_to_rgb(image)
    if trim_margin:
        image = trim_to_card_edge(image)
    return image.resize(ART_CROP_CANVAS_SIZE, Image.LANCZOS)


def crop_art_region(image: Any, region: tuple[float, float, float, float] | Any) -> Any:
    width, height = image.size
    return image.crop((int(region[0] * width), int(region[1] * height), int(region[2] * width), int(region[3] * height)))


# --- same-drawing guard ---


def _gaussian_blur(values: np.ndarray, sigma: float) -> np.ndarray:
    radius = max(1, int(round(3 * sigma)))
    taps = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    taps /= taps.sum()
    padded = np.pad(values, radius, mode="reflect")
    rows = np.apply_along_axis(lambda line: np.convolve(line, taps, mode="valid"), 1, padded)
    return np.apply_along_axis(lambda line: np.convolve(line, taps, mode="valid"), 0, rows)


def edge_structure_map(art_crop: Any) -> np.ndarray:
    """int8 map of where the drawing's edges are (grey gradient magnitude,
    lightly blurred, standardized). Two crops of the same drawing correlate
    >= 0.25 (98% of validated pairs) across frame/foil/colour changes; different
    drawings rarely do (5%)."""
    from PIL import Image

    gray = np.asarray(art_crop.convert("L").resize(EDGE_MAP_SIZE, Image.BILINEAR), dtype=np.float32)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1] = gray[2:] - gray[:-2]
    magnitude = _gaussian_blur(np.hypot(gx, gy), _EDGE_BLUR_SIGMA)
    magnitude = (magnitude - magnitude.mean()) / (magnitude.std() + 1e-6)
    peak = float(np.abs(magnitude).max()) or 1.0
    return np.round(magnitude.ravel() * (127.0 / peak)).astype(np.int8)


def same_drawing(art_index: ArtCropIndex, row_a: int, row_b: int, *, threshold: float = SAME_DRAWING_EDGE_THRESHOLD) -> bool:
    if art_index.edge_maps is None:
        return False
    a = art_index.edge_maps[art_index.position_by_row[row_a]].astype(np.float32)
    b = art_index.edge_maps[art_index.position_by_row[row_b]].astype(np.float32)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return denominator > 0 and float(a @ b) / denominator >= threshold


# --- card rerank ---


def art_rerank_pool(
    similarities: list[float],
    *,
    window: float,
    top_k: int,
    min_similarity: float,
) -> tuple[list[int] | None, str]:
    """Trigger: a confident-enough scan whose top-1 and top-2 whole-card
    similarities are within ``window``. Returns the match positions (among the
    first ``top_k``) within the window of the top-1, or (None, reason)."""
    if len(similarities) < 2:
        return None, "insufficient_candidates"
    top = similarities[0]
    if top < min_similarity:
        return None, "below_min_similarity"
    if top - similarities[1] > window:
        return None, "outside_window"
    return [i for i, score in enumerate(similarities[: max(2, top_k)]) if top - score <= window], "triggered"


def pick_art_card(art_similarity_by_position: dict[int, float], *, margin: float) -> int:
    """Position 0 stays unless another candidate's art similarity beats it by ``margin``."""
    best = max(art_similarity_by_position, key=lambda position: art_similarity_by_position[position])
    if best != 0 and art_similarity_by_position[best] - art_similarity_by_position[0] >= margin:
        return best
    return 0
