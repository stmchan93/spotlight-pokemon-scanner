from __future__ import annotations

import math
import os
from pathlib import Path
from time import perf_counter
from typing import Iterable

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import CLIPModel, CLIPProcessor


DEFAULT_VISUAL_MODEL_ID = "openai/clip-vit-base-patch32"

# Optional letterbox-to-square preprocessing (off by default).
# Measured 2026-05-12 on a 71-fixture held-out subset (base CLIP, no
# adapter): letterbox HURT visual top-10 by 9 fixtures (46.5% -> 33.8%).
# The padding bars cost more effective resolution than the footer-crop
# was saving. Keep this code path available for future experiments
# (e.g. paired with a higher-resolution backbone) but default to OFF.
LETTERBOX_PAD_RGB = (114, 114, 114)


def _should_letterbox() -> bool:
    value = os.environ.get("SPOTLIGHT_VISUAL_LETTERBOX", "0").strip().lower()
    return value in {"1", "true", "on", "yes"}


def letterbox_to_square(image: Image.Image, *, pad_rgb: tuple[int, int, int] = LETTERBOX_PAD_RGB) -> Image.Image:
    width, height = image.size
    if width == height:
        return image
    side = max(width, height)
    canvas = Image.new("RGB", (side, side), pad_rgb)
    offset = ((side - width) // 2, (side - height) // 2)
    canvas.paste(image, offset)
    return canvas


def resolve_torch_device(device_name: str = "auto") -> torch.device:
    normalized = device_name.strip().lower()
    if normalized == "cpu":
        return torch.device("cpu")
    if normalized == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("Requested device 'mps' but torch.backends.mps.is_available() is false.")
        return torch.device("mps")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class RawVisualProjectionAdapter(torch.nn.Module):
    def __init__(self, embedding_dim: int) -> None:
        super().__init__()
        self.embedding_dim = embedding_dim
        self.projection = torch.nn.Linear(embedding_dim, embedding_dim, bias=False)
        self.logit_scale = torch.nn.Parameter(torch.tensor(math.log(1.0 / 0.07), dtype=torch.float32))
        self.reset_parameters()

    def reset_parameters(self) -> None:
        with torch.no_grad():
            self.projection.weight.zero_()
            eye = torch.eye(self.embedding_dim, dtype=self.projection.weight.dtype)
            self.projection.weight.copy_(eye)
            self.logit_scale.fill_(math.log(1.0 / 0.07))

    def forward(self, embeddings: torch.Tensor) -> torch.Tensor:
        projected = self.projection(embeddings)
        return F.normalize(projected, p=2, dim=-1)

    def current_logit_scale(self) -> torch.Tensor:
        return self.logit_scale.exp().clamp(max=100.0)


# Encoder backend selection. The default torch path is unchanged; the optional
# ONNX path (SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx) runs the CLIP image tower
# through onnxruntime on CPU, which is faster than eager torch on few-core hosts
# and produces numerically identical embeddings (validated: cosine 1.000000 on
# the held-out raw suite). See docs/clip-encoder-onnx-quantization-findings-2026-05-26.md.
VALID_ENCODER_BACKENDS = ("torch", "onnx")


def visual_model_slug(model_id: str) -> str:
    slug = model_id.split("/")[-1].strip().lower()
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in slug)


def default_onnx_encoder_path(model_id: str) -> Path:
    backend_root = Path(__file__).resolve().parent
    return backend_root / "data" / "visual-models" / f"{visual_model_slug(model_id)}_vision_fp32.onnx"


def resolve_encoder_backend(backend: str | None) -> str:
    value = (backend or os.environ.get("SPOTLIGHT_VISUAL_ENCODER_BACKEND") or "torch").strip().lower()
    if value not in VALID_ENCODER_BACKENDS:
        raise RuntimeError(f"Unknown visual encoder backend {value!r}; expected one of {VALID_ENCODER_BACKENDS}.")
    return value


def _resolve_onnx_artifact_path(onnx_path: str | Path | None, model_id: str) -> Path:
    if onnx_path is not None:
        return Path(onnx_path)
    env_value = os.environ.get("SPOTLIGHT_VISUAL_ENCODER_ONNX_PATH")
    if env_value and env_value.strip():
        return Path(env_value.strip())
    return default_onnx_encoder_path(model_id)


def _env_int_or_none(name: str) -> int | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        return None


class RawVisualFrozenEncoder:
    def __init__(
        self,
        *,
        model_id: str = DEFAULT_VISUAL_MODEL_ID,
        device: str = "auto",
        backend: str | None = None,
        onnx_path: str | Path | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = resolve_torch_device(device)
        self.processor = CLIPProcessor.from_pretrained(model_id, use_fast=False)
        self.backend = resolve_encoder_backend(backend)
        self.model = None
        self._onnx_session = None
        self._onnx_input_name = None
        self._onnx_path: str | None = None
        if self.backend == "onnx":
            self._init_onnx_backend(onnx_path)
        else:
            self._init_torch_backend()

    def _init_torch_backend(self) -> None:
        self.model = CLIPModel.from_pretrained(self.model_id).to(self.device)
        self.model.eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        projection_dim = getattr(self.model.config, "projection_dim", None)
        if not isinstance(projection_dim, int) or projection_dim <= 0:
            raise RuntimeError(f"Unable to determine CLIP projection_dim for model {self.model_id}")
        self.embedding_dim = projection_dim

    def _init_onnx_backend(self, onnx_path: str | Path | None) -> None:
        # The torch CLIP weights are intentionally NOT loaded in this path. Only
        # the lightweight processor + config are needed alongside the ONNX
        # session, which keeps memory down on small hosts.
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError(
                "onnxruntime is required for the ONNX encoder backend "
                "(SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx)."
            ) from exc
        from transformers import CLIPConfig

        resolved = _resolve_onnx_artifact_path(onnx_path, self.model_id)
        if not resolved.exists():
            raise RuntimeError(f"ONNX encoder artifact not found: {resolved}")

        config = CLIPConfig.from_pretrained(self.model_id)
        projection_dim = getattr(config, "projection_dim", None)
        if not isinstance(projection_dim, int) or projection_dim <= 0:
            raise RuntimeError(f"Unable to determine CLIP projection_dim for model {self.model_id}")
        self.embedding_dim = projection_dim

        session_options = ort.SessionOptions()
        intra_op_threads = _env_int_or_none("SPOTLIGHT_VISUAL_ONNX_INTRA_OP_THREADS")
        inter_op_threads = _env_int_or_none("SPOTLIGHT_VISUAL_ONNX_INTER_OP_THREADS")
        if intra_op_threads is not None:
            session_options.intra_op_num_threads = intra_op_threads
        if inter_op_threads is not None:
            session_options.inter_op_num_threads = inter_op_threads

        self._onnx_session = ort.InferenceSession(
            str(resolved), session_options, providers=["CPUExecutionProvider"]
        )
        self._onnx_input_name = self._onnx_session.get_inputs()[0].name
        self._onnx_path = str(resolved)

    def _project_visual_features_if_needed(self, features: torch.Tensor) -> torch.Tensor:
        if features.shape[-1] == self.embedding_dim:
            return features

        visual_projection = getattr(self.model, "visual_projection", None)
        if isinstance(visual_projection, torch.nn.Module):
            in_features = getattr(visual_projection, "in_features", None)
            out_features = getattr(visual_projection, "out_features", None)
            if (
                isinstance(in_features, int)
                and isinstance(out_features, int)
                and out_features == self.embedding_dim
                and features.shape[-1] == in_features
            ):
                return visual_projection(features)

        return features

    def _coerce_image_features(self, features: object) -> torch.Tensor:
        if isinstance(features, torch.Tensor):
            return self._project_visual_features_if_needed(features)

        image_embeds = getattr(features, "image_embeds", None)
        if isinstance(image_embeds, torch.Tensor):
            return self._project_visual_features_if_needed(image_embeds)

        pooler_output = getattr(features, "pooler_output", None)
        if isinstance(pooler_output, torch.Tensor):
            return self._project_visual_features_if_needed(pooler_output)

        last_hidden_state = getattr(features, "last_hidden_state", None)
        if isinstance(last_hidden_state, torch.Tensor) and last_hidden_state.ndim >= 2:
            pooled = last_hidden_state[:, 0]
            return self._project_visual_features_if_needed(pooled)

        if isinstance(features, (tuple, list)) and features:
            for item in features:
                if isinstance(item, torch.Tensor):
                    return self._project_visual_features_if_needed(item)

        raise RuntimeError(
            f"Unsupported CLIP image feature output type: {type(features).__name__}"
        )

    def _embed_batch_with_timing(self, images: list[Image.Image]) -> tuple[np.ndarray, dict[str, float]]:
        if self.backend == "onnx":
            return self._embed_batch_with_timing_onnx(images)

        preprocess_started_at = perf_counter()
        if _should_letterbox():
            images = [letterbox_to_square(image) for image in images]
        inputs = self.processor(images=images, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        preprocess_ms = (perf_counter() - preprocess_started_at) * 1000.0

        forward_started_at = perf_counter()
        with torch.inference_mode():
            features = self.model.get_image_features(**inputs)
            features = self._coerce_image_features(features)
            features = F.normalize(features, p=2, dim=-1)
        model_forward_ms = (perf_counter() - forward_started_at) * 1000.0

        postprocess_started_at = perf_counter()
        result = features.detach().cpu().numpy().astype(np.float32)
        postprocess_ms = (perf_counter() - postprocess_started_at) * 1000.0

        return result, {
            "preprocessMs": round(preprocess_ms, 3),
            "modelForwardMs": round(model_forward_ms, 3),
            "postprocessMs": round(postprocess_ms, 3),
            "totalMs": round(preprocess_ms + model_forward_ms + postprocess_ms, 3),
        }

    def _embed_batch_with_timing_onnx(self, images: list[Image.Image]) -> tuple[np.ndarray, dict[str, float]]:
        preprocess_started_at = perf_counter()
        if _should_letterbox():
            images = [letterbox_to_square(image) for image in images]
        inputs = self.processor(images=images, return_tensors="np")
        pixel_values = np.asarray(inputs["pixel_values"], dtype=np.float32)
        preprocess_ms = (perf_counter() - preprocess_started_at) * 1000.0

        forward_started_at = perf_counter()
        outputs = self._onnx_session.run(None, {self._onnx_input_name: pixel_values})
        features = np.asarray(outputs[0], dtype=np.float32)
        model_forward_ms = (perf_counter() - forward_started_at) * 1000.0

        postprocess_started_at = perf_counter()
        if features.ndim != 2 or features.shape[-1] != self.embedding_dim:
            raise RuntimeError(
                f"ONNX encoder produced unexpected output shape {features.shape}; "
                f"expected (batch, {self.embedding_dim})."
            )
        # Match the torch path's L2 normalization of image features.
        norms = np.linalg.norm(features, axis=-1, keepdims=True)
        result = np.divide(features, norms, out=np.zeros_like(features), where=norms > 0)
        postprocess_ms = (perf_counter() - postprocess_started_at) * 1000.0

        return result, {
            "preprocessMs": round(preprocess_ms, 3),
            "modelForwardMs": round(model_forward_ms, 3),
            "postprocessMs": round(postprocess_ms, 3),
            "totalMs": round(preprocess_ms + model_forward_ms + postprocess_ms, 3),
        }

    def _embed_batch(self, images: list[Image.Image]) -> np.ndarray:
        embeddings, _ = self._embed_batch_with_timing(images)
        return embeddings

    def _empty_embedding_result(self) -> np.ndarray:
        return np.zeros((0, self.embedding_dim), dtype=np.float32)

    @staticmethod
    def _empty_timing_result() -> dict[str, float]:
        return {
            "preprocessMs": 0.0,
            "modelForwardMs": 0.0,
            "postprocessMs": 0.0,
            "totalMs": 0.0,
        }

    @staticmethod
    def _batch_slices(total_count: int, batch_size: int) -> Iterable[slice]:
        for start in range(0, total_count, batch_size):
            yield slice(start, start + batch_size)

    def embed_image_paths(
        self,
        image_paths: Iterable[Path],
        *,
        batch_size: int = 32,
    ) -> np.ndarray:
        paths = [Path(path).resolve() for path in image_paths]
        if not paths:
            return self._empty_embedding_result()

        outputs: list[np.ndarray] = []
        for batch_slice in self._batch_slices(len(paths), batch_size):
            batch_paths = paths[batch_slice]
            images = [Image.open(path).convert("RGB") for path in batch_paths]
            try:
                outputs.append(self._embed_batch(images))
            finally:
                for image in images:
                    image.close()
        return np.concatenate(outputs, axis=0)

    def embed_images(
        self,
        images: Iterable[Image.Image],
        *,
        batch_size: int = 32,
    ) -> np.ndarray:
        materialized = list(images)
        if not materialized:
            return self._empty_embedding_result()

        outputs: list[np.ndarray] = []
        for batch_slice in self._batch_slices(len(materialized), batch_size):
            batch_images = materialized[batch_slice]
            outputs.append(self._embed_batch(batch_images))
        return np.concatenate(outputs, axis=0)

    def embed_images_with_timing(
        self,
        images: Iterable[Image.Image],
        *,
        batch_size: int = 32,
    ) -> tuple[np.ndarray, dict[str, float]]:
        materialized = list(images)
        if not materialized:
            return self._empty_embedding_result(), self._empty_timing_result()

        outputs: list[np.ndarray] = []
        preprocess_ms = 0.0
        model_forward_ms = 0.0
        postprocess_ms = 0.0
        total_ms = 0.0
        for batch_slice in self._batch_slices(len(materialized), batch_size):
            batch_images = materialized[batch_slice]
            embeddings, timing = self._embed_batch_with_timing(batch_images)
            outputs.append(embeddings)
            preprocess_ms += float(timing.get("preprocessMs") or 0.0)
            model_forward_ms += float(timing.get("modelForwardMs") or 0.0)
            postprocess_ms += float(timing.get("postprocessMs") or 0.0)
            total_ms += float(timing.get("totalMs") or 0.0)
        return np.concatenate(outputs, axis=0), {
            "preprocessMs": round(preprocess_ms, 3),
            "modelForwardMs": round(model_forward_ms, 3),
            "postprocessMs": round(postprocess_ms, 3),
            "totalMs": round(total_ms, 3),
        }


def load_projection_adapter(
    checkpoint_path: Path,
    *,
    embedding_dim: int,
    device: torch.device,
) -> RawVisualProjectionAdapter:
    payload = torch.load(checkpoint_path, map_location=device)
    state_dict = payload.get("adapterStateDict") if isinstance(payload, dict) else None
    if not isinstance(state_dict, dict):
        raise RuntimeError(f"Adapter checkpoint missing adapterStateDict: {checkpoint_path}")
    adapter = RawVisualProjectionAdapter(embedding_dim=embedding_dim).to(device)
    adapter.load_state_dict(state_dict)
    adapter.eval()
    return adapter


def project_embeddings_tensor(
    adapter: RawVisualProjectionAdapter,
    embeddings: torch.Tensor,
    *,
    batch_size: int = 1024,
) -> torch.Tensor:
    adapter.eval()
    outputs: list[torch.Tensor] = []
    with torch.inference_mode():
        for start in range(0, embeddings.shape[0], batch_size):
            chunk = embeddings[start : start + batch_size]
            outputs.append(adapter(chunk))
    return torch.cat(outputs, dim=0) if outputs else embeddings.new_zeros((0, adapter.embedding_dim))


def project_embeddings_numpy(
    adapter: RawVisualProjectionAdapter,
    embeddings: np.ndarray,
    *,
    device: torch.device,
    batch_size: int = 1024,
) -> np.ndarray:
    tensor = torch.from_numpy(np.asarray(embeddings, dtype=np.float32)).to(device)
    projected = project_embeddings_tensor(adapter, tensor, batch_size=batch_size)
    return projected.detach().cpu().numpy().astype(np.float32)
