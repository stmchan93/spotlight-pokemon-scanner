"""tools/seed_booth_test_show.py against an in-memory fake of staging (no network)."""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
for path in (REPO_ROOT, REPO_ROOT / "backend"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from tools import seed_booth_test_show as seed  # noqa: E402

STAGING_SUPABASE = f"https://{seed.STAGING_REF}.supabase.co"
STAGING_API = f"https://{seed.STAGING_API_HOST}"
SERVICE_KEY = "service-key-SECRET-123"
ANON_KEY = "anon-key-SECRET-456"
OPS_TOKEN = "ops-token-SECRET-789"
NOW = datetime(2026, 10, 31, 20, 0, tzinfo=timezone.utc)
HAWAII = REPO_ROOT / "backend/data/spotlight_event_maps/hawaii-2026-10.json"


def _config() -> seed.Config:
    return seed.Config(STAGING_SUPABASE, SERVICE_KEY, ANON_KEY, STAGING_API, OPS_TOKEN)


class FakeStaging:
    """Just enough of Supabase (auth admin, PostgREST, RPCs) + the backend to run the seed."""

    def __init__(self, *, has_29: bool = True, map_served: bool = False) -> None:
        self.has_29 = has_29
        self.map_served = map_served
        self.calls: list[tuple[str, str]] = []
        self.auth_users: dict[str, dict] = {}
        self.passwords: dict[str, str] = {}
        self.profiles: dict[str, dict] = {}
        self.claims: dict[str, str] = {}  # vendor -> user id
        self.posts: list[dict] = []
        self.media: list[dict] = []
        self.booth_events: list[dict] = []
        self.presence: dict[tuple[str, str], str] = {}
        self.vendor_emails: dict[str, list[str]] = {}
        self.admin_events: dict[str, dict] = {}
        self.deleted_paths: list[str] = []
        self._n = 0

    def _id(self) -> str:
        self._n += 1
        return f"00000000-0000-4000-8000-{self._n:012d}"

    def _user_for(self, headers: dict) -> str | None:
        token = headers.get("Authorization", "").removeprefix("Bearer ")
        return token.removeprefix("jwt-") if token.startswith("jwt-") else None

    def __call__(self, method, url, headers, body):
        parsed = urlparse(url)
        self.calls.append((method, parsed.path))
        data = json.loads(body) if body and headers.get("Content-Type") == "application/json" else None
        query = parse_qs(parsed.query)
        path = parsed.path

        def ok(payload=None, status=200):
            return status, json.dumps(payload).encode() if payload is not None else b""

        if parsed.netloc == seed.STAGING_API_HOST:
            if path == "/api/v1/admin/events":
                if headers.get("X-Ops-Token") != OPS_TOKEN:
                    return 401, b'{"error":"invalid ops token"}'
                if method == "GET":
                    return ok({"events": list(self.admin_events.values())})
                self.admin_events[data["id"]] = data
                return ok({"event": data})
            if path.startswith("/api/v1/admin/events/") and method == "DELETE":
                self.admin_events.pop(path.rsplit("/", 1)[1], None)
                return ok({"reset": True})
            if path.endswith("/map"):
                return (200, b"{}") if self.map_served else (404, b'{"error":"not_found"}')
            if path == "/api/v1/post-media":
                uid = self._user_for(headers)
                post = next(p for p in self.posts if p["id"] == query["postId"][0])
                if post["author_id"] != uid or not body.startswith(b"\xff\xd8"):
                    return 403, b"{}"
                self.media.append({"post_id": post["id"], "position": int(query["position"][0])})
                return ok({"mediaId": self._id()})
            if path == "/api/v1/account/delete":
                uid = self._user_for(headers)
                self._delete_user(uid)
                return ok({"deleted": True})
            return 404, b"{}"

        if path == "/auth/v1/admin/users" and method == "GET":
            return ok({"users": list(self.auth_users.values())})
        if path == "/auth/v1/admin/users" and method == "POST":
            uid = self._id()
            self.auth_users[uid] = {"id": uid, "email": data["email"]}
            self.passwords[uid] = data["password"]
            self.profiles[uid] = {"user_id": uid}
            return ok(self.auth_users[uid])
        if path.startswith("/auth/v1/admin/users/"):
            uid = path.rsplit("/", 1)[1]
            if method == "PUT":
                self.passwords[uid] = data["password"]
                return ok(self.auth_users[uid])
            self._delete_user(uid)
            return ok({})
        if path == "/auth/v1/token":
            user = next((u for u in self.auth_users.values() if u["email"] == data["email"]), None)
            if user is None or self.passwords[user["id"]] != data["password"] or headers.get("apikey") != ANON_KEY:
                return 400, b'{"error":"invalid_grant"}'
            return ok({"access_token": f"jwt-{user['id']}"})

        table = path.removeprefix("/rest/v1/")
        if table == "booth_vendor_emails" and not self.has_29:
            return 404, b'{"code":"PGRST205"}'
        if method == "GET" and "limit" in query and table in {"booth_claims", "booth_vendor_emails"}:
            return ok([])
        if table == "user_profiles":
            self.profiles.setdefault(data["user_id"], {}).update(data)
            return ok(None, 201)
        if table == "rpc/claim_booth":
            uid = self._user_for(headers)
            holder = self.claims.get(data["p_vendor_id"])
            if holder == uid:
                return ok("already_yours")
            if holder:
                return ok("taken")
            self.claims[data["p_vendor_id"]] = uid
            return ok("claimed")
        if table == "rpc/replace_booth_vendor_emails":
            self.vendor_emails = data["p_hashes"]
            return ok(1)
        if table == "posts" and method == "GET":
            authors = query["author_id"][0].removeprefix("in.(").removesuffix(")").split(",")
            return ok([p for p in self.posts if p["author_id"] in authors])
        if table == "posts" and method == "POST":
            uid = self._user_for(headers)
            assert data["author_id"] == uid, "posts must be written as their author"
            if data.get("booth_vendor_id") and self.claims.get(data["booth_vendor_id"]) != uid:
                return 400, b'{"message":"only the booth\'s claimer can post to it"}'
            row = {**data, "id": self._id()}
            self.posts.append(row)
            return ok([{"id": row["id"]}], 201)
        if table == "posts" and method == "PATCH":
            post_id = query["id"][0].removeprefix("eq.")
            next(p for p in self.posts if p["id"] == post_id).update(data)
            return ok(None, 204)
        if table == "post_media" and method == "GET":
            post_id = query["post_id"][0].removeprefix("eq.")
            return ok([m for m in self.media if m["post_id"] == post_id])
        if table == "booth_events" and method == "GET":
            rows = [e for e in self.booth_events if e["event_id"] == seed.EVENT_ID]
            if "kind" in query:
                rows = [e for e in rows if e["kind"] == query["kind"][0].removeprefix("eq.")]
            if "created_at" in query:
                since = query["created_at"][0].removeprefix("gt.")
                rows = [e for e in rows if e["created_at"] > since]
            return ok(rows)
        if table == "booth_events" and method == "POST":
            self.booth_events.extend(data)
            return ok(None, 201)
        if table == "event_presence" and method == "POST":
            for row in data:
                self.presence[(row["event_id"], row["user_id"])] = row["last_seen"]
            return ok(None, 201)
        if method == "DELETE":
            self.deleted_paths.append(unquote(f"{table}?{parsed.query}"))
            return ok([])
        raise AssertionError(f"unexpected {method} {url}")

    def _delete_user(self, uid):
        self.auth_users.pop(uid, None)
        self.profiles.pop(uid, None)
        self.claims = {v: u for v, u in self.claims.items() if u != uid}
        ids = {p["id"] for p in self.posts if p["author_id"] == uid}
        self.posts = [p for p in self.posts if p["author_id"] != uid]
        self.media = [m for m in self.media if m["post_id"] not in ids]
        self.booth_events = [e for e in self.booth_events if e["viewer_id"] != uid]
        self.presence = {k: v for k, v in self.presence.items() if k[1] != uid}


class FailingAccountDelete(FakeStaging):
    def __call__(self, method, url, headers, body):
        if urlparse(url).path == "/api/v1/account/delete":
            return 502, b'{"error":"bucket down"}'
        return super().__call__(method, url, headers, body)


class SeedTestBase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.maps = Path(tmp.name) / "maps"
        self.maps.mkdir()
        for name in ("hawaii-2026-10.json", "hawaii-2026-10.png", "hawaii-2026-10-base.png"):
            shutil.copyfile(HAWAII.parent / name, self.maps / name)
        self.output: list[str] = []
        self.fake = FakeStaging()

    def seeder(self, fake: FakeStaging | None = None) -> seed.Seeder:
        return seed.Seeder(
            _config(), fake or self.fake, maps_dir=self.maps, now=lambda: NOW, out=self.output.append
        )

    def assert_no_secrets(self) -> None:
        text = "\n".join(self.output)
        for secret in (SERVICE_KEY, ANON_KEY, OPS_TOKEN, "jwt-"):
            self.assertNotIn(secret, text)
        for password in self.fake.passwords.values():
            self.assertNotIn(password, text)


class GuardTests(unittest.TestCase):
    def test_staging_passes(self) -> None:
        seed.guard_staging(STAGING_SUPABASE, STAGING_API)

    def test_refuses_production_and_strangers(self) -> None:
        bad = [
            (f"https://{seed.PRODUCTION_REF}.supabase.co", STAGING_API),
            (f"https://{seed.STAGING_REF}.supabase.co.evil.com", STAGING_API),
            ("https://example.supabase.co", STAGING_API),
            (STAGING_SUPABASE, f"https://{seed.PRODUCTION_API_HOST}"),
            (STAGING_SUPABASE, f"http://{seed.STAGING_API_HOST}"),
            (STAGING_SUPABASE, "http://127.0.0.1:8788"),
            (STAGING_SUPABASE, ""),
        ]
        for supabase_url, api in bad:
            with self.subTest(supabase_url=supabase_url, api=api):
                with self.assertRaises(seed.SeedError):
                    seed.guard_staging(supabase_url, api)

    def test_seeder_refuses_a_production_config(self) -> None:
        config = seed.Config(f"https://{seed.PRODUCTION_REF}.supabase.co", "k", "a", STAGING_API, "t")
        with self.assertRaises(seed.SeedError):
            seed.Seeder(config, lambda *a: (200, b""))

    def test_eas_staging_profile_matches_the_hardcoded_targets(self) -> None:
        env = seed.eas_staging_env()
        self.assertEqual(urlparse(env["EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL"]).hostname, seed.STAGING_API_HOST)
        self.assertIn(seed.STAGING_REF, env["EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL"])

    def test_load_config_reads_env_files_and_guards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            backend = Path(tmp)
            (backend / ".env.staging").write_text(f"SUPABASE_URL={STAGING_SUPABASE}\n")
            (backend / ".env.staging.secrets").write_text(
                f"SUPABASE_SERVICE_ROLE_KEY={SERVICE_KEY}\nSPOTLIGHT_OPS_REFRESH_TOKEN={OPS_TOKEN}\n"
            )
            config = seed.load_config(backend)
            self.assertEqual(config.api_base, STAGING_API)
            self.assertTrue(config.anon_key)  # falls back to eas.json
            (backend / ".env.staging").write_text(f"SUPABASE_URL=https://{seed.PRODUCTION_REF}.supabase.co\n")
            with self.assertRaises(seed.SeedError):
                seed.load_config(backend)
            (backend / ".env.staging").write_text(f"SUPABASE_URL={STAGING_SUPABASE}\n")
            (backend / ".env.staging.secrets").write_text(f"SUPABASE_SERVICE_ROLE_KEY={SERVICE_KEY}\n")
            with self.assertRaisesRegex(seed.SeedError, "SPOTLIGHT_OPS_REFRESH_TOKEN"):
                seed.load_config(backend)

    def test_transport_never_reaches_another_host(self) -> None:
        seeder = seed.Seeder(_config(), lambda *a: (200, b""), out=lambda line: None)
        with self.assertRaises(seed.SeedError):
            seeder._call("GET", "https://lvnjshymwvagwadqeofm.supabase.co/rest/v1/posts", {})

    def test_gitignore_covers_the_map_files(self) -> None:
        self.assertIn("backend/data/spotlight_event_maps/ekalight-test-show*", (REPO_ROOT / ".gitignore").read_text())


class BuilderTests(unittest.TestCase):
    def test_event_is_in_its_booth_window_and_valid(self) -> None:
        import spotlight_events

        event = seed.build_event(NOW)
        self.assertEqual((event["startDate"], event["endDate"]), ("2026-10-31", "2026-11-01"))
        stored = spotlight_events.validate_event(event)
        self.assertEqual(spotlight_events.event_status(stored, NOW), "live")
        # 11pm Pacific is already tomorrow in UTC: still today's show in LA.
        late = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)
        self.assertEqual(seed.show_dates(late)[0], "2026-10-31")

    def test_map_reuses_hawaii_tables_with_test_vendors(self) -> None:
        source = json.loads(HAWAII.read_text())
        document = seed.build_map(source, "2026-10-31T20:00:00Z")
        table_ids = {t["id"] for t in source["tables"]}
        self.assertEqual(len(document["vendors"]), 20)
        used = [t for v in document["vendors"] for t in v["tableIds"]]
        self.assertEqual(len(used), len(set(used)))
        self.assertTrue(set(used) <= table_ids)
        self.assertTrue(all(v["id"].startswith("test-") for v in document["vendors"]))
        self.assertEqual(document["vector"]["baseImageFile"], "ekalight-test-show-base.png")
        self.assertEqual(document["imageFile"], "ekalight-test-show.png")

    def test_fixture_consistency(self) -> None:
        claimed = [u.claims for u in seed.MOCK_USERS if u.claims]
        self.assertEqual(len(claimed), 5)
        self.assertNotIn(seed.ME_VENDOR, claimed)
        self.assertTrue(set(claimed) <= set(seed.VENDOR_IDS))
        self.assertTrue(all(p.images <= 4 for p in seed.POSTS))
        for user in seed.MOCK_USERS:
            self.assertRegex(user.handle, r"^[a-z0-9][a-z0-9_]{2,19}$")
            self.assertTrue(user.email.endswith("@ekalight.test"))
        for post in seed.POSTS:
            if post.vendor:
                self.assertEqual(next(u.claims for u in seed.MOCK_USERS if u.n == post.user), post.vendor)

    def test_history_never_counts_the_claimer_and_stays_out_of_the_heat_window(self) -> None:
        ids = {u.n: f"uid-{u.n}" for u in seed.MOCK_USERS}
        rows = seed.history_events(ids, NOW)
        self.assertGreater(len(rows), 100)
        claimer = {u.claims: f"uid-{u.n}" for u in seed.MOCK_USERS if u.claims}
        cutoff = (NOW - timedelta(minutes=31)).isoformat()
        for row in rows:
            self.assertNotEqual(row["viewer_id"], claimer.get(row["vendor_id"]))
            self.assertLess(row["created_at"], cutoff)
        self.assertEqual(rows, seed.history_events(ids, NOW))  # deterministic

    def test_placeholder_jpeg_is_a_jpeg(self) -> None:
        data = seed.placeholder_jpeg("Test Vendor Slabs", 0)
        self.assertTrue(data.startswith(b"\xff\xd8"))
        self.assertLess(len(data), 1_000_000)


class PlanTests(SeedTestBase):
    def test_plan_is_read_only_and_reports_missing_migrations(self) -> None:
        fake = FakeStaging(has_29=False)
        self.fake = fake
        self.seeder(fake).plan("me@example.com")
        self.assertTrue(all(method == "GET" for method, _ in fake.calls), fake.calls)
        text = "\n".join(self.output)
        self.assertIn("would create", text)
        self.assertIn("mock accounts: 0/8 exist", text)
        self.assertIn("social_29 missing", text)
        self.assertIn("SKIPPED: no social_29", text)
        self.assertIn("needs a staging backend deploy", text)
        self.assertEqual(list(self.maps.glob("ekalight-test-show*")), [])
        self.assert_no_secrets()


class ApplyTests(SeedTestBase):
    def test_apply_seeds_everything_and_is_idempotent(self) -> None:
        self.seeder().apply("Me@Example.com ")
        fake = self.fake
        self.assertEqual(len(fake.auth_users), 8)
        self.assertEqual({p.get("handle") for p in fake.profiles.values()}, {u.handle for u in seed.MOCK_USERS})
        self.assertEqual(len(fake.claims), 5)
        self.assertEqual(len(fake.posts), len(seed.POSTS))
        self.assertEqual(sum(1 for p in fake.posts if p.get("booth_vendor_id")), 5)
        self.assertTrue(all(p["event_id"] == seed.EVENT_ID for p in fake.posts))
        self.assertTrue(all(p.get("created_at") for p in fake.posts))
        self.assertEqual(len(fake.media), sum(p.images for p in seed.POSTS))
        self.assertEqual(fake.vendor_emails, {seed.ME_VENDOR: [seed.email_sha256("me@example.com")]})
        self.assertEqual(len(fake.presence), 8)
        self.assertIn(seed.EVENT_ID, fake.admin_events)
        hot = [e for e in fake.booth_events if e["created_at"] > (NOW - timedelta(minutes=30)).isoformat()]
        for vendor in seed.HOT_VENDORS:
            self.assertGreaterEqual(len({e["viewer_id"] for e in hot if e["vendor_id"] == vendor}), 3)
        for name in ("ekalight-test-show.json", "ekalight-test-show.png", "ekalight-test-show-base.png"):
            self.assertTrue((self.maps / name).is_file(), name)
        self.assertTrue(any((self.maps / "ekalight-test-show-logos").glob("*.webp")))
        self.assertIn("NEXT", "\n".join(self.output))

        counts = (len(fake.auth_users), len(fake.posts), len(fake.media), len(fake.booth_events), len(fake.claims))
        self.seeder().apply()
        self.assertEqual(
            (len(fake.auth_users), len(fake.posts), len(fake.media), len(fake.booth_events), len(fake.claims)),
            counts,
        )
        self.assert_no_secrets()

    def test_apply_finishes_missing_images_on_rerun(self) -> None:
        self.seeder().apply()
        self.fake.media = self.fake.media[:-1]
        self.seeder().apply()
        self.assertEqual(len(self.fake.media), sum(p.images for p in seed.POSTS))

    def test_taken_booth_skips_that_vendors_posts(self) -> None:
        self.fake.claims["test-slabs"] = "someone-else"
        self.seeder().apply()
        self.assertFalse(any(p.get("booth_vendor_id") == "test-slabs" for p in self.fake.posts))
        self.assertIn("taken", "\n".join(self.output))

    def test_me_email_skipped_without_social_29(self) -> None:
        self.fake = FakeStaging(has_29=False)
        self.seeder().apply("me@example.com")
        self.assertEqual(self.fake.vendor_emails, {})
        self.assertIn("--me-email skipped", "\n".join(self.output))

    def test_refresh_live_alone_restamps_without_duplicating_recent_opens(self) -> None:
        self.seeder().apply()
        before = len(self.fake.booth_events)
        self.fake.presence.clear()
        self.seeder().refresh_live()
        self.assertEqual(len(self.fake.presence), 8)
        self.assertEqual(len(self.fake.booth_events), before)  # opens < 10 min old already count

    def test_refresh_live_without_seed_fails_clearly(self) -> None:
        with self.assertRaisesRegex(seed.SeedError, "run --apply first"):
            self.seeder().refresh_live()


class CleanupTests(SeedTestBase):
    def test_cleanup_removes_accounts_rows_show_and_local_files(self) -> None:
        self.seeder().apply("me@example.com")
        self.output.clear()
        self.seeder().cleanup()
        fake = self.fake
        self.assertEqual(fake.auth_users, {})
        self.assertEqual(fake.posts, [])
        self.assertEqual(fake.claims, {})
        self.assertNotIn(seed.EVENT_ID, fake.admin_events)
        self.assertIn(("POST", "/api/v1/account/delete"), fake.calls)
        deleted = "\n".join(fake.deleted_paths)
        for needle in (
            f"posts?event_id=eq.{seed.EVENT_ID}",
            "booth_claims?vendor_id=in.(test-slabs,",
            f"booth_events?event_id=eq.{seed.EVENT_ID}",
            f"event_presence?event_id=eq.{seed.EVENT_ID}",
            f"notifications?type=eq.booth_recap&payload->>event_id=eq.{seed.EVENT_ID}",
            f"booth_vendor_emails?event_id=eq.{seed.EVENT_ID}",
        ):
            self.assertIn(needle, deleted)
        # Every vendor delete is scoped to the explicit test ids, never a pattern.
        for path in fake.deleted_paths:
            if "vendor_id=" in path:
                ids = re.search(r"vendor_id=in\.\(([^)]*)\)", path).group(1).split(",")
                self.assertTrue(all(i.startswith("test-") for i in ids))
        self.assertEqual(list(self.maps.glob("ekalight-test-show*")), [])
        self.assertTrue((self.maps / "hawaii-2026-10.json").is_file())
        self.assertIn("rm -rf ~/spotlight/data/spotlight_event_maps/ekalight-test-show*", "\n".join(self.output))
        self.assert_no_secrets()

    def test_cleanup_falls_back_to_auth_admin_delete(self) -> None:
        self.fake = FailingAccountDelete()
        self.seeder().apply()
        self.seeder().cleanup()
        self.assertEqual(self.fake.auth_users, {})
        self.assertIn("deleting the auth user directly", "\n".join(self.output))

    def test_cleanup_on_empty_staging_is_a_noop(self) -> None:
        self.seeder().cleanup()
        self.assertIn("0 mock accounts deleted", "\n".join(self.output))


if __name__ == "__main__":
    unittest.main()
