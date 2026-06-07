#!/usr/bin/env python3
"""Export the SigLIP2 image encoder (get_image_features path) to ONNX.

Sibling of tools/export_clip_onnx.py for the SigLIP2 backbone. Produces the
artifact the ONNX encoder backend consumes — default name
backend/data/visual-models/siglip2-base-patch16-384_vision_fp32.onnx — which is
exactly the path RawVisualFrozenEncoder looks for. The graph emits the 768-d
pre-normalized image embedding, matching the torch get_image_features path so the
prebuilt SigLIP2 index stays valid without a rebuild (runtime L2-normalizes after).

FP32 should be numerically identical to torch (parity cosine ~1.0). INT8 (--int8)
is experimental; do not ship without a symmetric index rebuild + expanded eval.

Run with backend/.venv (transformers 5.5.4, matching the VM):
  backend/.venv/bin/python tools/export_siglip_onnx.py
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
    RawVisualFrozenEncoder,
    default_onnx_encoder_path,
    visual_model_slug,
)

DEFAULT_SIGLIP_MODEL_ID = "google/siglip2-base-patch16-384"
PARITY_MIN_COSINE = 0.9999


class SiglipVisionEmbedWrapper(torch.nn.Module):
    """SigLIP image-embed path: the model's get_image_features, returning the bare
    embedding tensor (transformers 5.x may wrap it in a ModelOutput)."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        out = self.model.get_image_features(pixel_values=pixel_values)
        if isinstance(out, torch.Tensor):
            return out
        for attr in ("image_embeds", "pooler_output"):
            value = getattr(out, attr, None)
            if isinstance(value, torch.Tensor):
                return value
        raise RuntimeError("could not extract image embedding from get_image_features output")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parity_image() -> Image.Image:
    fixture_root = REPO_ROOT / "qa" / "raw-footer-layout-check"
    for candidate in sorted(fixture_root.rglob("runtime_normalized.jpg")):
        return Image.open(candidate).convert("RGB")
    return Image.new("RGB", (630, 880), color=(127, 100, 160))


def normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.nan_to_num(vector.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    norm = np.linalg.norm(vector, axis=-1, keepdims=True)
    return np.divide(vector, norm, out=np.zeros_like(vector), where=norm > 0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the SigLIP2 image encoder to ONNX.")
    parser.add_argument("--model-id", default=DEFAULT_SIGLIP_MODEL_ID)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--int8", action="store_true", help="ALSO write an experimental INT8 artifact.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_path = (args.output or default_onnx_encoder_path(args.model_id)).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[export] loading torch encoder {args.model_id} (cpu) ...", flush=True)
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device="cpu", backend="torch")
    wrapper = SiglipVisionEmbedWrapper(encoder.model).eval()

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

    import onnxruntime as ort

    reference = encoder.embed_images([image])[0]
    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    onnx_out = session.run(None, {session.get_inputs()[0].name: dummy.numpy()})[0]
    fp32_cosine = float(np.dot(reference, normalize(onnx_out)[0]))
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
        print(f"[parity] int8 onnx-vs-torch cosine = {int8_cosine:.6f} (EXPERIMENTAL)", flush=True)
        metadata["int8"] = {
            "path": str(int8_path),
            "sizeBytes": int8_path.stat().st_size,
            "sha256": sha256_of(int8_path),
            "parityCosineVsTorch": round(int8_cosine, 8),
            "validated": False,
        }

    metadata_path = output_path.with_suffix(".metadata.json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"[export] wrote metadata {metadata_path}", flush=True)
    print(f"[export] DONE. fp32={output_path.stat().st_size / 1e6:.1f}MB", flush=True)


if __name__ == "__main__":
    main()
