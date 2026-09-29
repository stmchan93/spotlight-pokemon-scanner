"""Art-crop VERSION rule: pick which version row (base vs a TCGplayer alt-art
row) of the ALREADY-CHOSEN top-1 card the scan is, when the whole-card match
can't tell them apart.

Scope is deliberately narrow: it never changes which card is returned or the
card ranking, never runs for Pokémon, and is a no-op without the art file.

The art file is a sibling of the per-game index npz,
``visual_index_active_<game>_artcrop.npz``, holding v003-projected embeddings
of an upper-art crop of each covered reference row:
  rows                   int32 [N]   index row numbers
  embeddings             f16 [N, D]  L2-normalized art-crop embeddings
  region                 f32 [4]     crop box (x0, y0, x1, y1) fractions
  adapter                0-d str     adapter artifactVersion used
  index_artifact_version 0-d str     index manifest artifactVersion built against
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

ART_VERSION_SWITCH_REASON = "art_version_switch"
DEFAULT_ART_VERSION_WINDOW = 0.05
DEFAULT_ART_VERSION_MARGIN = 0.03
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
    rows_by_card = {card_id: sorted(card_rows) for card_id, card_rows in rows_by_card.items() if len(card_rows) >= 2}
    log(
        "INFO",
        "visual_art_version_loaded",
        game=game,
        path=str(path),
        rowCount=int(rows.shape[0]),
        cardCount=len(rows_by_card),
        region=[round(value, 4) for value in region],
    )
    return ArtCropIndex(
        path=path,
        embeddings=embeddings / norms,
        region=region,  # type: ignore[arg-type]
        position_by_row=position_by_row,
        rows_by_card=rows_by_card,
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
