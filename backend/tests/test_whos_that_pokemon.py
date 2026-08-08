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

from PIL import Image, ImageDraw  # noqa: E402

import anthropic_adapter  # noqa: E402
import whos_that_share_card  # noqa: E402
from anthropic_adapter import AnthropicResponseError, identify_pokemon_lookalike  # noqa: E402
from request_auth import RequestAuthError, RequestIdentity  # noqa: E402
import server as server_module  # noqa: E402
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

    def _cutout_result(
        self,
        png: bytes | None = None,
        person_bounds: dict[str, float] | None = None,
        head_box: dict[str, float] | None = None,
    ):
        from person_cutout import PersonCutout

        return PersonCutout(
            png_bytes=png if png is not None else _small_png(),
            person_bounds=person_bounds,
            head_box=head_box,
        )

    def test_identify_response_includes_cutout_when_available(self) -> None:
        fake, method = self._service_with_stubbed_decode()
        cutout = _small_png()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=self._cutout_result(cutout)):
                with patch("server._species_outline_for_match", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertEqual(payload["matches"], _VALID_MATCHES)
        self.assertEqual(base64.b64decode(payload["personCutoutPngBase64"]), cutout)

    def test_identify_response_omits_cutout_when_unavailable(self) -> None:
        # Segmentation is best-effort garnish: a None cutout must not add the
        # field or disturb the matches (app falls back to the plain crossfade).
        fake, method = self._service_with_stubbed_decode()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=None):
                with patch("server._species_outline_for_match", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertEqual(payload["matches"], _VALID_MATCHES)
        self.assertNotIn("personCutoutPngBase64", payload)

    def test_identify_response_includes_normalized_geometry(self) -> None:
        fake, method = self._service_with_stubbed_decode()
        person_bounds = {"x": 0.2, "y": 0.05, "width": 0.6, "height": 0.9}
        head_box = {"x": 0.35, "y": 0.05, "width": 0.3, "height": 0.25}
        result = self._cutout_result(person_bounds=person_bounds, head_box=head_box)
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=result):
                with patch("server._species_outline_for_match", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertEqual(payload["personBounds"], person_bounds)
        self.assertEqual(payload["headBox"], head_box)

    def test_identify_response_omits_geometry_when_segmentation_fails(self) -> None:
        # Model unavailable (the gitignored u2netp dir on a fresh box) → the
        # geometry fields must simply not be there. No error, no nulls-with-NaN.
        fake, method = self._service_with_stubbed_decode()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=None):
                with patch("server._species_outline_for_match", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertNotIn("personBounds", payload)
        self.assertNotIn("headBox", payload)

    def test_identify_response_omits_geometry_when_mask_is_degenerate(self) -> None:
        # Cutout pixels are fine but the matte was too noisy to place a body.
        fake, method = self._service_with_stubbed_decode()
        result = self._cutout_result(person_bounds=None, head_box=None)
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=result):
                with patch("server._species_outline_for_match", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertIn("personCutoutPngBase64", payload)
        self.assertNotIn("personBounds", payload)
        self.assertNotIn("headBox", payload)

    def test_identify_response_includes_species_outline(self) -> None:
        fake, method = self._service_with_stubbed_decode()
        outline = [{"x": 0.5, "y": 0.1}, {"x": 0.9, "y": 0.5}]
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=None):
                with patch("server.species_outline", return_value=outline) as mocked:
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        # Outline is requested for the TOP match's species, not all three.
        self.assertEqual(mocked.call_args.args[0], 25)
        self.assertEqual(payload["speciesOutline"], outline)

    def test_identify_response_omits_species_outline_when_unavailable(self) -> None:
        fake, method = self._service_with_stubbed_decode()
        with patch("server.identify_pokemon_lookalike", return_value=_VALID_MATCHES):
            with patch("server.extract_person_cutout", return_value=None):
                with patch("server.species_outline", return_value=None):
                    payload = method(fake, {"image": {"jpegBase64": "ignored"}})

        self.assertNotIn("speciesOutline", payload)

    def test_species_outline_for_match_tolerates_garbage_matches(self) -> None:
        import server

        with patch("server.species_outline") as mocked:
            for bad in (None, "Pikachu", {}, {"pokedexId": None}, {"pokedexId": True}, {"pokedexId": "nope"}):
                self.assertIsNone(server._species_outline_for_match(bad))
        mocked.assert_not_called()

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

    def test_extract_person_cutout_carries_geometry_through_the_pipeline(self) -> None:
        # Same stubbed session as the matte test: a centered square occupying
        # the middle half of the frame must come back as bounds ~ (.25,.25,.5,.5)
        # in NORMALIZED ORIGINAL-IMAGE space, with the head box inside them.
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
            result = person_cutout.extract_person_cutout(_small_jpeg(400, 400))

        self.assertIsNotNone(result)
        self.assertTrue(result.png_bytes)
        bounds = result.person_bounds
        self.assertAlmostEqual(bounds["x"], 0.25, delta=0.03)
        self.assertAlmostEqual(bounds["y"], 0.25, delta=0.03)
        self.assertAlmostEqual(bounds["width"], 0.5, delta=0.05)
        self.assertAlmostEqual(bounds["height"], 0.5, delta=0.05)
        head = result.head_box
        self.assertGreaterEqual(head["x"], bounds["x"])
        self.assertLessEqual(head["x"] + head["width"], bounds["x"] + bounds["width"] + 1e-6)
        self.assertLessEqual(head["y"] + head["height"], bounds["y"] + bounds["height"] + 1e-6)


class PersonGeometryTests(unittest.TestCase):
    """person_geometry_from_mask: MASK space in, normalized 0..1 out."""

    def _person_mask(self):
        # 200 rows x 100 cols. Head: rows 20..59, cols 40..59 (20 wide).
        # Torso: rows 60..159, cols 20..79 (60 wide) — a 3x shoulder step.
        import numpy as np

        mask = np.zeros((200, 100), dtype=np.uint8)
        mask[20:60, 40:60] = 255
        mask[60:160, 20:80] = 255
        return mask

    def test_person_bounds_are_tight_and_normalized(self) -> None:
        from person_cutout import person_geometry_from_mask

        bounds, _ = person_geometry_from_mask(self._person_mask(), 1000, 2000)
        # cols 20..79 of 100 -> x .20 width .60; rows 20..159 of 200 -> y .10 h .70
        self.assertEqual(bounds, {"x": 0.2, "y": 0.1, "width": 0.6, "height": 0.7})

    def test_head_box_stops_at_the_shoulder_step_and_sits_inside_person(self) -> None:
        from person_cutout import person_geometry_from_mask

        bounds, head = person_geometry_from_mask(self._person_mask(), 1000, 2000)
        # Head band: rows 20..59 -> y .10 h .20; cols 40..59 -> x .40 w .20
        self.assertEqual(head, {"x": 0.4, "y": 0.1, "width": 0.2, "height": 0.2})
        self.assertGreaterEqual(head["x"], bounds["x"])
        self.assertGreaterEqual(head["y"], bounds["y"])
        self.assertLessEqual(head["x"] + head["width"], bounds["x"] + bounds["width"])
        self.assertLessEqual(head["y"] + head["height"], bounds["y"] + bounds["height"])

    def test_head_box_falls_back_to_head_aspect_without_shoulders(self) -> None:
        # No widening anywhere (tight head-and-hair crop): height comes from the
        # measured width x the anthropometric head aspect.
        import numpy as np

        from person_cutout import person_geometry_from_mask

        mask = np.zeros((200, 100), dtype=np.uint8)
        mask[10:190, 30:70] = 255  # 40 cols wide, constant
        _, head = person_geometry_from_mask(mask, 1000, 1000)
        # width .40 * (1000/1000) * 1.35 = .54 of the frame height.
        self.assertAlmostEqual(head["height"], 0.54, delta=0.01)

    def test_head_aspect_fallback_respects_original_image_aspect(self) -> None:
        # THE subtle one: the mask is a square resize of the frame, so turning a
        # measured WIDTH into a HEIGHT must go through the ORIGINAL pixel aspect.
        # Same mask, a 2:1-tall original -> half the normalized head height.
        import numpy as np

        from person_cutout import person_geometry_from_mask

        mask = np.zeros((200, 100), dtype=np.uint8)
        mask[10:190, 30:70] = 255
        _, square = person_geometry_from_mask(mask, 1000, 1000)
        _, portrait = person_geometry_from_mask(mask, 1000, 2000)
        self.assertAlmostEqual(portrait["height"], square["height"] / 2.0, delta=0.01)

    def test_speckle_rows_do_not_blow_out_the_bounds(self) -> None:
        import numpy as np

        from person_cutout import person_geometry_from_mask

        mask = self._person_mask()
        mask[2, 3] = 255  # lone hot pixel in the corner
        mask[197, 96] = 255
        bounds, _ = person_geometry_from_mask(mask, 1000, 2000)
        self.assertEqual(bounds, {"x": 0.2, "y": 0.1, "width": 0.6, "height": 0.7})

    def test_empty_and_degenerate_masks_return_none_without_dividing_by_zero(self) -> None:
        import numpy as np

        from person_cutout import person_geometry_from_mask

        empty = np.zeros((200, 100), dtype=np.uint8)
        self.assertEqual(person_geometry_from_mask(empty, 1000, 2000), (None, None))

        speck = np.zeros((200, 100), dtype=np.uint8)
        speck[5, 5] = 255  # below the minimum coverage
        self.assertEqual(person_geometry_from_mask(speck, 1000, 2000), (None, None))

        self.assertEqual(person_geometry_from_mask(np.zeros((0, 0)), 1000, 2000), (None, None))
        self.assertEqual(person_geometry_from_mask(np.zeros(10), 1000, 2000), (None, None))
        # Zero-sized original image must not divide by zero.
        self.assertEqual(person_geometry_from_mask(self._person_mask(), 0, 0), (None, None))

    def test_full_frame_mask_stays_inside_the_unit_square(self) -> None:
        import numpy as np

        from person_cutout import person_geometry_from_mask

        bounds, head = person_geometry_from_mask(np.full((64, 64), 255, dtype=np.uint8), 640, 640)
        for box in (bounds, head):
            self.assertGreaterEqual(box["x"], 0.0)
            self.assertGreaterEqual(box["y"], 0.0)
            self.assertLessEqual(box["x"] + box["width"], 1.0)
            self.assertLessEqual(box["y"] + box["height"], 1.0)


def _artwork_png(size: int = 120, radius: int = 40, *, mode: str = "RGBA") -> bytes:
    """A filled circle on transparency — stand-in for official artwork."""
    image = Image.new(mode, (size, size), (0, 0, 0, 0) if mode == "RGBA" else (255, 255, 255))
    draw = ImageDraw.Draw(image)
    box = (size // 2 - radius, size // 2 - radius, size // 2 + radius, size // 2 + radius)
    draw.ellipse(box, fill=(255, 60, 60, 255) if mode == "RGBA" else (255, 60, 60))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class SpeciesOutlineTests(unittest.TestCase):
    def setUp(self) -> None:
        import species_outline

        self.module = species_outline
        self.module._memo.clear()
        self.tempdir = tempfile.TemporaryDirectory()
        self.dataset_root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.module._memo.clear()
        self.tempdir.cleanup()

    def test_outline_points_are_normalized_ordered_and_plausible(self) -> None:
        import math

        import numpy as np

        with Image.open(io.BytesIO(_artwork_png())) as artwork:
            alpha = np.asarray(artwork.getchannel("A"))
        points = self.module.outline_points_from_alpha(alpha)

        self.assertEqual(len(points), self.module.OUTLINE_POINT_COUNT)
        for point in points:
            self.assertGreaterEqual(point["x"], 0.0)
            self.assertLessEqual(point["x"], 1.0)
            self.assertGreaterEqual(point["y"], 0.0)
            self.assertLessEqual(point["y"], 1.0)

        # Angularly ordered around the centroid (clockwise on screen), and for a
        # circle every point should sit ~radius/size away from the centre.
        angles = [
            math.atan2(point["y"] - 0.5, point["x"] - 0.5) % (2.0 * math.pi) for point in points
        ]
        self.assertEqual(angles, sorted(angles))
        for point in points:
            radius = math.hypot(point["x"] - 0.5, point["y"] - 0.5)
            self.assertAlmostEqual(radius, 40.0 / 120.0, delta=0.03)

    def test_outline_points_reject_empty_and_speck_masks(self) -> None:
        import numpy as np

        self.assertIsNone(self.module.outline_points_from_alpha(np.zeros((64, 64), dtype=np.uint8)))
        speck = np.zeros((64, 64), dtype=np.uint8)
        speck[1, 1] = 255
        self.assertIsNone(self.module.outline_points_from_alpha(speck))
        self.assertIsNone(self.module.outline_points_from_alpha(np.zeros(10)))

    def test_species_outline_caches_in_process_and_on_disk(self) -> None:
        artwork = _artwork_png()
        with patch.object(self.module, "fetch_official_artwork", return_value=artwork) as fetch:
            first = self.module.species_outline(25, dataset_root=self.dataset_root)
        fetch.assert_called_once()
        self.assertTrue(first)

        # Warm process: memo hit, no fetch at all.
        with patch.object(self.module, "fetch_official_artwork") as fetch_again:
            second = self.module.species_outline(25, dataset_root=self.dataset_root)
        fetch_again.assert_not_called()
        self.assertEqual(second, first)

        # Cold process, warm disk: the JSON cache beside the artwork is used.
        cache_path = self.dataset_root / "pokeapi_artwork" / "25.outline.json"
        self.assertTrue(cache_path.exists())
        self.module._memo.clear()
        with patch.object(self.module, "fetch_official_artwork") as fetch_cold:
            third = self.module.species_outline(25, dataset_root=self.dataset_root)
        fetch_cold.assert_not_called()
        self.assertEqual(third, first)

    def test_species_outline_returns_none_when_artwork_fetch_fails(self) -> None:
        from urllib.error import URLError

        with patch.object(
            self.module, "fetch_official_artwork", side_effect=URLError("offline")
        ) as fetch:
            self.assertIsNone(self.module.species_outline(25, dataset_root=self.dataset_root))
        fetch.assert_called_once()

        # The negative result is memoized: a dead species is not re-fetched.
        with patch.object(self.module, "fetch_official_artwork") as fetch_again:
            self.assertIsNone(self.module.species_outline(25, dataset_root=self.dataset_root))
        fetch_again.assert_not_called()

    def test_species_outline_returns_none_for_artwork_without_alpha(self) -> None:
        opaque = _artwork_png(mode="RGB")
        with patch.object(self.module, "fetch_official_artwork", return_value=opaque):
            self.assertIsNone(self.module.species_outline(25, dataset_root=self.dataset_root))

    def test_species_outline_rejects_bad_ids_without_fetching(self) -> None:
        with patch.object(self.module, "fetch_official_artwork") as fetch:
            self.assertIsNone(self.module.species_outline(0, dataset_root=self.dataset_root))
            self.assertIsNone(self.module.species_outline("nope", dataset_root=self.dataset_root))
        fetch.assert_not_called()


def _person_cutout_png(width: int = 400, height: int = 600) -> bytes:
    """A head-and-shoulders alpha matte standing in for a real person cutout."""
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse([150, 60, 250, 180], fill=(20, 20, 20, 255))
    draw.rounded_rectangle([110, 175, 290, 520], radius=60, fill=(20, 20, 20, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class PersonOutlineTests(unittest.TestCase):
    """YOUR outline, traced from the cutout with the species tracer.

    The morph interpolates `personOutline[i]` toward `speciesOutline[i]`, so the
    contract that actually matters is that both arrays come back the same length
    in the same angular order. These tests pin that, not the pixel values.
    """

    def test_person_outline_matches_the_species_outline_contract(self) -> None:
        import math

        import species_outline

        points = server_module._person_outline_from_cutout(_person_cutout_png())

        # Same count as the species side — index-comparable, which is the whole
        # reason the morph can interpolate point-for-point.
        self.assertEqual(len(points), species_outline.OUTLINE_POINT_COUNT)
        for point in points:
            self.assertGreaterEqual(point["x"], 0.0)
            self.assertLessEqual(point["x"], 1.0)
            self.assertGreaterEqual(point["y"], 0.0)
            self.assertLessEqual(point["y"], 1.0)

        # Same angular order as the species outline: monotonic clockwise about
        # the shape's centre. Measured from the mean of the points rather than
        # the tracer's alpha centroid, the run can START mid-circle, so the
        # invariant is "sorted with exactly one wrap past 2pi" — not "sorted".
        # If this ever grows a second wrap the outline is self-crossing and the
        # morph will visibly twist.
        centre_x = sum(point["x"] for point in points) / len(points)
        centre_y = sum(point["y"] for point in points) / len(points)
        angles = [
            math.atan2(point["y"] - centre_y, point["x"] - centre_x) % (2.0 * math.pi)
            for point in points
        ]
        descents = sum(
            1 for index in range(len(angles) - 1) if angles[index + 1] < angles[index]
        )
        self.assertLessEqual(descents, 1, f"outline is not angularly ordered: {angles}")

    def test_person_outline_traces_the_figure_not_the_frame(self) -> None:
        points = server_module._person_outline_from_cutout(_person_cutout_png())
        xs = [point["x"] for point in points]
        ys = [point["y"] for point in points]
        # The torso spans roughly the middle half of a 400px-wide frame; a mask
        # that ray-cast to the frame rectangle instead would reach 0..1.
        self.assertGreater(min(xs), 0.15)
        self.assertLess(max(xs), 0.85)
        # Head crown near the top, feet-end of the torso well down the frame.
        self.assertLess(min(ys), 0.2)
        self.assertGreater(max(ys), 0.8)

    def test_person_outline_is_best_effort_and_never_raises(self) -> None:
        opaque = io.BytesIO()
        Image.new("RGB", (32, 32), (1, 2, 3)).save(opaque, format="PNG")

        self.assertIsNone(server_module._person_outline_from_cutout(None))
        self.assertIsNone(server_module._person_outline_from_cutout(b""))
        # Undecodable bytes are swallowed, not propagated into the request path.
        self.assertIsNone(server_module._person_outline_from_cutout(b"not-a-png"))
        # An image with no alpha would ray-cast to the frame; omit it instead.
        self.assertIsNone(server_module._person_outline_from_cutout(opaque.getvalue()))


if __name__ == "__main__":
    unittest.main()
