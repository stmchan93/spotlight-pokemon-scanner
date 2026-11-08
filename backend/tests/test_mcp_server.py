"""MCP server wiring: auth (Supabase JWT / API key), guest rejection, rate limit,
response policy, and the Streamable HTTP app end to end (real uvicorn on a free
port, mocked JWT secret; no network)."""

from __future__ import annotations

import hashlib
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import jwt  # noqa: E402

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from mcp_server.auth import ApiKeyValidator, McpConfig, McpTokenValidator, _parse_plan_quotas  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY, policy_for_tier  # noqa: E402
from mcp_server.rate_limit import RateLimitExceeded, UserRateLimiter  # noqa: E402

try:
    import anyio
    import uvicorn
    from mcp.server.auth.provider import AccessToken
    from mcp.server.mcpserver.exceptions import ToolError

    from mcp_server import app as mcp_app
    from mcp_server.tools import CollectionTools
    HAVE_MCP = True
except ImportError:  # pragma: no cover - requirements install `mcp`
    HAVE_MCP = False

SUPABASE_URL = "https://example-ref.supabase.co"
JWT_SECRET = "test-secret-that-is-long-enough-for-hs256"


def make_jwt(sub: str, *, anonymous: bool = False, client_id: str | None = "claude", **extra) -> str:
    now = int(time.time())
    claims = {"sub": sub, "iss": f"{SUPABASE_URL}/auth/v1", "iat": now, "exp": now + 600,
              "aud": "authenticated", "is_anonymous": anonymous, **extra}
    if client_id:
        claims["client_id"] = client_id
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def make_config(**overrides) -> McpConfig:
    values = dict(database_path=":memory:", supabase_url=SUPABASE_URL, supabase_jwt_secret=JWT_SECRET,
                  authorization_server_url=f"{SUPABASE_URL}/auth/v1")
    values.update(overrides)
    return McpConfig(**values)


class RateLimitTests(unittest.TestCase):
    def test_per_minute_bucket_refills(self) -> None:
        now = [0.0]
        limiter = UserRateLimiter(per_minute=60, per_day=2000, clock=lambda: now[0], day_clock=lambda: "d1")
        for _ in range(60):
            limiter.check("a")
        with self.assertRaises(RateLimitExceeded):
            limiter.check("a")
        limiter.check("b")  # per user
        now[0] = 1.0  # one token back after a second
        limiter.check("a")
        with self.assertRaises(RateLimitExceeded):
            limiter.check("a")

    def test_daily_cap_resets_next_day(self) -> None:
        now, day = [0.0], ["d1"]
        limiter = UserRateLimiter(per_minute=60, per_day=3, clock=lambda: now[0], day_clock=lambda: day[0])
        for _ in range(3):
            now[0] += 10
            limiter.check("a")
        now[0] += 60
        with self.assertRaisesRegex(RateLimitExceeded, "Daily limit"):
            limiter.check("a")
        day[0] = "d2"
        limiter.check("a")

    def test_defaults_are_personal_use(self) -> None:
        config = McpConfig(database_path="x")
        self.assertEqual((config.rate_per_minute, config.rate_per_day), (60, 2000))
        self.assertEqual(_parse_plan_quotas("free:30/500,pro:120/20000,bad"), {"free": (30, 500), "pro": (120, 20000)})


class TokenValidatorTests(unittest.TestCase):
    def test_valid_supabase_jwt(self) -> None:
        verified = McpTokenValidator(make_config()).validate(make_jwt("user-a"))
        self.assertEqual(verified.identity.user_id, "user-a")
        self.assertFalse(verified.identity.is_anonymous)
        self.assertEqual(verified.client_id, "claude")

    def test_rejects_bad_signature_issuer_expiry(self) -> None:
        validator = McpTokenValidator(make_config())
        now = int(time.time())
        bad_sig = jwt.encode({"sub": "x", "iss": f"{SUPABASE_URL}/auth/v1", "iat": now, "exp": now + 60},
                             "other-secret-other-secret-other-secret", algorithm="HS256")
        self.assertIsNone(validator.validate(bad_sig))
        self.assertIsNone(validator.validate(make_jwt("x", iss="https://evil.example/auth/v1")))
        self.assertIsNone(validator.validate(make_jwt("x", exp=now - 10)))
        self.assertIsNone(validator.validate("not-a-jwt"))

    def test_guest_flag_and_optional_client_and_audience_checks(self) -> None:
        self.assertTrue(McpTokenValidator(make_config()).validate(make_jwt("g", anonymous=True)).identity.is_anonymous)
        strict = McpTokenValidator(make_config(require_oauth_client=True, token_audience="https://mcp.example/mcp"))
        self.assertIsNone(strict.validate(make_jwt("a", client_id=None, aud="https://mcp.example/mcp")))
        self.assertIsNone(strict.validate(make_jwt("a")))  # aud=authenticated
        self.assertIsNotNone(strict.validate(make_jwt("a", aud="https://mcp.example/mcp")))

    def test_api_key_validator(self) -> None:
        key = "ek_live_example"
        config = make_config(tier="public", public_api_keys={hashlib.sha256(key.encode()).hexdigest(): "pro"})
        verified = ApiKeyValidator(config).validate(key)
        self.assertEqual(verified.plan, "pro")
        self.assertTrue(verified.identity.user_id.startswith("apikey:"))
        self.assertIsNone(ApiKeyValidator(config).validate("wrong"))


class PolicyTests(unittest.TestCase):
    SAMPLE = {
        "results": [{
            "card_id": "c1", "name": "Pikachu", "set": "Base", "set_code": "BS", "number": "58", "language": "English",
            "rarity_bucket": "standard", "artist": "Atsuko Nishida", "image_small_url": "https://img/c1.png",
            "price_usd": 3.0, "price_source": "tcgplayer", "app_url": "spotlight://cards/c1", "tcgplayer_id": "42",
            "tags": {"scene": ["forest"]}, "buy_links": {"ebay": "https://ebay"},
        }],
        "next_cursor": "abc",
        "total_estimate": 1,
    }

    def test_user_tier_keeps_card_summary(self) -> None:
        card = USER_POLICY.shape(self.SAMPLE)["results"][0]
        self.assertEqual(card["name"], "Pikachu")
        self.assertEqual(card["price_usd"], 3.0)

    def test_public_tier_strips_prices_names_images(self) -> None:
        shaped = PUBLIC_POLICY.shape(self.SAMPLE)
        self.assertEqual(shaped["results"][0], {
            "card_id": "c1", "tcgplayer_id": "42", "set_code": "BS", "number": "58", "language": "English",
            "rarity_bucket": "standard", "tags": {"scene": ["forest"]},
        })
        self.assertEqual(shaped["next_cursor"], "abc")

    def test_public_tier_refuses_account_and_price_inputs(self) -> None:
        self.assertEqual(PUBLIC_POLICY.tools, ("list_facets", "search_cards", "get_card"))
        with self.assertRaises(ValueError):
            PUBLIC_POLICY.check_inputs({"price_max_usd": 5})
        with self.assertRaises(ValueError):
            PUBLIC_POLICY.check_inputs({}, sort="price_asc")
        with self.assertRaises(ValueError):
            PUBLIC_POLICY.check_inputs({}, owned="owned")
        USER_POLICY.check_inputs({"price_max_usd": 5}, sort="price_asc", owned="owned")
        with self.assertRaises(ValueError):
            policy_for_tier("enterprise")


class _SeededDb(unittest.TestCase):
    def setUp(self) -> None:
        if not HAVE_MCP:
            self.skipTest("mcp SDK not installed")
        from mcp_server.readonly_service import ReadOnlySpotlightService

        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "mcp-server.sqlite"
        conn = connect(self.db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        for card_id, name in (("c-a", "Alakazam"), ("c-b", "Blastoise")):
            upsert_card(conn, card_id=card_id, name=name, set_name="Base Set", number="1", rarity="Rare Holo",
                        variant="Raw", language="English", set_id="base1", set_ptcgo_code="BS",
                        source_payload={"id": card_id})
            conn.execute("INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, "
                         "default_raw_market_price, updated_at) VALUES (?, 'scrydex', 'USD', 20.0, ?)", (card_id, utc_now()))
        for entry_id, owner, card_id in (("e1", "user-a", "c-a"), ("e2", "user-b", "c-b")):
            conn.execute("INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, quantity, "
                         "added_at, updated_at) VALUES (?, ?, ?, 'raw', ?, 1, ?, ?)",
                         (entry_id, owner, card_id, card_id, utc_now(), utc_now()))
        conn.commit()
        conn.close()
        self.service = ReadOnlySpotlightService(self.db_path, REPO_ROOT)
        self.tools = CollectionTools(self.service)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()


class ToolRunnerTests(_SeededDb):
    def runner(self, token, *, policy=USER_POLICY, per_minute=60):
        limiter = UserRateLimiter(per_minute=per_minute, per_day=2000)
        plan_limiters = {"free": UserRateLimiter(per_minute=1, per_day=10)}
        return mcp_app.ToolRunner(self.tools, limiter, policy=policy, plan_limiters=plan_limiters,
                                  token_getter=lambda: token)

    @staticmethod
    def token(sub, **claims):
        return AccessToken(token="t", client_id="c", scopes=[], subject=sub, claims=claims)

    def run_tool(self, runner, method, **kwargs):
        return anyio.run(lambda: runner.run(method, **kwargs))

    def test_guest_and_missing_identity_rejected(self) -> None:
        with self.assertRaisesRegex(ToolError, "Create a free Ekalight account"):
            self.run_tool(self.runner(self.token("g", is_anonymous=True)), "list_facets")
        with self.assertRaisesRegex(ToolError, "Not signed in"):
            self.run_tool(self.runner(None), "list_facets")

    def test_owner_scoping_follows_token_subject(self) -> None:
        a = self.run_tool(self.runner(self.token("user-a")), "get_my_collection", card_filter=None)
        b = self.run_tool(self.runner(self.token("user-b")), "get_my_collection", card_filter=None)
        self.assertEqual([i["card_id"] for i in a["items"]], ["c-a"])
        self.assertEqual([i["card_id"] for i in b["items"]], ["c-b"])
        nobody = self.run_tool(self.runner(self.token("user-c")), "get_my_collection", card_filter=None)
        self.assertEqual(nobody["items"], [])

    def test_rate_limit_surfaces_as_tool_error(self) -> None:
        runner = self.runner(self.token("user-a"), per_minute=2)
        self.run_tool(runner, "list_facets")
        self.run_tool(runner, "list_facets")
        with self.assertRaisesRegex(ToolError, "Rate limit"):
            self.run_tool(runner, "list_facets")

    def test_public_policy_applied_by_runner(self) -> None:
        runner = self.runner(self.token("apikey:x", plan="free"), policy=PUBLIC_POLICY)
        card = self.run_tool(runner, "get_card", card_id="c-a")
        self.assertNotIn("name", card)
        self.assertNotIn("price_usd", card)
        self.assertNotIn("my_holdings", card)
        self.assertEqual(card["set_code"], "BS")
        with self.assertRaisesRegex(ToolError, "Rate limit"):  # plan quota: 1/min
            self.run_tool(runner, "get_card", card_id="c-a")
        with self.assertRaisesRegex(ToolError, "not available"):
            self.run_tool(self.runner(self.token("apikey:y", plan="free"), policy=PUBLIC_POLICY),
                          "get_my_collection", card_filter=None)

    def test_unexpected_errors_are_not_leaked(self) -> None:
        runner = self.runner(self.token("user-a"))
        self.tools.list_facets = lambda owner: (_ for _ in ()).throw(RuntimeError("db path /secret"))
        with self.assertRaises(ToolError) as caught:
            self.run_tool(runner, "list_facets")
        self.assertNotIn("/secret", str(caught.exception))


class HttpAppTests(_SeededDb):
    """Real Streamable HTTP app with the real Supabase validator (HS256 test secret)."""

    def setUp(self) -> None:
        super().setUp()
        self.service.connection.close()
        self.port = self._free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.servers = []

    def tearDown(self) -> None:
        for server in self.servers:
            server.should_exit = True
        super().tearDown()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def start(self, **overrides) -> None:
        config = make_config(database_path=str(self.db_path), port=self.port, resource_url=f"{self.base}/mcp",
                             **overrides)
        server = uvicorn.Server(uvicorn.Config(mcp_app.build_app(config), host="127.0.0.1", port=self.port,
                                               log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()
        deadline = time.time() + 10
        while not server.started and time.time() < deadline:
            time.sleep(0.02)
        self.servers.append(server)

    def request(self, path, body=None, token=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": "2025-11-25"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body else None,
                                     headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.headers, json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                return error.code, error.headers, json.loads(raw or b"null")
            except ValueError:
                return error.code, error.headers, raw.decode(errors="replace")

    def rpc(self, method, params=None, token=None):
        return self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, token)

    def call_tool(self, name, arguments, token):
        status, _, body = self.rpc("tools/call", {"name": name, "arguments": arguments}, token)
        self.assertEqual(status, 200)
        return body["result"]

    def test_protected_resource_metadata_and_401(self) -> None:
        self.start()
        for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
            status, _, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertEqual(body["resource"], f"{self.base}/mcp")
            self.assertEqual(body["authorization_servers"], [f"{SUPABASE_URL}/auth/v1"])
        status, headers, _ = self.rpc("tools/list")
        self.assertEqual(status, 401)
        self.assertIn('resource_metadata="', headers["WWW-Authenticate"])
        self.assertEqual(self.rpc("tools/list", token="garbage")[0], 401)

    def test_tools_listed_read_only_and_scoped_per_user(self) -> None:
        self.start()
        status, _, body = self.rpc("tools/list", token=make_jwt("user-a"))
        self.assertEqual(status, 200)
        tools = {tool["name"]: tool for tool in body["result"]["tools"]}
        self.assertEqual(set(tools), {"list_facets", "search_cards", "get_card", "get_my_collection",
                                      "get_portfolio_summary", "find_missing", "get_price_history"})
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in tools.values()))
        a = self.call_tool("get_my_collection", {}, make_jwt("user-a"))["structuredContent"]
        b = self.call_tool("get_my_collection", {}, make_jwt("user-b"))["structuredContent"]
        self.assertEqual([i["card_id"] for i in a["items"]], ["c-a"])
        self.assertEqual([i["card_id"] for i in b["items"]], ["c-b"])
        guest = self.call_tool("get_my_collection", {}, make_jwt("user-a", anonymous=True))
        self.assertTrue(guest["isError"])
        self.assertIn("Create a free Ekalight account", guest["content"][0]["text"])
        too_big = self.call_tool("search_cards", {"filter": {"text": "a"}, "limit": 500}, make_jwt("user-a"))
        self.assertTrue(too_big["isError"])

    def _get_raw(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as resp:
                return resp.status, resp.headers, resp.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read().decode()

    def test_consent_page_served_only_with_anon_key(self) -> None:
        self.start(supabase_anon_key="sb_publishable_test</script>")
        status, headers, page = self._get_raw("/oauth/consent?authorization_id=abc")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn(SUPABASE_URL, page)
        self.assertIn("shouldCreateUser: false", page)  # never mints users
        self.assertIn("is_anonymous", page)  # guests refused
        self.assertNotIn("sb_publishable_test</script>", page)  # can't break out of <script>
        self.assertIn("sb_publishable_test<\\/script>", page)

    def test_consent_page_absent_without_anon_key(self) -> None:
        self.start()
        self.assertEqual(self._get_raw("/oauth/consent")[0], 404)

    def test_public_tier_switch(self) -> None:
        key = "ek_public_example"
        self.start(tier="public", public_api_keys={hashlib.sha256(key.encode()).hexdigest(): "free"})
        self.assertEqual(self.request("/.well-known/oauth-protected-resource")[0], 404)
        self.assertEqual(self.rpc("tools/list", token=make_jwt("user-a"))[0], 401)  # JWTs not accepted here
        status, _, body = self.rpc("tools/list", token=key)
        self.assertEqual(status, 200)
        self.assertEqual({t["name"] for t in body["result"]["tools"]}, {"list_facets", "search_cards", "get_card"})
        results = self.call_tool("search_cards", {"filter": {"set": "Base Set"}}, key)["structuredContent"]["results"]
        self.assertEqual(len(results), 2)
        for card in results:
            self.assertFalse({"name", "price_usd", "image_small_url", "set", "artist", "app_url"} & set(card))
            self.assertEqual((card["set_code"], card["number"]), ("BS", "1"))


if __name__ == "__main__":
    unittest.main()
