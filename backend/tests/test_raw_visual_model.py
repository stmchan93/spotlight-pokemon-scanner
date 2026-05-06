from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import (  # noqa: E402
    RawVisualFrozenEncoder,
    RawVisualProjectionAdapter,
    load_projection_adapter,
    project_embeddings_numpy,
    project_embeddings_tensor,
    resolve_torch_device,
)


class RawVisualModelTests(unittest.TestCase):
    def test_resolve_torch_device_respects_cpu_and_auto_mps(self) -> None:
        self.assertEqual(resolve_torch_device("cpu").type, "cpu")

        with patch("raw_visual_model.torch.backends.mps.is_available", return_value=True):
            self.assertEqual(resolve_torch_device("auto").type, "mps")
            self.assertEqual(resolve_torch_device("mps").type, "mps")

        with patch("raw_visual_model.torch.backends.mps.is_available", return_value=False):
            self.assertEqual(resolve_torch_device("auto").type, "cpu")
            with self.assertRaisesRegex(RuntimeError, "Requested device 'mps'"):
                resolve_torch_device("mps")

    def test_projection_adapter_resets_to_identity_and_normalizes_outputs(self) -> None:
        adapter = RawVisualProjectionAdapter(embedding_dim=3)
        weight = adapter.projection.weight.detach().cpu()
        self.assertTrue(torch.allclose(weight, torch.eye(3)))

        projected = adapter(torch.tensor([[3.0, 0.0, 4.0]], dtype=torch.float32))
        self.assertAlmostEqual(float(torch.linalg.norm(projected, dim=-1)[0].detach()), 1.0, places=5)
        self.assertGreater(float(adapter.current_logit_scale().detach()), 0.0)

    def test_load_projection_adapter_restores_state_dict(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir_str:
            checkpoint_path = Path(tempdir_str) / "adapter.pt"
            adapter = RawVisualProjectionAdapter(embedding_dim=2)
            with torch.no_grad():
                adapter.projection.weight.copy_(torch.tensor([[0.0, 1.0], [1.0, 0.0]], dtype=torch.float32))
            torch.save({"adapterStateDict": adapter.state_dict()}, checkpoint_path)

            loaded = load_projection_adapter(checkpoint_path, embedding_dim=2, device=torch.device("cpu"))

            self.assertTrue(torch.allclose(loaded.projection.weight, adapter.projection.weight))

    def test_project_embeddings_tensor_and_numpy_apply_adapter_in_batches(self) -> None:
        adapter = RawVisualProjectionAdapter(embedding_dim=2)
        embeddings = torch.tensor([[2.0, 0.0], [0.0, 3.0]], dtype=torch.float32)

        projected_tensor = project_embeddings_tensor(adapter, embeddings, batch_size=1)
        self.assertEqual(tuple(projected_tensor.shape), (2, 2))
        self.assertTrue(torch.allclose(torch.linalg.norm(projected_tensor, dim=-1), torch.ones(2)))

        projected_numpy = project_embeddings_numpy(adapter, embeddings.numpy(), device=torch.device("cpu"), batch_size=1)
        self.assertEqual(projected_numpy.shape, (2, 2))
        self.assertTrue(np.allclose(np.linalg.norm(projected_numpy, axis=1), np.ones(2)))

    def test_project_visual_features_uses_visual_projection_when_needed(self) -> None:
        encoder = object.__new__(RawVisualFrozenEncoder)
        encoder.embedding_dim = 2
        linear = torch.nn.Linear(3, 2, bias=False)
        with torch.no_grad():
            linear.weight.copy_(torch.tensor([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=torch.float32))
        encoder.model = types.SimpleNamespace(visual_projection=linear)

        features = torch.tensor([[4.0, 5.0, 6.0]], dtype=torch.float32)
        projected = encoder._project_visual_features_if_needed(features)

        self.assertTrue(torch.equal(projected, torch.tensor([[4.0, 5.0]], dtype=torch.float32)))
        self.assertTrue(torch.equal(
            encoder._project_visual_features_if_needed(torch.tensor([[1.0, 2.0]], dtype=torch.float32)),
            torch.tensor([[1.0, 2.0]], dtype=torch.float32),
        ))

    def test_coerce_image_features_supports_multiple_huggingface_shapes(self) -> None:
        encoder = object.__new__(RawVisualFrozenEncoder)
        encoder.embedding_dim = 2
        encoder.model = types.SimpleNamespace(visual_projection=None)
        encoder._project_visual_features_if_needed = lambda features: features  # type: ignore[method-assign]

        direct = encoder._coerce_image_features(torch.tensor([[1.0, 2.0]], dtype=torch.float32))
        embeds = encoder._coerce_image_features(types.SimpleNamespace(image_embeds=torch.tensor([[3.0, 4.0]], dtype=torch.float32)))
        pooled = encoder._coerce_image_features(types.SimpleNamespace(pooler_output=torch.tensor([[5.0, 6.0]], dtype=torch.float32)))
        hidden = encoder._coerce_image_features(types.SimpleNamespace(last_hidden_state=torch.tensor([[[7.0, 8.0], [0.0, 0.0]]], dtype=torch.float32)))
        tuple_value = encoder._coerce_image_features((torch.tensor([[9.0, 1.0]], dtype=torch.float32),))

        self.assertTrue(torch.equal(direct, torch.tensor([[1.0, 2.0]], dtype=torch.float32)))
        self.assertTrue(torch.equal(embeds, torch.tensor([[3.0, 4.0]], dtype=torch.float32)))
        self.assertTrue(torch.equal(pooled, torch.tensor([[5.0, 6.0]], dtype=torch.float32)))
        self.assertTrue(torch.equal(hidden, torch.tensor([[7.0, 8.0]], dtype=torch.float32)))
        self.assertTrue(torch.equal(tuple_value, torch.tensor([[9.0, 1.0]], dtype=torch.float32)))

        with self.assertRaisesRegex(RuntimeError, "Unsupported CLIP image feature output type"):
            encoder._coerce_image_features(object())

    def test_embed_helpers_cover_empty_and_batched_paths(self) -> None:
        encoder = object.__new__(RawVisualFrozenEncoder)
        encoder.embedding_dim = 3
        encoder._embed_batch = lambda images: np.full((len(images), 3), len(images), dtype=np.float32)  # type: ignore[method-assign]
        encoder._embed_batch_with_timing = lambda images: (  # type: ignore[method-assign]
            np.full((len(images), 3), len(images), dtype=np.float32),
            {
                "preprocessMs": 1.0,
                "modelForwardMs": 2.0,
                "postprocessMs": 3.0,
                "totalMs": 6.0,
            },
        )

        self.assertEqual(encoder.embed_images([], batch_size=2).shape, (0, 3))
        empty_embeddings, empty_timing = encoder.embed_images_with_timing([], batch_size=2)
        self.assertEqual(empty_embeddings.shape, (0, 3))
        self.assertEqual(empty_timing["totalMs"], 0.0)

        images = [Image.new("RGB", (10, 10), color=(index, index, index)) for index in range(3)]
        try:
            embedded = encoder.embed_images(images, batch_size=2)
            timed_embeddings, timing = encoder.embed_images_with_timing(images, batch_size=2)
        finally:
            for image in images:
                image.close()

        self.assertEqual(embedded.shape, (3, 3))
        self.assertEqual(timed_embeddings.shape, (3, 3))
        self.assertEqual(timing["preprocessMs"], 2.0)
        self.assertEqual(timing["modelForwardMs"], 4.0)
        self.assertEqual(timing["postprocessMs"], 6.0)
        self.assertEqual(timing["totalMs"], 12.0)

    def test_embed_image_paths_batches_files(self) -> None:
        encoder = object.__new__(RawVisualFrozenEncoder)
        encoder.embedding_dim = 2
        encoder._embed_batch = lambda images: np.array([[float(index), float(index)] for index, _ in enumerate(images, start=1)], dtype=np.float32)  # type: ignore[method-assign]

        with tempfile.TemporaryDirectory() as tempdir_str:
            tempdir = Path(tempdir_str)
            paths = []
            for index in range(3):
                path = tempdir / f"image-{index}.jpg"
                Image.new("RGB", (4, 4), color=(index, 0, 0)).save(path)
                paths.append(path)

            embedded = encoder.embed_image_paths(paths, batch_size=2)

        self.assertEqual(embedded.shape, (3, 2))
        self.assertTrue(np.allclose(embedded[0], np.array([1.0, 1.0], dtype=np.float32)))


if __name__ == "__main__":
    unittest.main()
