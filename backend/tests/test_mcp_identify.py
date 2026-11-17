"""identify_card: photo -> main backend visual-match on loopback (mocked here)."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY  # noqa: E402
from mcp_server.rate_limit import UserRateLimiter  # noqa: E402

try:
    import anyio
    import httpx
    from mcp.server.auth.provider import AccessToken
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from PIL import Image

    from mcp_server import app as mcp_app
    from mcp_server import identify
    from mcp_server.tools import CollectionTools
    HAVE_MCP = True
except ImportError:  # pragma: no cover - requirements install `mcp`
    HAVE_MCP = False


def _image_b64(fmt: str = "JPEG", size=(300, 420)) -> str:
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, format=fmt)
    return base64.b64encode(out.getvalue()).decode()


def _match_response(*candidates, confidence="high", disposition="ready"):
    return {
        "scanID": "x",
        "confidence": confidence,
        "reviewDisposition": disposition,
        "topCandidates": [
            {"rank": i + 1, "candidate": cand, "finalScore": score} for i, (cand, score) in enumerate(candidates)
        ],
    }


class IdentifyCardTests(unittest.TestCase):
    def setUp(self) -> None:
        if not HAVE_MCP:
            self.skipTest("mcp SDK not installed")
        from mcp_server.readonly_service import ReadOnlySpotlightService

        self.tempdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tempdir.name) / "identify.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        for card_id, name in (("c-a", "Alakazam"), ("c-b", "Blastoise")):
            upsert_card(conn, card_id=card_id, name=name, set_name="Base Set", number="2", rarity="Rare Holo",
                        variant="Raw", language="English", set_id="base1", set_ptcgo_code="BS",
                        source_payload={"id": card_id})
            conn.execute("INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, "
                         "default_raw_market_price, updated_at) VALUES (?, 'scrydex', 'USD', 20.0, ?)",
                         (card_id, utc_now()))
        conn.commit()
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.tools = CollectionTools(self.service)
        self.requests: list[httpx.Request] = []
        self.responses: list[httpx.Response | Exception] = []

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def make(self, *, sub="user-a", policy=USER_POLICY, daily_limit=25, anonymous=False, token="jwt-abc"):
        access = AccessToken(token=token, client_id="claude", scopes=[], subject=sub,
                             claims={"is_anonymous": anonymous})
        getter = lambda: access  # noqa: E731
        runner = mcp_app.ToolRunner(self.tools, UserRateLimiter(per_minute=60, per_day=2000), policy=policy,
                                    token_getter=getter)
        settings = identify.IdentifySettings(backend_url="http://127.0.0.1:8788", daily_limit=daily_limit,
                                             busy_retry_delay_s=0)
        return identify.IdentifyCard(runner, settings, policy=policy, token_getter=getter,
                                     transport=httpx.MockTransport(self._handler))

    def run_tool(self, tool, **kwargs):
        kwargs.setdefault("image_base64", _image_b64())
        return anyio.run(lambda: tool.run(**kwargs))

    def test_happy_path_forwards_token_and_shapes_candidates(self) -> None:
        unknown = {"id": "x-1", "name": "Mystery", "setName": "Promo", "number": "9", "language": "English",
                   "imageSmallURL": "https://img/x.png",
                   "pricing": {"currencyCode": "USD", "market": 999.0, "pricingMode": "graded_reference"}}
        self.responses.append(httpx.Response(200, json=_match_response(
            ({"id": "c-b"}, 0.912), ({"id": "c-a"}, 0.5), (unknown, 0.4), ({"id": "c-b"}, 0.3))))
        result = self.run_tool(self.make(), game="pokemon", language="english")

        self.assertEqual(len(self.requests), 1)
        sent = self.requests[0]
        self.assertEqual(str(sent.url), "http://127.0.0.1:8788/api/v1/scan/visual-match")
        self.assertEqual(sent.headers["Authorization"], "Bearer jwt-abc")
        for header in ("X-Forwarded-For", "X-Spotlight-Synthetic-Scan"):
            self.assertNotIn(header, sent.headers)
        payload = json.loads(sent.content)
        self.assertTrue(payload["scanID"].startswith("mcp-"))
        self.assertEqual(payload["captureSource"], "mcp_identify_card")
        self.assertEqual((payload["resolverModeHint"], payload["game"], payload["cardLanguage"]),
                         ("raw_card", "pokemon", "english"))
        # Only bytes we produced: never a server-side path the matcher could open.
        self.assertNotIn("normalizedImagePath", payload)
        self.assertNotIn("path", payload["image"])
        self.assertNotIn("confirmedCardID", json.dumps(payload))
        decoded = Image.open(io.BytesIO(base64.b64decode(payload["image"]["jpegBase64"])))
        self.assertEqual(decoded.format, "JPEG")

        ids = [c["card_id"] for c in result["candidates"]]
        self.assertEqual(ids, ["c-b", "c-a", "x-1"])  # deduped, best first
        top = result["candidates"][0]
        self.assertEqual((top["name"], top["set"], top["number"], top["price_usd"], top["confidence"]),
                         ("Blastoise", "Base Set", "2", 20.0, 0.912))
        self.assertEqual(top["app_url"], "spotlight://cards/c-b")
        self.assertIsNone(result["candidates"][2]["price_usd"])  # graded comp is not a raw price
        self.assertEqual(result["match_confidence"], "high")
        self.assertFalse(result["needs_review"])
        self.assertEqual(result["identify_calls_remaining_today"], 24)

    def test_png_and_data_url_accepted_and_downscaled(self) -> None:
        self.responses.append(httpx.Response(200, json=_match_response(confidence="low", disposition="needs_review")))
        big_png = "data:image/png;base64," + _image_b64("PNG", size=(2400, 3200))
        result = self.run_tool(self.make(), image_base64=big_png)
        image = json.loads(self.requests[0].content)["image"]
        self.assertLessEqual(max(image["width"], image["height"]), identify.FORWARD_MAX_SIDE)
        self.assertEqual(result["candidates"], [])
        self.assertTrue(result["needs_review"])

    def test_rejects_bad_type_size_and_base64_without_calling_backend(self) -> None:
        tool = self.make(daily_limit=1)
        cases = {
            "Unsupported image type": _image_b64("GIF"),
            "not valid base64": "!!!not-base64!!!",
            "too large": "A" * (identify.MAX_IMAGE_BASE64_CHARS + 4),
            "Could not read": base64.b64encode(b"plain text, not an image").decode(),
        }
        for message, value in cases.items():
            with self.subTest(message=message), self.assertRaisesRegex(ToolError, message):
                self.run_tool(tool, image_base64=value)
        decoded_too_big = base64.b64encode(b"\0" * (identify.MAX_IMAGE_BYTES + 1)).decode()
        with self.assertRaisesRegex(ToolError, "too large"):
            identify.prepare_image(decoded_too_big[: identify.MAX_IMAGE_BASE64_CHARS])
        self.assertEqual(self.requests, [])
        # Rejected inputs did not use the one daily call.
        self.responses.append(httpx.Response(200, json=_match_response(({"id": "c-a"}, 0.8))))
        self.assertEqual(self.run_tool(tool)["identify_calls_remaining_today"], 0)

    def test_daily_cap_and_failed_calls_are_refunded(self) -> None:
        tool = self.make(daily_limit=2)
        self.responses += [httpx.Response(500, json={"error": "boom"}), httpx.ReadTimeout("slow")]
        with self.assertRaisesRegex(ToolError, "could not identify"):
            self.run_tool(tool)
        with self.assertRaisesRegex(ToolError, "took too long"):
            self.run_tool(tool)
        ok = httpx.Response(200, json=_match_response(({"id": "c-a"}, 0.8)))
        self.responses += [ok, httpx.Response(200, json=_match_response(({"id": "c-a"}, 0.8)))]
        self.run_tool(tool)
        self.run_tool(tool)
        with self.assertRaisesRegex(ToolError, "Daily photo-identify limit"):
            self.run_tool(tool)
        self.assertEqual(len(self.requests), 4)
        # Per user: someone else still has their quota.
        other = self.make(sub="user-b", daily_limit=2)
        other.counter = tool.counter
        self.responses.append(httpx.Response(200, json=_match_response()))
        self.run_tool(other)

    def test_busy_backend_is_retried_once(self) -> None:
        self.responses += [httpx.Response(503, json={"error": "busy"}),
                           httpx.Response(200, json=_match_response(({"id": "c-a"}, 0.7)))]
        result = self.run_tool(self.make())
        self.assertEqual([c["card_id"] for c in result["candidates"]], ["c-a"])
        self.assertEqual(len(self.requests), 2)

    def test_backend_401_maps_to_reconnect(self) -> None:
        self.responses.append(httpx.Response(401, json={"error": "bad token"}))
        with self.assertRaisesRegex(ToolError, "Reconnect"):
            self.run_tool(self.make())

    def test_guest_and_public_tier_refused(self) -> None:
        with self.assertRaisesRegex(ToolError, "Create a free Ekalight account"):
            self.run_tool(self.make(anonymous=True))
        with self.assertRaisesRegex(ToolError, "not available"):
            self.run_tool(self.make(sub="apikey:x", policy=PUBLIC_POLICY))
        self.assertEqual(self.requests, [])

    def test_registered_on_user_tier_only(self) -> None:
        runner = mcp_app.ToolRunner(self.tools, UserRateLimiter())
        settings = identify.IdentifySettings()
        public = MCPServer("t")
        self.assertIsNone(identify.register_identify_card(public, PUBLIC_POLICY, runner, settings=settings))
        user = MCPServer("t")
        self.assertIsNotNone(identify.register_identify_card(user, USER_POLICY, runner, settings=settings))
        disabled = identify.IdentifySettings(enabled=False)
        self.assertIsNone(identify.register_identify_card(MCPServer("t"), USER_POLICY, runner, settings=disabled))

        def names(server):
            return {tool.name: tool for tool in anyio.run(server.list_tools)}

        self.assertNotIn("identify_card", names(public))
        listed = names(user)["identify_card"]
        self.assertTrue(listed.annotations.read_only_hint)
        self.assertFalse(listed.annotations.destructive_hint)
        self.assertNotIn("identify_card", PUBLIC_POLICY.tools)

    def test_settings_from_env_defaults(self) -> None:
        from unittest import mock

        with mock.patch.dict("os.environ", {"SPOTLIGHT_PORT": "8788"}, clear=True):
            settings = identify.IdentifySettings.from_env()
        self.assertEqual((settings.backend_url, settings.daily_limit, settings.enabled),
                         ("http://127.0.0.1:8788", 25, True))
        self.assertGreaterEqual(settings.timeout_s, 30)
        with mock.patch.dict("os.environ", {"SPOTLIGHT_MCP_IDENTIFY_DAILY_LIMIT": "3"}, clear=True):
            self.assertEqual(identify.IdentifySettings.from_env().daily_limit, 3)


if __name__ == "__main__":
    unittest.main()
