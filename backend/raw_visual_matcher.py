from __future__ import annotations

import base64
import io
import os
from pathlib import Path
from typing import Any

import numpy as np

from raw_visual_index import RawVisualIndex, RawVisualSearchMatch


class RawVisualMatcher:
    def __init__(
        self,
        *,
        repo_root: Path,
        model_id: str | None = None,
        index_npz_path: Path | None = None,
        index_manifest_path: Path | None = None,
    ) -> None:
        self.repo_root = repo_root
        default_root = repo_root / "backend" / "data" / "visual-index"
        self.model_id = model_id or os.environ.get("SPOTLIGHT_VISUAL_MODEL_ID", "openai/clip-vit-base-patch32")
        self.index = RawVisualIndex(
            npz_path=index_npz_path or Path(os.environ.get("SPOTLIGHT_VISUAL_INDEX_NPZ_PATH", default_root / "visual_index_v001_clip-vit-base-patch32.npz")),
            manifest_path=index_manifest_path or Path(os.environ.get("SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH", default_root / "visual_index_v001_manifest.json")),
        )
        self._processor = None
        self._model = None
        self._device = None

    def is_available(self) -> bool:
        return self.index.is_available()

    def _ensure_runtime(self) -> None:
        if self._processor is not None and self._model is not None and self._device is not None:
            return
        try:
            import torch
            from transformers import CLIPModel, CLIPProcessor
        except ImportError as exc:
            raise RuntimeError("Visual matcher dependencies are not installed in the backend environment.") from exc

        if torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
        processor = CLIPProcessor.from_pretrained(self.model_id, use_fast=False)
        model = CLIPModel.from_pretrained(self.model_id).to(device)
        model.eval()

        self._processor = processor
        self._model = model
        self._device = device

    def _load_query_image(self, payload: dict[str, Any]):
        try:
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("Pillow is required for visual query image decoding.") from exc

        normalized_image_base64 = str(payload.get("normalizedImageBase64") or "").strip()
        if normalized_image_base64:
            try:
                raw_bytes = base64.b64decode(normalized_image_base64, validate=True)
            except Exception as exc:
                raise ValueError("normalizedImageBase64 is not valid base64.") from exc
            return Image.open(io.BytesIO(raw_bytes)).convert("RGB")

        normalized_image_path = str(payload.get("normalizedImagePath") or "").strip()
        if normalized_image_path:
            return Image.open(Path(normalized_image_path)).convert("RGB")

        raise ValueError("Payload does not include normalizedImageBase64 or normalizedImagePath.")

    def _image_embedding(self, image) -> np.ndarray:
        self._ensure_runtime()
        assert self._processor is not None
        assert self._model is not None
        assert self._device is not None

        import torch

        inputs = self._processor(images=image, return_tensors="pt")
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        with torch.inference_mode():
            features = self._model.get_image_features(**inputs)
            features = torch.nn.functional.normalize(features, p=2, dim=-1)
        embedding = features[0].detach().cpu().numpy().astype(np.float32)
        embedding = np.nan_to_num(embedding, nan=0.0, posinf=0.0, neginf=0.0)
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return embedding

    def match_payload(self, payload: dict[str, Any], *, top_k: int = 10) -> tuple[list[RawVisualSearchMatch], dict[str, Any]]:
        if not self.is_available():
            raise RuntimeError("Visual index artifacts are not available.")
        image = self._load_query_image(payload)
        embedding = self._image_embedding(image)
        matches = self.index.search(embedding, top_k=top_k)
        debug = {
            "modelId": self.model_id,
            "indexNpzPath": str(self.index.npz_path),
            "indexManifestPath": str(self.index.manifest_path),
            "topK": top_k,
        }
        return matches, debug
