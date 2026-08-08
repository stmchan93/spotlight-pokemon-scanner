"""Admin moderation queue — the HUMAN half of App Store Guideline 1.2.

Community reports land in Supabase ``public.reports`` (social_04). The report
threshold trigger hides content and ``backend/social_moderation_worker.py``
refuses to release a ``pending`` row while an open report exists — both are
waiting on a person. These tests cover that person's surface:

  GET  /api/v1/moderation/queue   — reviewer-gated, shaped rows
  POST /api/v1/moderation/action  — reviewer-gated, remove / keep / dismiss

Supabase is mocked at the privileged-REST seam (``_supabase_rest_select`` /
``_supabase_rest_patch`` / ``_supabase_rest_insert``) in the same style as
``test_social_moderation_worker`` and ``test_post_media_serving`` — no live
database, and the tests assert the exact writes each verb performs.
"""

from __future__ import annotations

import io
import json
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from request_auth import RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    REVIEWER_EMAILS_ENV,
    REVIEWER_USER_IDS_ENV,
    SpotlightRequestHandler,
)


REVIEWER_USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
OUTSIDER_USER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
REPORTER_USER_ID = "cccccccc-3333-4333-8333-cccccccccccc"
AUTHOR_USER_ID = "dddddddd-4444-4444-8444-dddddddddddd"

POST_ID = "11111111-2222-4333-8444-555555555555"
COMMENT_ID = "22222222-3333-4444-8555-666666666666"
MEDIA_ID = "33333333-4444-4555-8666-777777777777"
POST_REPORT_ID = "44444444-5555-4666-8777-888888888888"
COMMENT_REPORT_ID = "55555555-6666-4777-8888-999999999999"
SECOND_POST_REPORT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa"


# --- handler plumbing --------------------------------------------------------


def make_handler(
    *, path: str, body: dict | None = None, method: str = "GET"
) -> tuple[SpotlightRequestHandler, dict]:
    """A handler wired for one request, plus the dict its writes land in."""
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = path
    handler.service = Mock()
    handler.service.post_media_store = None
    raw = json.dumps(body or {}).encode("utf-8") if method == "POST" else b""
    handler.headers = {
        "Authorization": "Bearer caller-jwt",
        "Content-Length": str(len(raw)),
    }
    handler.rfile = io.BytesIO(raw)
    captured: dict = {}

    def write_json(status: HTTPStatus, payload: dict) -> None:
        captured["status"] = status
        captured["payload"] = payload

    handler._write_json = write_json  # type: ignore[method-assign]
    handler._write_html = lambda status, html: captured.update(  # type: ignore[method-assign]
        {"status": status, "html": html}
    )
    return handler, captured


def as_reviewer(handler: SpotlightRequestHandler, user_id: str = REVIEWER_USER_ID) -> None:
    handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
        user_id=user_id, auth_source="test"
    )


REVIEWER_ENV = {REVIEWER_USER_IDS_ENV: REVIEWER_USER_ID, REVIEWER_EMAILS_ENV: ""}


# --- fake Supabase rows ------------------------------------------------------


def report_row(
    report_id: str,
    target_type: str,
    target_id: str,
    *,
    reason: str = "spam",
    status: str = "open",
    reporter_id: str = REPORTER_USER_ID,
    created_at: str = "2026-08-07T12:00:00+00:00",
) -> dict:
    return {
        "id": report_id,
        "reporter_id": reporter_id,
        "target_type": target_type,
        "target_id": target_id,
        "reason": reason,
        "status": status,
        "reviewed_by": None,
        "reviewed_at": None,
        "created_at": created_at,
    }


def make_fake_select(
    *,
    reports: list[dict] | None = None,
    open_reports: list[dict] | None = None,
    posts: list[dict] | None = None,
    comments: list[dict] | None = None,
    media: list[dict] | None = None,
    profiles: list[dict] | None = None,
    unreadable: set[str] | None = None,
):
    """Stand-in for the privileged PostgREST reads the queue performs."""
    reports = reports or []
    open_reports = open_reports if open_reports is not None else list(reports)
    posts = posts or []
    comments = comments or []
    media = media or []
    profiles = profiles or []
    unreadable = unreadable or set()
    calls: list[tuple[str, dict]] = []

    def _select(table: str, params: dict):
        calls.append((table, dict(params)))
        if table in unreadable:
            return None
        if table == "reports":
            # The page read filters on status; the tally read filters on
            # target_id + status=eq.open.
            if "target_id" in params:
                return [dict(r) for r in open_reports]
            wanted = str(params.get("status", "")).removeprefix("eq.")
            return [dict(r) for r in reports if r["status"] == wanted]
        if table == "posts":
            return [dict(r) for r in posts]
        if table == "comments":
            return [dict(r) for r in comments]
        if table == "post_media":
            return [dict(r) for r in media]
        if table == "user_profiles":
            return [dict(r) for r in profiles]
        raise AssertionError(f"unexpected table: {table}")

    _select.calls = calls  # type: ignore[attr-defined]
    return _select


class _WriteRecorder:
    """Records every privileged PATCH/INSERT the action endpoint performs."""

    def __init__(self, *, patch_rows: dict[str, list[dict]] | None = None) -> None:
        self.patches: list[tuple[str, dict, dict]] = []
        self.inserts: list[tuple[str, dict]] = []
        self._patch_rows = patch_rows or {}

    def patch(self, table: str, params: dict, payload: dict):
        self.patches.append((table, dict(params), dict(payload)))
        return self._patch_rows.get(table, [{"id": "row"}])

    def insert(self, table: str, payload: dict):
        self.inserts.append((table, dict(payload)))
        return [{"id": "audit"}]

    def install(self, handler: SpotlightRequestHandler) -> None:
        handler._supabase_rest_patch = self.patch  # type: ignore[method-assign]
        handler._supabase_rest_insert = self.insert  # type: ignore[method-assign]

    def patched_tables(self) -> list[str]:
        return [table for table, _params, _payload in self.patches]

    def patch_for(self, table: str) -> tuple[dict, dict]:
        for name, params, payload in self.patches:
            if name == table:
                return params, payload
        raise AssertionError(f"no PATCH recorded for {table}: {self.patched_tables()}")


# --- the gate ----------------------------------------------------------------


class ModerationGateTests(unittest.TestCase):
    """Authorization is decided in Python by `_require_reviewer`, never by the
    browser and never by Supabase RLS (the service-role key bypasses it)."""

    @patch.dict("os.environ", REVIEWER_ENV, clear=False)
    def test_queue_rejects_a_non_reviewer_with_403(self) -> None:
        handler, captured = make_handler(path="/api/v1/moderation/queue")
        as_reviewer(handler, OUTSIDER_USER_ID)
        touched = Mock()
        handler._supabase_rest_select = touched  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        # A denied caller must not even cause a Supabase read.
        touched.assert_not_called()

    @patch.dict("os.environ", REVIEWER_ENV, clear=False)
    def test_action_rejects_a_non_reviewer_with_403(self) -> None:
        handler, captured = make_handler(
            path="/api/v1/moderation/action",
            method="POST",
            body={"action": "remove", "targetType": "post", "targetId": POST_ID},
        )
        as_reviewer(handler, OUTSIDER_USER_ID)
        recorder = _WriteRecorder()
        recorder.install(handler)
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        self.assertEqual(recorder.patches, [])
        self.assertEqual(recorder.inserts, [])

    @patch.dict(
        "os.environ",
        {REVIEWER_USER_IDS_ENV: "", REVIEWER_EMAILS_ENV: "mod@example.com"},
        clear=False,
    )
    def test_email_allowlist_also_admits(self) -> None:
        handler, captured = make_handler(path="/api/v1/moderation/queue")
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=OUTSIDER_USER_ID, auth_source="test", email="mod@example.com"
        )
        handler._supabase_rest_select = make_fake_select()  # type: ignore[method-assign]
        handler.do_GET()

        self.assertEqual(captured["status"], HTTPStatus.OK)


# --- the queue ---------------------------------------------------------------


class ModerationQueueTests(unittest.TestCase):
    @patch.dict("os.environ", REVIEWER_ENV, clear=False)
    def _run_queue(self, path: str = "/api/v1/moderation/queue", **select_kwargs):
        handler, captured = make_handler(path=path)
        as_reviewer(handler)
        select = make_fake_select(**select_kwargs)
        handler._supabase_rest_select = select  # type: ignore[method-assign]
        handler.do_GET()
        return captured, select

    def test_empty_queue_is_a_clean_empty_page(self) -> None:
        captured, _ = self._run_queue()
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"]["items"], [])
        self.assertEqual(captured["payload"]["count"], 0)
        self.assertEqual(captured["payload"]["status"], "open")

    def test_returns_shaped_rows_with_target_author_and_media(self) -> None:
        captured, _ = self._run_queue(
            reports=[report_row(POST_REPORT_ID, "post", POST_ID, reason="nudity")],
            open_reports=[
                report_row(POST_REPORT_ID, "post", POST_ID),
                report_row(
                    SECOND_POST_REPORT_ID,
                    "post",
                    POST_ID,
                    reporter_id=OUTSIDER_USER_ID,
                ),
            ],
            posts=[
                {
                    "id": POST_ID,
                    "author_id": AUTHOR_USER_ID,
                    "body": "bad post",
                    "card_id": None,
                    "content_status": "pending",
                    "moderation_checked_at": None,
                    "created_at": "2026-08-06T10:00:00+00:00",
                    "deleted_at": None,
                }
            ],
            media=[
                {
                    "id": MEDIA_ID,
                    "post_id": POST_ID,
                    "storage_path": "posts/2026/08/x.jpg",
                    "moderation_status": "pending",
                    "position": 0,
                    "created_at": "2026-08-06T10:00:00+00:00",
                }
            ],
            profiles=[
                {"user_id": AUTHOR_USER_ID, "handle": "author", "display_name": "Author"},
                {"user_id": REPORTER_USER_ID, "handle": "reporter", "display_name": "Reporter"},
            ],
        )

        self.assertEqual(captured["status"], HTTPStatus.OK)
        items = captured["payload"]["items"]
        self.assertEqual(len(items), 1)
        item = items[0]

        # The report row itself.
        self.assertEqual(item["report_id"], POST_REPORT_ID)
        self.assertEqual(item["reason"], "nudity")
        self.assertEqual(item["target_type"], "post")
        self.assertEqual(item["target_id"], POST_ID)
        self.assertEqual(item["created_at"], "2026-08-07T12:00:00+00:00")
        self.assertEqual(item["reporter"]["handle"], "reporter")

        # The content behind it.
        target = item["target"]
        self.assertFalse(item["target_missing"])
        self.assertEqual(target["kind"], "post")
        self.assertEqual(target["body"], "bad post")
        self.assertEqual(target["content_status"], "pending")
        self.assertEqual(target["author"]["handle"], "author")
        self.assertEqual(target["author"]["display_name"], "Author")

        # Media with its own moderation status, behind the reviewer-gated proxy.
        self.assertEqual(len(target["media"]), 1)
        self.assertEqual(target["media"][0]["moderation_status"], "pending")
        self.assertEqual(
            target["media"][0]["url"], f"/api/v1/moderation/media/{MEDIA_ID}"
        )

        # Two DISTINCT reporters have this target open — the pile-on signal.
        self.assertEqual(item["open_report_count"], 2)

    def test_comment_target_carries_its_parent_post_id(self) -> None:
        captured, _ = self._run_queue(
            reports=[report_row(COMMENT_REPORT_ID, "comment", COMMENT_ID)],
            comments=[
                {
                    "id": COMMENT_ID,
                    "post_id": POST_ID,
                    "author_id": AUTHOR_USER_ID,
                    "body": "bad comment",
                    "content_status": "visible",
                    "moderation_checked_at": None,
                    "created_at": "2026-08-06T11:00:00+00:00",
                    "deleted_at": None,
                }
            ],
        )
        target = captured["payload"]["items"][0]["target"]
        self.assertEqual(target["kind"], "comment")
        self.assertEqual(target["post_id"], POST_ID)
        self.assertEqual(target["body"], "bad comment")

    def test_report_whose_target_vanished_still_appears(self) -> None:
        # A hard-deleted target must not silently drop the report off the queue
        # — otherwise it stays `open` forever with nobody able to see it.
        captured, _ = self._run_queue(
            reports=[report_row(POST_REPORT_ID, "post", POST_ID)],
            posts=[],
        )
        item = captured["payload"]["items"][0]
        self.assertIsNone(item["target"])
        self.assertTrue(item["target_missing"])

    def test_limit_is_clamped_and_passed_to_supabase(self) -> None:
        _captured, select = self._run_queue(
            path="/api/v1/moderation/queue?limit=99999"
        )
        table, params = select.calls[0]
        self.assertEqual(table, "reports")
        self.assertEqual(params["limit"], "200")
        self.assertEqual(params["order"], "created_at.desc")

    def test_status_filter_is_forwarded(self) -> None:
        captured, select = self._run_queue(
            path="/api/v1/moderation/queue?status=dismissed",
            reports=[report_row(POST_REPORT_ID, "post", POST_ID, status="dismissed")],
            posts=[],
        )
        self.assertEqual(captured["payload"]["status"], "dismissed")
        self.assertEqual(select.calls[0][1]["status"], "eq.dismissed")

    @patch.dict("os.environ", REVIEWER_ENV, clear=False)
    def test_unknown_status_is_a_400(self) -> None:
        handler, captured = make_handler(
            path="/api/v1/moderation/queue?status=banana"
        )
        as_reviewer(handler)
        handler._supabase_rest_select = make_fake_select()  # type: ignore[method-assign]
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)

    @patch.dict("os.environ", REVIEWER_ENV, clear=False)
    def test_unreadable_supabase_is_a_500_not_an_empty_queue(self) -> None:
        # "Supabase is down" must never render as "no reports to review".
        handler, captured = make_handler(path="/api/v1/moderation/queue")
        as_reviewer(handler)
        handler._supabase_rest_select = lambda table, params: None  # type: ignore[method-assign]
        with patch("server.traceback.print_exc"):
            handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.INTERNAL_SERVER_ERROR)


# --- the action verbs --------------------------------------------------------


class ModerationActionTests(unittest.TestCase):
    def _run_action(self, body: dict, *, patch_rows=None):
        with patch.dict("os.environ", REVIEWER_ENV, clear=False):
            handler, captured = make_handler(
                path="/api/v1/moderation/action", method="POST", body=body
            )
            as_reviewer(handler)
            recorder = _WriteRecorder(patch_rows=patch_rows)
            recorder.install(handler)
            handler.do_POST()
        return captured, recorder

    def test_remove_sets_content_removed_and_actions_the_reports(self) -> None:
        captured, recorder = self._run_action(
            {"action": "remove", "targetType": "post", "targetId": POST_ID}
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)

        post_params, post_payload = recorder.patch_for("posts")
        self.assertEqual(post_params, {"id": f"eq.{POST_ID}"})
        self.assertEqual(post_payload, {"content_status": "removed"})

        report_params, report_payload = recorder.patch_for("reports")
        self.assertEqual(
            report_params,
            {"target_type": "eq.post", "target_id": f"eq.{POST_ID}", "status": "eq.open"},
        )
        self.assertEqual(report_payload["status"], "actioned")
        self.assertEqual(report_payload["reviewed_by"], REVIEWER_USER_ID)
        self.assertTrue(report_payload["reviewed_at"])

        # Removing a post also pulls its images out of the media proxy.
        media_params, media_payload = recorder.patch_for("post_media")
        self.assertEqual(media_params, {"post_id": f"eq.{POST_ID}"})
        self.assertEqual(media_payload, {"moderation_status": "rejected"})

        # And the whole thing is audited.
        self.assertEqual(len(recorder.inserts), 1)
        table, audit = recorder.inserts[0]
        self.assertEqual(table, "moderation_actions")
        self.assertEqual(audit["action"], "remove")
        self.assertEqual(audit["moderator_id"], REVIEWER_USER_ID)
        self.assertEqual(audit["target_id"], POST_ID)

    def test_keep_republishes_the_content_and_clears_the_hold(self) -> None:
        # This is the path that unblocks social_moderation_worker's `pending`
        # hold: it will not release content while an open report exists.
        captured, recorder = self._run_action(
            {"action": "keep", "targetType": "comment", "targetId": COMMENT_ID}
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)

        params, payload = recorder.patch_for("comments")
        self.assertEqual(params, {"id": f"eq.{COMMENT_ID}"})
        self.assertEqual(payload, {"content_status": "visible"})

        report_params, report_payload = recorder.patch_for("reports")
        self.assertEqual(report_params["status"], "eq.open")
        self.assertEqual(report_payload["status"], "dismissed")
        self.assertEqual(recorder.inserts[0][1]["action"], "approve")
        # A comment has no media of its own to reject.
        self.assertNotIn("post_media", recorder.patched_tables())

    def test_dismiss_resolves_the_report_without_touching_content(self) -> None:
        captured, recorder = self._run_action(
            {
                "action": "dismiss",
                "targetType": "post",
                "targetId": POST_ID,
                "reportId": POST_REPORT_ID,
                "note": "false alarm",
            }
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(recorder.patched_tables(), ["reports"])
        self.assertIsNone(captured["payload"]["content_status"])

        params, payload = recorder.patch_for("reports")
        # Scoped to the ONE report the reviewer dismissed.
        self.assertEqual(params, {"id": f"eq.{POST_REPORT_ID}", "status": "eq.open"})
        self.assertEqual(payload["status"], "dismissed")

        _table, audit = recorder.inserts[0]
        self.assertEqual(audit["action"], "dismiss")
        self.assertEqual(audit["note"], "false alarm")

    def test_unknown_verb_is_a_400_and_writes_nothing(self) -> None:
        captured, recorder = self._run_action(
            {"action": "nuke", "targetType": "post", "targetId": POST_ID}
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertIn("action must be one of", captured["payload"]["error"])
        self.assertEqual(recorder.patches, [])
        self.assertEqual(recorder.inserts, [])

    def test_missing_target_id_is_a_400(self) -> None:
        captured, recorder = self._run_action(
            {"action": "remove", "targetType": "post", "targetId": "not-a-uuid"}
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(recorder.patches, [])

    def test_remove_on_a_target_type_with_no_content_table_is_a_400(self) -> None:
        # `reports.target_type` also accepts message/profile; there is no
        # content_status to flip there, so only `dismiss` is meaningful.
        captured, recorder = self._run_action(
            {"action": "remove", "targetType": "profile", "targetId": AUTHOR_USER_ID}
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(recorder.patches, [])

    def test_content_row_that_does_not_exist_is_a_400_and_leaves_reports_open(self) -> None:
        # Content is written FIRST precisely so this cannot mark a report
        # resolved while the content it was about is untouched.
        captured, recorder = self._run_action(
            {"action": "remove", "targetType": "post", "targetId": POST_ID},
            patch_rows={"posts": []},
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(recorder.patched_tables(), ["posts"])
        self.assertEqual(recorder.inserts, [])

    def test_failed_content_write_is_a_500_and_leaves_reports_open(self) -> None:
        with patch.dict("os.environ", REVIEWER_ENV, clear=False):
            handler, captured = make_handler(
                path="/api/v1/moderation/action",
                method="POST",
                body={"action": "remove", "targetType": "post", "targetId": POST_ID},
            )
            as_reviewer(handler)
            recorder = _WriteRecorder()
            recorder.install(handler)
            handler._supabase_rest_patch = lambda table, params, payload: (  # type: ignore[method-assign]
                None if table == "posts" else recorder.patch(table, params, payload)
            )
            with patch("server.traceback.print_exc"):
                handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(recorder.patches, [])
        self.assertEqual(recorder.inserts, [])

    def test_non_supabase_reviewer_id_is_not_written_to_the_fk_columns(self) -> None:
        # reports.reviewed_by / moderation_actions.moderator_id are FKs to
        # auth.users; a fallback/dev identity must not blow up the action.
        with patch.dict("os.environ", {REVIEWER_USER_IDS_ENV: "local-dev"}, clear=False):
            handler, captured = make_handler(
                path="/api/v1/moderation/action",
                method="POST",
                body={"action": "dismiss", "targetType": "post", "targetId": POST_ID},
            )
            as_reviewer(handler, "local-dev")
            recorder = _WriteRecorder()
            recorder.install(handler)
            handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.OK)
        _params, payload = recorder.patch_for("reports")
        self.assertNotIn("reviewed_by", payload)
        self.assertIsNone(recorder.inserts[0][1]["moderator_id"])


# --- the page ----------------------------------------------------------------


class ModerationPageTests(unittest.TestCase):
    def test_moderation_page_is_served(self) -> None:
        handler, captured = make_handler(path="/moderation")
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertIn("Spotlight Moderation Queue", captured["html"])
        self.assertIn("/api/v1/moderation/queue", captured["html"])

    def test_page_file_exists_next_to_the_review_surface(self) -> None:
        self.assertTrue((BACKEND_ROOT / "review_web" / "moderation.html").is_file())


if __name__ == "__main__":
    unittest.main()
