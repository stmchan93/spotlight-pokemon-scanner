from __future__ import annotations

import base64
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import nullcontext
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from PIL import Image  # noqa: E402

import anthropic_adapter  # noqa: E402
import whos_that_share_card  # noqa: E402
from anthropic_adapter import AnthropicResponseError, identify_pokemon_lookalike  # noqa: E402
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler  # noqa: E402


def _tool_use_response(matches: list[dict[str, object]]) -> dict[str, object]:
    return {
        "content": [
            {"type": "text", "text": "Here are the matches!"},
            {
                "type": "tool_use",
                "id": "toolu_test",
                "name": "report_matches",
                "input": {"matches": matches},
            },
        ],
        "stop_reason": "tool_use",
    }


_VALID_MATCHES = [
    {"species": "Pikachu", "pokedexId": 25, "confidence": 0.92, "reason": "Those spark-plug cheeks."},
    {"species": "Snorlax", "pokedexId": 143, "confidence": 0.61, "reason": "Champion-level nap energy."},
    {"species": "Jigglypuff", "pokedexId": 39, "confidence": 0.4, "reason": "Ready to sing uninvited."},
]


class _FakeHTTPResponse:
    def __init__(self, payload: object) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeHTTPResponse":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


def _small_jpeg(width: int = 100, height: int = 120) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (40, 120, 200)).save(buffer, format="JPEG")
    return buffer.getvalue()


def _small_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (64, 64), (255, 60, 60, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


class AnthropicAdapterTests(unittest.TestCase):
    def test_identify_sends_expected_request_and_parses_matches(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(request, timeout=0):  # noqa: ANN001
            captured["request"] = request
            captured["timeout"] = timeout
            return _FakeHTTPResponse(_tool_use_response(_VALID_MATCHES))

        jpeg_bytes = b"fake-jpeg-bytes"
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("anthropic_adapter.urlopen", side_effect=fake_urlopen) as mocked:
                matches = identify_pokemon_lookalike(jpeg_bytes, palette_hints=["#FFCB05", "denim blue"])

        mocked.assert_called_once()
        request = captured["request"]
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(request.full_url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(headers["x-api-key"], "test-key")
        self.assertEqual(headers["anthropic-version"], "2023-06-01")
        self.assertEqual(headers["content-type"], "application/json")

        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["model"], "claude-haiku-4-5")
        self.assertEqual(body["max_tokens"], 700)
        self.assertEqual(body["tool_choice"], {"type": "tool", "name": "report_matches"})
        self.assertEqual(body["tools"][0]["name"], "report_matches")
        content = body["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "image")
        self.assertEqual(content[0]["source"]["media_type"], "image/jpeg")
        self.assertEqual(content[0]["source"]["data"], base64.b64encode(jpeg_bytes).decode("ascii"))
        self.assertEqual(content[1]["type"], "text")
        self.assertIn("#FFCB05", content[1]["text"])

        self.assertEqual(len(matches), 3)
        self.assertEqual(matches[0]["species"], "Pikachu")
        self.assertEqual(matches[0]["pokedexId"], 25)
        self.assertAlmostEqual(matches[0]["confidence"], 0.92)
        self.assertEqual(matches[2]["reason"], "Ready to sing uninvited.")

    def test_downscale_caps_long_edge_and_shrinks_payload(self) -> None:
        big = _small_jpeg(width=4000, height=3000)
        out = anthropic_adapter._downscale_jpeg_for_vision(big)
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(max(image.size), anthropic_adapter._VISION_MAX_EDGE)
            # Aspect ratio preserved (4:3).
            self.assertEqual(image.size, (1024, 768))
        self.assertLess(len(out), len(big))

    def test_downscale_leaves_undecodable_bytes_untouched(self) -> None:
        garbage = b"not-a-real-jpeg"
        self.assertEqual(anthropic_adapter._downscale_jpeg_for_vision(garbage), garbage)

    def test_downscale_transcodes_heic_selfie_to_jpeg(self) -> None:
        # iPhone selfies arrive as HEIC — Anthropic rejects them and stock
        # Pillow can't decode them. With pillow-heif registered, the downscaler
        # must transcode HEIC -> a JPEG that Pillow (and Anthropic) can read.
        try:
            import pillow_heif  # noqa: F401
        except Exception:
            self.skipTest("pillow-heif not installed in this environment")
        buffer = io.BytesIO()
        Image.new("RGB", (2000, 1500), (30, 90, 160)).save(buffer, format="HEIF")
        heic_bytes = buffer.getvalue()
        # Sanity: the raw HEIC is what a JPEG-only decoder would choke on.
        out = anthropic_adapter._downscale_jpeg_for_vision(heic_bytes)
        self.assertNotEqual(out, heic_bytes)
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(max(image.size), anthropic_adapter._VISION_MAX_EDGE)

    def test_downscale_keeps_small_images_within_cap(self) -> None:
        small = _small_jpeg(width=100, height=120)
        out = anthropic_adapter._downscale_jpeg_for_vision(small)
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(image.size, (100, 120))

    def test_identify_clamps_confidence_into_unit_range(self) -> None:
        matches_payload = [dict(match) for match in _VALID_MATCHES]
        matches_payload[0]["confidence"] = 1.7
        matches_payload[1]["confidence"] = -0.3
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch(
                "anthropic_adapter.urlopen",
                return_value=_FakeHTTPResponse(_tool_use_response(matches_payload)),
            ):
                matches = identify_pokemon_lookalike(b"jpeg")
        self.assertEqual(matches[0]["confidence"], 1.0)
        self.assertEqual(matches[1]["confidence"], 0.0)

    def test_identify_raises_on_missing_tool_use_block(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch(
                "anthropic_adapter.urlopen",
                return_value=_FakeHTTPResponse({"content": [{"type": "text", "text": "no tools"}]}),
            ):
                with self.assertRaises(AnthropicResponseError):
                    identify_pokemon_lookalike(b"jpeg")

    def test_identify_raises_on_wrong_match_count(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch(
                "anthropic_adapter.urlopen",
                return_value=_FakeHTTPResponse(_tool_use_response(_VALID_MATCHES[:2])),
            ):
                with self.assertRaises(AnthropicResponseError):
                    identify_pokemon_lookalike(b"jpeg")

    def test_identify_raises_on_out_of_range_pokedex_id(self) -> None:
        matches_payload = [dict(match) for match in _VALID_MATCHES]
        matches_payload[0]["pokedexId"] = 4000
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch(
                "anthropic_adapter.urlopen",
                return_value=_FakeHTTPResponse(_tool_use_response(matches_payload)),
            ):
                with self.assertRaises(AnthropicResponseError):
                    identify_pokemon_lookalike(b"jpeg")

    def test_request_retries_once_on_429_then_succeeds(self) -> None:
        error = HTTPError(
            "https://api.anthropic.com/v1/messages", 429, "rate limited", None, io.BytesIO(b"")
        )
        responses = [error, _FakeHTTPResponse(_tool_use_response(_VALID_MATCHES))]

        def fake_urlopen(request, timeout=0):  # noqa: ANN001
            result = responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("anthropic_adapter.urlopen", side_effect=fake_urlopen) as mocked:
                with patch("anthropic_adapter.time.sleep") as sleeper:
                    matches = identify_pokemon_lookalike(b"jpeg")

        self.assertEqual(mocked.call_count, 2)
        sleeper.assert_called_once()
        self.assertEqual(len(matches), 3)

    def test_request_retries_twice_on_transient_then_succeeds(self) -> None:
        err429 = HTTPError(
            "https://api.anthropic.com/v1/messages", 429, "rate limited", None, io.BytesIO(b"")
        )
        err529 = HTTPError(
            "https://api.anthropic.com/v1/messages", 529, "overloaded", None, io.BytesIO(b"")
        )
        responses = [err429, err529, _FakeHTTPResponse(_tool_use_response(_VALID_MATCHES))]

        def fake_urlopen(request, timeout=0):  # noqa: ANN001
            result = responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("anthropic_adapter.urlopen", side_effect=fake_urlopen) as mocked:
                with patch("anthropic_adapter.time.sleep") as sleeper:
                    matches = identify_pokemon_lookalike(b"jpeg")

        # Two transient failures now recover: 3 attempts total, 2 backoffs.
        self.assertEqual(mocked.call_count, 3)
        self.assertEqual(sleeper.call_count, 2)
        self.assertEqual(len(matches), 3)

    def test_request_does_not_retry_client_errors(self) -> None:
        error = HTTPError(
            "https://api.anthropic.com/v1/messages", 400, "bad request", None, io.BytesIO(b"")
        )
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("anthropic_adapter.urlopen", side_effect=error) as mocked:
                with self.assertRaises(HTTPError):
                    anthropic_adapter.anthropic_messages_request({"model": "claude-haiku-4-5"})
        self.assertEqual(mocked.call_count, 1)

    def test_request_raises_value_error_without_api_key(self) -> None:
        with patch.dict(os.environ):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            with self.assertRaises(ValueError):
                anthropic_adapter.anthropic_messages_request({"model": "claude-haiku-4-5"})


class WhosThatPokemonHandlerTests(unittest.TestCase):
    def _make_handler(self, path: str, payload: dict[str, object]) -> tuple[SpotlightRequestHandler, dict[str, object]]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {"Authorization": "Bearer test"}
        handler.service = Mock()
        handler.service.authenticator.resolve_identity.return_value = RequestIdentity(
            user_id="u-test", email="guest@example.com", auth_source="test"
        )
        handler.service.access_allowed.return_value = True
        handler.service.request_identity_context.return_value = nullcontext()
        handler._read_json_body = lambda: payload  # type: ignore[method-assign]
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, body: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = body

        handler._write_json = write_json  # type: ignore[method-assign]
        return handler, captured

    def test_identify_route_dispatches_to_service(self) -> None:
        payload = {"image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")}}
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon", payload)
        handler.service.identify_pokemon_selfie.return_value = {"matches": _VALID_MATCHES}

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            handler.do_POST()

        handler.service.identify_pokemon_selfie.assert_called_once_with(payload)
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"matches": _VALID_MATCHES})

    def test_identify_route_returns_401_when_identity_fails(self) -> None:
        payload = {"image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")}}
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon", payload)
        handler.service.authenticator.resolve_identity.side_effect = RequestAuthError("bad token")

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            handler.do_POST()

        handler.service.identify_pokemon_selfie.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.UNAUTHORIZED)

    def test_identify_route_returns_503_without_api_key(self) -> None:
        payload = {"image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")}}
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon", payload)

        with patch.dict(os.environ):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            handler.do_POST()

        handler.service.identify_pokemon_selfie.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(captured["payload"], {"error": "feature_unavailable"})

    def test_identify_route_maps_adapter_failure_to_502(self) -> None:
        payload = {"image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")}}
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon", payload)
        handler.service.identify_pokemon_selfie.side_effect = AnthropicResponseError("no tool_use")

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.BAD_GATEWAY)
        self.assertEqual(captured["payload"], {"error": "match_unavailable"})

    def test_identify_route_never_touches_artifact_store(self) -> None:
        # HARD PRIVACY RULE: a successful identify request must never call any
        # artifact-store-ish persistence method.
        payload = {"image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")}}
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon", payload)
        handler.service.identify_pokemon_selfie.return_value = {"matches": _VALID_MATCHES}

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        handler.service.store_scan_artifacts.assert_not_called()
        handler.service.upsert_scan_artifact.assert_not_called()
        handler.service._record_failed_scan_artifact.assert_not_called()

    def test_share_card_route_dispatches_to_service(self) -> None:
        payload = {
            "image": {"jpegBase64": base64.b64encode(b"jpeg").decode("ascii")},
            "species": "Pikachu",
            "pokedexId": 25,
            "reason": "Those spark-plug cheeks.",
            "confidence": 0.92,
        }
        handler, captured = self._make_handler("/api/v1/whos-that-pokemon/share-card", payload)
        handler.service.compose_pokemon_share_card.return_value = {"pngBase64": "cGll"}

        handler.do_POST()

        handler.service.compose_pokemon_share_card.assert_called_once_with(payload)
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"pngBase64": "cGll"})


class ShareCardComposerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.dataset_root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_compose_share_card_renders_png_and_caches_artwork(self) -> None:
        artwork_png = _small_png()

        class _ArtworkResponse:
            def read(self) -> bytes:
                return artwork_png

            def __enter__(self):  # noqa: ANN204
                return self

            def __exit__(self, *args: object) -> bool:
                return False

        with patch("whos_that_share_card.urlopen", return_value=_ArtworkResponse()) as mocked:
            png_bytes = whos_that_share_card.compose_share_card(
                selfie_jpeg=_small_jpeg(),
                species="Pikachu",
                pokedex_id=25,
                reason="Those spark-plug cheeks.",
                confidence=0.92,
                dataset_root=self.dataset_root,
            )

        mocked.assert_called_once()
        request = mocked.call_args.args[0]
        self.assertIn("official-artwork/25.png", request.full_url)

        rendered = Image.open(io.BytesIO(png_bytes))
        self.assertEqual(rendered.size, (1080, 1350))
        self.assertEqual(rendered.format, "PNG")

        cache_path = self.dataset_root / "pokeapi_artwork" / "25.png"
        self.assertTrue(cache_path.exists())
        self.assertEqual(cache_path.read_bytes(), artwork_png)

        # Second compose serves the artwork from the cache: no new fetch.
        with patch("whos_that_share_card.urlopen") as mocked_again:
            whos_that_share_card.compose_share_card(
                selfie_jpeg=_small_jpeg(),
                species="Pikachu",
                pokedex_id=25,
                reason="Still those cheeks.",
                confidence=0.5,
                dataset_root=self.dataset_root,
            )
        mocked_again.assert_not_called()

    def test_service_share_card_returns_png_base64(self) -> None:
        # Route through the real service method (validation + base64 wrapping)
        # against a tmp dataset root; the artwork fetch is stubbed.
        from catalog_tools import apply_schema, connect
        from server import SpotlightScanService

        database_path = self.dataset_root / "share-card.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.commit()
        connection.close()
        with patch.dict(os.environ, {"SPOTLIGHT_DATASET_ROOT": str(self.dataset_root)}):
            with patch(
                "whos_that_share_card.fetch_official_artwork", return_value=_small_png()
            ):
                service = SpotlightScanService(database_path, REPO_ROOT)
                try:
                    payload = service.compose_pokemon_share_card(
                        {
                            "image": {"jpegBase64": base64.b64encode(_small_jpeg()).decode("ascii")},
                            "species": "Snorlax",
                            "pokedexId": 143,
                            "reason": "Champion-level nap energy.",
                            "confidence": 0.61,
                        }
                    )
                finally:
                    service.connection.close()

        rendered = Image.open(io.BytesIO(base64.b64decode(payload["pngBase64"])))
        self.assertEqual(rendered.size, (1080, 1350))


class PersonCutoutTests(unittest.TestCase):
    def _service_with_stubbed_decode(self) -> Mock:
        from server import SpotlightScanService

        fake = Mock()
        fake._decode_scan_image_payload.return_value = (_small_jpeg(), 100, 120)
        fake._emit_structured_log = Mock()
        fake_method = SpotlightScanService.identify_pokemon_selfie
        return fake, fake_method

    def test_identify_response_includes_cutout_when_available(self) -> None:
        fake, method = self._service_with_stubbed_decode()
        cutout = _small_png()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout_png", return_value=cutout):
                payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertEqual(payload["matches"], _VALID_MATCHES)
        self.assertEqual(base64.b64decode(payload["personCutoutPngBase64"]), cutout)

    def test_identify_response_omits_cutout_when_unavailable(self) -> None:
        # Segmentation is best-effort garnish: a None cutout must not add the
        # field or disturb the matches (app falls back to the plain crossfade).
        fake, method = self._service_with_stubbed_decode()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout_png", return_value=None):
                payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertEqual(payload["matches"], _VALID_MATCHES)
        self.assertNotIn("personCutoutPngBase64", payload)

    def test_extract_person_cutout_png_builds_alpha_matte(self) -> None:
        # Exercise the real pre/post pipeline against a stubbed onnx session:
        # a centered bright square in the saliency map must yield a PNG whose
        # alpha is opaque in the middle and transparent at the corners.
        import numpy as np

        import person_cutout

        prediction = np.zeros((1, 1, 320, 320), dtype=np.float32)
        prediction[0, 0, 80:240, 80:240] = 1.0
        session = Mock()
        model_input = Mock()
        model_input.name = "input.1"
        session.get_inputs.return_value = [model_input]
        session.run.return_value = [prediction]

        with patch.object(person_cutout, "_get_session", return_value=session):
            png_bytes = person_cutout.extract_person_cutout_png(_small_jpeg(400, 400))

        self.assertIsNotNone(png_bytes)
        with Image.open(io.BytesIO(png_bytes)) as cutout:
            self.assertEqual(cutout.mode, "RGBA")
            alpha = cutout.getchannel("A")
            center = alpha.getpixel((cutout.width // 2, cutout.height // 2))
            corner = alpha.getpixel((2, 2))
        self.assertGreater(center, 200)
        self.assertLess(corner, 40)

    def test_extract_person_cutout_png_returns_none_without_session(self) -> None:
        import person_cutout

        with patch.object(person_cutout, "_get_session", return_value=None):
            self.assertIsNone(person_cutout.extract_person_cutout_png(_small_jpeg()))


if __name__ == "__main__":
    unittest.main()
