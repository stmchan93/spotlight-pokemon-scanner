"""tools/sync_vendor_email_hashes.py + the social_29 migration it targets (no network)."""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools import sync_vendor_email_hashes as sync  # noqa: E402

MIGRATION = REPO_ROOT / "apps/spotlight-rn/supabase/migrations/20261031090100_social_29_booth_match_heat.sql"
STAGING_URL = "https://mphjenaaorntwkyivqtm.supabase.co"
H1 = "1" * 64
H2 = "2" * 64


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SyncVendorEmailHashesTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.maps = self.root / "maps"
        self.maps.mkdir()
        (self.maps / "show.json").write_text(json.dumps({"vendors": [{"id": "main-street"}, {"id": "chazer"}]}))
        self._sidecar({"main-street": [H2, H1, H1], "chazer": []})
        self.backend = self.root / "backend"
        self.backend.mkdir()
        (self.backend / ".env.staging").write_text(f"SUPABASE_URL={STAGING_URL}/\n")
        (self.backend / ".env.staging.secrets").write_text("# secrets\nSUPABASE_SERVICE_ROLE_KEY='svc-key'\n")
        patcher = mock.patch.object(sync, "BACKEND", self.backend)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _sidecar(self, vendors: dict, event_id: str = "show") -> None:
        (self.maps / "show.vendor-emails.json").write_text(json.dumps({"eventId": event_id, "vendors": vendors}))

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = sync.main(["--event-id", "show", "--maps-dir", str(self.maps), *args])
        return code, out.getvalue(), err.getvalue()

    def test_load_dedupes_and_drops_empty(self) -> None:
        self.assertEqual(sync.load_sidecar("show", self.maps), {"main-street": [H1, H2]})

    def test_rejects_plaintext_unknown_vendors_and_wrong_show(self) -> None:
        for vendors, event_id in (
            ({"main-street": ["pat@example.com"]}, "show"),
            ({"ghost": [H1]}, "show"),
            ({"main-street": [H1]}, "other-show"),
        ):
            with self.subTest(vendors=vendors, event_id=event_id):
                self._sidecar(vendors, event_id)
                with self.assertRaises(sync.SyncError):
                    sync.load_sidecar("show", self.maps)

    def test_credentials_from_env_then_secrets_with_project_guard(self) -> None:
        self.assertEqual(sync.supabase_credentials("staging", self.backend), (STAGING_URL, "svc-key"))
        (self.backend / ".env.staging").write_text("SUPABASE_URL=https://lvnjshymwvagwadqeofm.supabase.co\n")
        with self.assertRaisesRegex(sync.SyncError, "not the staging project"):
            sync.supabase_credentials("staging", self.backend)

    def test_dry_run_sends_nothing(self) -> None:
        with mock.patch.object(sync, "urlopen") as urlopen:
            code, out, _ = self._run("--env", "staging", "--dry-run")
        self.assertEqual(code, 0)
        urlopen.assert_not_called()
        self.assertIn("1 vendors, 2 email hashes", out)
        self.assertNotIn(H1, out)

    def test_replaces_the_show_through_the_rpc(self) -> None:
        seen: list = []

        def fake_urlopen(request, timeout=None):
            seen.append(request)
            return _Response(b"2")

        with mock.patch.object(sync, "urlopen", side_effect=fake_urlopen):
            code, out, _ = self._run("--env", "staging")
        self.assertEqual(code, 0)
        (request,) = seen
        self.assertEqual(request.full_url, f"{STAGING_URL}/rest/v1/rpc/replace_booth_vendor_emails")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Authorization"], "Bearer svc-key")
        self.assertEqual(json.loads(request.data), {"p_event_id": "show", "p_hashes": {"main-street": [H1, H2]}})
        self.assertIn("2 rows", out)
        self.assertNotIn("svc-key", out)

    def test_http_error_is_reported(self) -> None:
        error = HTTPError("u", 401, "no", {}, io.BytesIO(b'{"message":"service role only"}'))
        with mock.patch.object(sync, "urlopen", side_effect=error):
            code, _, err = self._run("--env", "staging")
        self.assertEqual(code, 1)
        self.assertIn("supabase 401", err)

    def test_production_needs_the_per_invocation_confirm(self) -> None:
        with mock.patch.object(sync, "urlopen") as urlopen, mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("SPOTLIGHT_PROD_CONFIRM", None)
            code, _, err = self._run("--env", "production")
        self.assertEqual(code, 1)
        self.assertIn("SPOTLIGHT_PROD_CONFIRM", err)
        urlopen.assert_not_called()


class Social29MigrationTests(unittest.TestCase):
    """Static guards on the SQL (there is no Postgres in the test run)."""

    sql = MIGRATION.read_text(encoding="utf-8")

    def test_email_table_has_rls_and_no_policies(self) -> None:
        self.assertIn("alter table public.booth_vendor_emails enable row level security", self.sql)
        self.assertNotRegex(self.sql, r"create policy[^;]*booth_vendor_emails")
        self.assertIn("revoke all on table public.booth_vendor_emails from public, anon, authenticated", self.sql)

    def test_suggest_matches_only_the_callers_jwt_email_and_returns_ids(self) -> None:
        body = re.search(r"function public\.suggest_my_booth.*?\$\$(.*?)\$\$", self.sql, re.S)
        assert body is not None
        self.assertIn("returns setof text", self.sql.split("function public.suggest_my_booth")[1][:120])
        self.assertIn("digest(lower(trim(auth.jwt()->>'email')), 'sha256')", body.group(1))
        self.assertNotIn("email_sha256,", body.group(1).split("from")[0])
        self.assertIn("grant execute on function public.suggest_my_booth(text) to authenticated", self.sql)

    def test_replace_is_service_role_only(self) -> None:
        self.assertIn("revoke all on function public.replace_booth_vendor_emails(text, jsonb) from public, anon, authenticated", self.sql)
        self.assertIn("grant execute on function public.replace_booth_vendor_emails(text, jsonb) to service_role", self.sql)
        self.assertIn("auth.role(), '') <> 'service_role'", self.sql)

    def test_hot_booths_threshold_window_and_no_counts(self) -> None:
        body = self.sql.split("function public.event_hot_booths")[1]
        self.assertIn("returns setof text", body[:120])
        self.assertIn("interval '30 minutes'", body)
        self.assertIn("count(distinct e.viewer_id) >= 3", body)
        self.assertIn("limit 10", body)


if __name__ == "__main__":
    unittest.main()
