#!/usr/bin/env python3
"""Build the art-crop sidecar for a per-game scanner visual index.

When a card has several index rows (its Scrydex base row plus TCGplayer
alt-art rows), the whole-card embedding picks the card reliably but not always
the right ARTWORK version. The matcher re-ranks those version rows by comparing
an embedding of the artwork region only. This tool writes the reference side
of that comparison:

    visual_index_active_<game>_artcrop.npz   (sibling of the index npz)
      rows                    int32  [N]      index row numbers (npz row order)
      embeddings              float16 [N,768] L2-normalised, adapter-projected
      region                  float32 [4]     (x0, y0, x1, y1) fractions
      adapter                 0-d str         adapter artifactVersion
      index_artifact_version  0-d str         manifest artifactVersion

Only rows of cards with >= 2 rows in the index are included. Each reference
image is prepared as: TCGplayer product image trimmed to the card edge (white
margin removed; Scrydex images are already edge-to-edge), resized to 630x880,
cropped to the game's region, embedded with the frozen encoder (ONNX fp32) and
the projection adapter, L2-normalised.

Standalone (re)build for an existing index, e.g. after a nightly append:

    backend/.venv/bin/python tools/build_visual_artcrop_index.py \\
        --game onepiece --index-dir out/onepiece \\
        --images-dir img/ \\
        --adapter backend/data/visual-models/raw_visual_adapter_siglip2-384-v003-candidate.pt

``build_tcgplayer_altart_index.py`` calls this automatically (``--emit-artcrop``).
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"

# Artwork box per game as fractions of a 630x880 card (validated 2026-09-28, "R2").
ARTCROP_REGIONS: dict[str, tuple[float, float, float, float]] = {
    "onepiece": (0.10, 0.07, 0.90, 0.38),
    "gundam": (0.15, 0.10, 0.90, 0.40),
}
CANVAS_SIZE = (630, 880)
EMBEDDING_DIM = 768
TCGPLAYER_SOURCE = "tcgplayer"
DEFAULT_SCRYDEX_CACHE = BACKEND_ROOT / "data" / "visual-index" / ".cache" / "artcrop_reference_images"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def artcrop_path_for(index_dir: Path, game: str) -> Path:
    return Path(index_dir) / f"visual_index_active_{game}_artcrop.npz"


def entry_source(entry: dict[str, Any]) -> str:
    return str(entry.get("referenceSource") or "scrydex")


def multi_version_rows(entries: Sequence[dict[str, Any]]) -> list[int]:
    """Row numbers (npz order) of every row whose card has >= 2 rows."""
    counts = Counter(str(e.get("providerCardId")) for e in entries)
    return [i for i, e in enumerate(entries) if counts[str(e.get("providerCardId"))] >= 2]


def reference_key(entry: dict[str, Any]) -> str:
    if entry_source(entry) == TCGPLAYER_SOURCE:
        return f"tcgplayer:{entry.get('tcgplayerProductId')}"
    return f"scrydex:{entry.get('providerCardId')}"


# --- image preparation (mirrors the validated experiment exactly) ---


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


def prepare_reference(image: Any, source: str) -> Any:
    from PIL import Image

    image = flatten_to_rgb(image)
    if source == TCGPLAYER_SOURCE:
        image = trim_to_card_edge(image)
    return image.resize(CANVAS_SIZE, Image.LANCZOS)


def crop_region(image: Any, region: Sequence[float]) -> Any:
    width, height = image.size
    return image.crop((int(region[0] * width), int(region[1] * height), int(region[2] * width), int(region[3] * height)))


# --- sidecar assembly ---


def build_artcrop_payload(
    *,
    rows: Sequence[int],
    embeddings: np.ndarray,
    region: Sequence[float],
    adapter_version: str,
    index_artifact_version: str,
) -> dict[str, np.ndarray]:
    vectors = np.asarray(embeddings, dtype=np.float32).reshape(len(rows), -1)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return {
        "rows": np.asarray(rows, dtype=np.int32),
        "embeddings": (vectors / norms).astype(np.float16),
        "region": np.asarray(region, dtype=np.float32),
        "adapter": np.array(str(adapter_version)),
        "index_artifact_version": np.array(str(index_artifact_version)),
    }


def compute_artcrop(
    *,
    entries: Sequence[dict[str, Any]],
    region: Sequence[float],
    load_image: Callable[[dict[str, Any]], Any | None],
    embed_crops: Callable[[list[str], list[Any]], np.ndarray],
) -> tuple[list[int], np.ndarray, list[int]]:
    """Returns (rows, embeddings, rows_missing_an_image).

    ``embed_crops(keys, crops)`` gets one reference key per crop (for caching).
    Rows sharing a reference key (same product image) are embedded once.
    """
    wanted = multi_version_rows(entries)
    rows: list[int] = []
    missing: list[int] = []
    key_for_row: dict[int, str] = {}
    crops_by_key: dict[str, Any] = {}
    for row in wanted:
        entry = entries[row]
        key = reference_key(entry)
        if key not in crops_by_key:
            image = load_image(entry)
            if image is None:
                missing.append(row)
                continue
            crops_by_key[key] = crop_region(prepare_reference(image, entry_source(entry)), region)
        key_for_row[row] = key
        rows.append(row)
    keys = list(crops_by_key)
    vectors = embed_crops(keys, [crops_by_key[k] for k in keys]) if keys else np.zeros((0, EMBEDDING_DIM), np.float32)
    by_key = {k: vectors[i] for i, k in enumerate(keys)}
    matrix = np.stack([by_key[key_for_row[r]] for r in rows]) if rows else np.zeros((0, EMBEDDING_DIM), np.float32)
    return rows, matrix, missing


def write_artcrop(path: Path, payload: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp.npz")
    np.savez(tmp, **payload)
    tmp.replace(path)


def adapter_artifact_version(adapter_path: Path, metadata_path: Path | None = None) -> str:
    """artifactVersion from ``<adapter stem>_metadata.json`` (or an explicit file)."""
    path = metadata_path or adapter_path.with_name(f"{adapter_path.stem}_metadata.json")
    if not path.exists():
        raise SystemExit(f"Adapter metadata not found: {path} (pass --adapter-metadata)")
    version = json.loads(path.read_text()).get("artifactVersion")
    if not version:
        raise SystemExit(f"No artifactVersion in {path}")
    return str(version)


# --- reference images ---


class ReferenceImages:
    """TCGplayer rows: ``<images-dir>/<pid>.jpg``. Scrydex rows: entry imageUrl,
    downloaded once into ``<scrydex-cache>/<game>/<providerCardId>.img``."""

    def __init__(self, *, game: str, images_dirs: Sequence[Path], scrydex_cache: Path, download: bool = True):
        self.images_dirs = [Path(d) for d in images_dirs]
        self.scrydex_dir = Path(scrydex_cache) / game
        self.download = download

    def scrydex_path(self, entry: dict[str, Any]) -> Path:
        return self.scrydex_dir / f"{entry.get('providerCardId')}.img"

    def _fetch(self, url: str, dest: Path) -> bool:
        from urllib.request import Request, urlopen

        from PIL import Image

        try:
            with urlopen(Request(url, headers={"User-Agent": BROWSER_UA}), timeout=30) as response:
                data = response.read()
            Image.open(io.BytesIO(data)).convert("RGB")
        except Exception as exc:
            print(f"[artcrop] download failed {url}: {exc}", flush=True)
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return True

    def __call__(self, entry: dict[str, Any]) -> Any | None:
        from PIL import Image

        if entry_source(entry) == TCGPLAYER_SOURCE:
            pid = entry.get("tcgplayerProductId")
            path = next((d / f"{pid}.jpg" for d in self.images_dirs if (d / f"{pid}.jpg").exists()), None)
        else:
            path = self.scrydex_path(entry)
            url = entry.get("imageUrl")
            if not path.exists() and not (self.download and url and self._fetch(str(url), path)):
                path = None
        if path is None:
            return None
        try:
            image = Image.open(path)
            image.load()
            return image
        except Exception as exc:
            print(f"[artcrop] unreadable {path}: {exc}", flush=True)
            return None


# --- embedding (lazy heavy imports) ---


class ArtCropEmbedder:
    """Frozen encoder + adapter; an optional .npz cache keyed by reference key."""

    def __init__(
        self,
        *,
        model_id: str,
        adapter_path: Path,
        region: Sequence[float],
        batch_size: int = 16,
        cache_path: Path | None = None,
        encoder: Any = None,
        adapter: Any = None,
    ):
        if str(BACKEND_ROOT) not in sys.path:
            sys.path.insert(0, str(BACKEND_ROOT))
        from raw_visual_model import RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy

        self._project = project_embeddings_numpy
        self.encoder = encoder or RawVisualFrozenEncoder(model_id=model_id, device="cpu", backend="onnx")
        self.adapter = adapter or load_projection_adapter(adapter_path, embedding_dim=EMBEDDING_DIM, device=self.encoder.device)
        self.batch_size = batch_size
        self.cache_path = cache_path
        region_tag = ",".join(f"{v:.4f}" for v in region)
        self.tag = f"{adapter_path.name}:{adapter_path.stat().st_size}:{model_id}:{CANVAS_SIZE}:{region_tag}"
        self.cache: dict[str, np.ndarray] = {}
        if cache_path and cache_path.exists():
            data = np.load(cache_path, allow_pickle=False)
            if str(data["tag"]) == self.tag:
                self.cache = {str(k): data["embeddings"][i] for i, k in enumerate(data["keys"])}
                print(f"[artcrop] cache hit {len(self.cache)} crops from {cache_path}", flush=True)

    def __call__(self, keys: list[str], crops: list[Any]) -> np.ndarray:
        todo = [i for i, k in enumerate(keys) if k not in self.cache]
        print(f"[artcrop] {len(keys)} reference crops, {len(todo)} to embed", flush=True)
        chunk = 64
        for start in range(0, len(todo), chunk):
            idx = todo[start : start + chunk]
            raw = self.encoder.embed_images([crops[i] for i in idx], batch_size=self.batch_size).astype(np.float32)
            projected = self._project(self.adapter, raw, device=self.encoder.device)
            projected = projected / np.linalg.norm(projected, axis=1, keepdims=True)
            for i, vector in zip(idx, projected):
                self.cache[keys[i]] = vector.astype(np.float32)
            print(f"[artcrop] {min(start + chunk, len(todo))}/{len(todo)}", flush=True)
        if todo and self.cache_path:
            names = sorted(self.cache)
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            np.savez(self.cache_path, keys=np.array(names), embeddings=np.stack([self.cache[k] for k in names]), tag=np.array(self.tag))
        return np.stack([self.cache[k] for k in keys])


def emit_artcrop(
    *,
    game: str,
    manifest: dict[str, Any],
    out_path: Path,
    region: Sequence[float] | None,
    adapter_version: str,
    load_image: Callable[[dict[str, Any]], Any | None],
    embed_crops: Callable[[list[str], list[Any]], np.ndarray],
    allow_missing: bool = False,
) -> dict[str, Any]:
    """Writes (or, when the index has no multi-version cards, removes) the sidecar."""
    entries = [e for e in manifest.get("entries", []) if isinstance(e, dict)]
    for i, entry in enumerate(entries):
        if int(entry.get("rowIndex", i)) != i:
            raise SystemExit(f"Manifest rowIndex {entry.get('rowIndex')} at position {i}: rows must be in npz order")
    index_version = str(manifest.get("artifactVersion") or "")
    if not multi_version_rows(entries):
        if out_path.exists():
            out_path.unlink()
            print(f"[artcrop] removed stale {out_path}", flush=True)
        print(f"[artcrop] {game}: no card has >= 2 rows; no art-crop file", flush=True)
        return {"game": game, "artRows": 0, "path": None}
    region = region or ARTCROP_REGIONS.get(game)
    if region is None:
        raise SystemExit(f"No art-crop region for game {game!r}; pass --artcrop-region x0,y0,x1,y1")
    rows, vectors, missing = compute_artcrop(entries=entries, region=region, load_image=load_image, embed_crops=embed_crops)
    if missing:
        detail = ", ".join(f"{m}:{reference_key(entries[m])}" for m in missing[:10])
        if not allow_missing:
            raise SystemExit(f"[artcrop] {len(missing)} rows have no reference image ({detail}); fix or pass --allow-missing-images")
        print(f"[artcrop] WARNING {len(missing)} rows omitted (no image): {detail}", flush=True)
    payload = build_artcrop_payload(
        rows=rows, embeddings=vectors, region=region, adapter_version=adapter_version, index_artifact_version=index_version
    )
    write_artcrop(out_path, payload)
    summary = {
        "game": game,
        "path": str(out_path),
        "artRows": len(rows),
        "artCards": len({entries[r].get("providerCardId") for r in rows}),
        "missingRows": len(missing),
        "region": list(map(float, region)),
        "adapter": adapter_version,
        "indexArtifactVersion": index_version,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    print(f"[artcrop] wrote {out_path} ({len(rows)} rows, {summary['artCards']} cards)", flush=True)
    return summary


def parse_region(text: str | None) -> tuple[float, float, float, float] | None:
    if not text:
        return None
    values = tuple(float(v) for v in text.split(","))
    if len(values) != 4 or not (0 <= values[0] < values[2] <= 1 and 0 <= values[1] < values[3] <= 1):
        raise argparse.ArgumentTypeError(f"bad region {text!r}")
    return values  # type: ignore[return-value]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", required=True)
    parser.add_argument("--index-dir", type=Path, required=True, help="Folder holding visual_index_active_<game>_manifest.json.")
    parser.add_argument("--images-dir", type=Path, action="append", default=[], help="TCGplayer product images (<pid>.jpg); repeatable.")
    parser.add_argument("--scrydex-image-cache", type=Path, default=DEFAULT_SCRYDEX_CACHE)
    parser.add_argument("--no-download", action="store_true", help="Never fetch missing Scrydex images.")
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--adapter-metadata", type=Path, default=None)
    parser.add_argument("--model-id", default="google/siglip2-base-patch16-384")
    parser.add_argument("--artcrop-region", type=parse_region, default=None)
    parser.add_argument("--embedding-cache", type=Path, default=None, help="Optional .npz cache of art-crop embeddings.")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--allow-missing-images", action="store_true")
    parser.add_argument("--out", type=Path, default=None, help="Default: sibling of the index.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest_path = args.index_dir / f"visual_index_active_{args.game}_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("modelId") and manifest["modelId"] != args.model_id:
        raise SystemExit(f"Index model {manifest['modelId']} != --model-id {args.model_id}")
    region = args.artcrop_region or ARTCROP_REGIONS.get(args.game)
    summary = emit_artcrop(
        game=args.game,
        manifest=manifest,
        out_path=args.out or artcrop_path_for(args.index_dir, args.game),
        region=region,
        adapter_version=adapter_artifact_version(args.adapter, args.adapter_metadata),
        load_image=ReferenceImages(game=args.game, images_dirs=args.images_dir, scrydex_cache=args.scrydex_image_cache, download=not args.no_download),
        embed_crops=LazyArtCropEmbedder(
            model_id=args.model_id, adapter_path=args.adapter, region=region or (0, 0, 1, 1),
            batch_size=args.batch_size, cache_path=args.embedding_cache,
        ),
        allow_missing=args.allow_missing_images,
    )
    print(json.dumps(summary, indent=2))
    return 0


class LazyArtCropEmbedder:
    """Defers loading the encoder until a crop actually needs embedding."""

    def __init__(self, *, model_id: str, adapter_path: Path, region: Sequence[float], batch_size: int = 16,
                 cache_path: Path | None = None, **shared: Any):
        self.kwargs = dict(model_id=model_id, adapter_path=adapter_path, region=region, batch_size=batch_size,
                           cache_path=cache_path, **shared)
        self._embedder: ArtCropEmbedder | None = None

    def __call__(self, keys: list[str], crops: list[Any]) -> np.ndarray:
        if self._embedder is None:
            self._embedder = ArtCropEmbedder(**self.kwargs)
        return self._embedder(keys, crops)


if __name__ == "__main__":
    raise SystemExit(main())
