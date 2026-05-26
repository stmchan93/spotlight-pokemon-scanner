#!/usr/bin/env python3
"""Export the CLIP image encoder (vision tower + visual projection) to ONNX.

This produces the artifact consumed by the ONNX encoder backend
(SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx). The graph emits the 512-d projected,
pre-normalized image embedding, matching RawVisualFrozenEncoder's torch path so
the prebuilt visual index stays valid without a rebuild.

FP32 export is numerically identical to torch (validated parity cosine ~1.0).
INT8 (--int8) is EXPERIMENTAL and known to drift rankings on the current
held-out suite; do not ship it without a symmetric index rebuild and an
expanded held-out eval. See docs/clip-encoder-onnx-quantization-findings-2026-05-26.md.

Usage:
  python tools/export_clip_onnx.py
  python tools/export_clip_onnx.py --int8   # experimental, writes *_int8.onnx alongside
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import (  # noqa: E402
    DEFAULT_VISUAL_MODEL_ID,
    RawVisualFrozenEncoder,
    default_onnx_encoder_path,
    visual_model_slug,
)

PARITY_MIN_COSINE = 0.9999


class VisionEmbedWrapper(torch.nn.Module):
    """Canonical CLIP image-embed path for ViT-B/32: vision tower pooled output
    through visual_projection. Mirrors RawVisualFrozenEncoder._coerce_image_features
    + _project_visual_features_if_needed for this architecture."""

    def __init__(self, clip_model: torch.nn.Module) -> None:
        super().__init__()
        self.clip = clip_model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        pooled = self.clip.vision_model(pixel_values=pixel_values).pooler_output
        return self.clip.visual_projection(pooled)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parity_image() -> Image.Image:
    """A real held-out fixture if present, else a synthetic card-shaped image."""
    fixture_root = REPO_ROOT / "qa" / "raw-footer-layout-check"
    for candidate in sorted(fixture_root.rglob("runtime_normalized.jpg")):
        return Image.open(candidate).convert("RGB")
    return Image.new("RGB", (630, 880), color=(127, 100, 160))


def normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.nan_to_num(vector.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    norm = np.linalg.norm(vector, axis=-1, keepdims=True)
    return np.divide(vector, norm, out=np.zeros_like(vector), where=norm > 0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the CLIP image encoder to ONNX.")
    parser.add_argument("--model-id", default=DEFAULT_VISUAL_MODEL_ID)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="FP32 .onnx output path. Defaults to backend/data/visual-models/clip_<slug>_vision_fp32.onnx",
    )
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument(
        "--int8",
        action="store_true",
        help="ALSO write an experimental INT8 dynamic-quantized artifact (NOT validated).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_path = (args.output or default_onnx_encoder_path(args.model_id)).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[export] loading torch encoder {args.model_id} (cpu) ...", flush=True)
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device="cpu", backend="torch")
    wrapper = VisionEmbedWrapper(encoder.model).eval()

    image = parity_image()
    dummy = encoder.processor(images=[image], return_tensors="pt")["pixel_values"]

    print(f"[export] torch.onnx.export -> {output_path}", flush=True)
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (dummy,),
            str(output_path),
            input_names=["pixel_values"],
            output_names=["image_embeds"],
            dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
            opset_version=args.opset,
            dynamo=False,
        )

    # Parity: real encoder pipeline vs the exported ONNX session, on the SAME
    # in-memory image (no JPEG round-trip), isolating the torch-vs-onnx delta.
    import onnxruntime as ort

    reference = encoder.embed_images([image])[0]
    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    onnx_out = session.run(None, {session.get_inputs()[0].name: dummy.numpy()})[0]
    onnx_embedding = normalize(onnx_out)[0]
    fp32_cosine = float(np.dot(reference, onnx_embedding))
    print(f"[parity] fp32 onnx-vs-torch cosine = {fp32_cosine:.6f}", flush=True)
    if fp32_cosine < PARITY_MIN_COSINE:
        raise SystemExit(f"FP32 parity failed: cosine {fp32_cosine:.6f} < {PARITY_MIN_COSINE}")

    metadata = {
        "generatedAt": utc_now_iso(),
        "modelId": args.model_id,
        "modelSlug": visual_model_slug(args.model_id),
        "opset": args.opset,
        "embeddingDim": int(encoder.embedding_dim),
        "fp32": {
            "path": str(output_path),
            "sizeBytes": output_path.stat().st_size,
            "sha256": sha256_of(output_path),
            "parityCosineVsTorch": round(fp32_cosine, 8),
        },
    }

    if args.int8:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        int8_path = output_path.with_name(output_path.stem.replace("_fp32", "") + "_int8.onnx")
        print(f"[export] quantize_dynamic INT8 (EXPERIMENTAL) -> {int8_path}", flush=True)
        quantize_dynamic(str(output_path), str(int8_path), weight_type=QuantType.QInt8)
        int8_session = ort.InferenceSession(str(int8_path), providers=["CPUExecutionProvider"])
        int8_out = int8_session.run(None, {int8_session.get_inputs()[0].name: dummy.numpy()})[0]
        int8_cosine = float(np.dot(reference, normalize(int8_out)[0]))
        print(f"[parity] int8 onnx-vs-torch cosine = {int8_cosine:.6f} (EXPERIMENTAL, drift expected)", flush=True)
        metadata["int8"] = {
            "path": str(int8_path),
            "sizeBytes": int8_path.stat().st_size,
            "sha256": sha256_of(int8_path),
            "parityCosineVsTorch": round(int8_cosine, 8),
            "validated": False,
            "note": "INT8 drifts rankings on the current held-out suite; do not ship without a "
                    "symmetric index rebuild and expanded eval.",
        }

    metadata_path = output_path.with_suffix(".metadata.json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"[export] wrote metadata {metadata_path}", flush=True)
    print(f"[export] DONE. fp32={output_path.stat().st_size / 1e6:.1f}MB", flush=True)


if __name__ == "__main__":
    main()
