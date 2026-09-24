"""calendar_feed: expansions + hand-maintained events → CalendarFeed (no network)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import calendar_feed  # noqa: E402
from catalog_tools import SUPPORTED_GAMES, apply_schema, connect, upsert_expansion  # noqa: E402

TODAY = "2026-09-24"
EVENT_KEYS = {"id", "date", "kind", "game", "title", "subtitle", "setId", "url"}


def _event(**overrides):
    row = {
        "id": "op-ban", "date": "2026-10-01", "kind": "ban_list", "game": "onepiece",
        "title": "Ban & restriction update", "subtitle": None, "setId": None,
        "url": "https://en.onepiece-cardgame.com/news/restriction.html",
    }
    row.update(overrides)
    return row


class CalendarFeedTests(unittest.TestCase):
    def setUp(self) -> None:
        calendar_feed.clear_cache()
        self.addCleanup(calendar_feed.clear_cache)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.conn = connect(Path(self.tempdir.name) / "cal.sqlite")
        self.addCleanup(self.conn.close)
        apply_schema(self.conn, BACKEND_ROOT / "schema.sql")
        self.events_path = Path(self.tempdir.name) / "calendar_events.json"
        self._write_events([])

    def _write_events(self, rows, *, wrap: bool = True) -> None:
        calendar_feed.clear_cache()
        self.events_path.write_text(json.dumps({"events": rows} if wrap else rows), encoding="utf-8")

    def _expansion(self, set_id, name, release_date, *, game="pokemon", language=None) -> None:
        upsert_expansion(
            self.conn, expansion_id=set_id, name=name, release_date=release_date,
            language=language, game=game,
        )
        self.conn.commit()

    def _build(self, **kwargs):
        kwargs.setdefault("today", TODAY)
        return calendar_feed.build_calendar_payload(self.conn, events_path=self.events_path, **kwargs)

    def test_merges_expansions_and_events_ascending_upcoming_only(self) -> None:
        self._expansion("me3", "Delta Reign", "2026/11/06")
        self._expansion("me3_ja", "Delta Reign", "2026-10-03", language="ja")
        self._expansion("old", "Old Set", "2026/09/01")  # past
        self._expansion("today", "Today Set", TODAY)  # today counts
        self._write_events([
            _event(),
            _event(id="past", date="2026-09-01", title="Past ban list"),
            _event(id="lorcana-rel", date="2026-10-23", kind="release", game="lorcana",
                   title="Hyperia City", url="https://www.disneylorcana.com/x"),
        ])
        items = self._build()["items"]
        self.assertEqual(
            [(i["date"], i["id"]) for i in items],
            [("2026-09-24", "release:today"), ("2026-10-01", "op-ban"),
             ("2026-10-03", "release:me3_ja"), ("2026-10-23", "lorcana-rel"),
             ("2026-11-06", "release:me3")],
        )
        for item in items:
            self.assertEqual(set(item), EVENT_KEYS)
        jp = next(i for i in items if i["id"] == "release:me3_ja")
        self.assertEqual(
            (jp["kind"], jp["game"], jp["title"], jp["subtitle"], jp["setId"], jp["url"]),
            ("release", "pokemon", "Delta Reign (Japanese)", "New set", "me3_ja", None),
        )
        self.assertEqual(next(i for i in items if i["id"] == "release:me3")["title"], "Delta Reign")

    def test_hand_release_dedupes_into_catalog_set_and_lends_its_url(self) -> None:
        self._expansion("me3", "Delta Reign", "2026/11/06")
        url = "https://www.pokemon.com/us/news/delta-reign"
        self._write_events([
            _event(id="dr", date="2026-11-06", kind="release", game="pokemon",
                   title="Mega Evolution—Delta Reign", url=url),
            _event(id="dr-dup", date="2026-11-06", kind="release", game="pokemon",
                   title="delta reign", url=url),
        ])
        items = self._build()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["id"], items[0]["setId"], items[0]["url"]), ("release:me3", "me3", url))

    def test_same_title_on_a_different_game_or_kind_is_not_a_duplicate(self) -> None:
        self._write_events([
            _event(id="a", game="onepiece", kind="event", title="Bandai Card Games Fest Orlando"),
            _event(id="b", game="gundam", kind="event", title="Bandai Card Games Fest Orlando"),
            _event(id="c", game="gundam", kind="reveal", title="Bandai Card Games Fest Orlando"),
        ])
        self.assertEqual(len(self._build()["items"]), 3)

    def test_game_filter_and_limit(self) -> None:
        self._expansion("op20", "OP-20", "2026-12-01", game="onepiece")
        self._expansion("me3", "Delta Reign", "2026-11-06")
        self._write_events([_event(), _event(id="p", game="pokemon", kind="reveal", title="Presents")])
        onepiece = self._build(game="onepiece")["items"]
        self.assertEqual([i["id"] for i in onepiece], ["op-ban", "release:op20"])
        self.assertEqual(len(self._build(limit=2)["items"]), 2)
        for bad in ({"game": "mtg"}, {"limit": 0}, {"limit": 101}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self._build(**bad)

    def test_invalid_rows_are_skipped_and_logged(self) -> None:
        good = _event()
        bad_rows = [
            "not an object",
            _event(id=""),
            _event(id="d1", date="2026/10/01"),
            _event(id="d2", date="2026-13-40"),
            _event(id="k", kind="tournament"),
            _event(id="g", game="mtg"),
            _event(id="t", title="  "),
            _event(id="u", url=None),
            _event(id="u2", url="ftp://x"),
            _event(id="s", subtitle=5),
            _event(),  # duplicate id
        ]
        self._write_events([good, *bad_rows])
        with self.assertLogs("spotlight.calendar_feed", level="WARNING") as logs:
            events = calendar_feed.load_events(self.events_path)
        self.assertEqual([e["id"] for e in events], ["op-ban"])
        self.assertEqual(len(logs.records), len(bad_rows))

    def test_missing_or_broken_file_serves_catalog_only(self) -> None:
        self._expansion("me3", "Delta Reign", "2026-11-06")
        self.events_path.write_text("{not json", encoding="utf-8")
        calendar_feed.clear_cache()
        with self.assertLogs("spotlight.calendar_feed", level="WARNING"):
            self.assertEqual([i["id"] for i in self._build()["items"]], ["release:me3"])
        self.events_path.unlink()
        calendar_feed.clear_cache()
        self.assertEqual([i["id"] for i in self._build()["items"]], ["release:me3"])
        self._write_events([_event()], wrap=False)  # a bare list is accepted too
        self.assertEqual([i["id"] for i in self._build()["items"]], ["op-ban", "release:me3"])

    def test_shipped_events_file_is_valid_and_sourced(self) -> None:
        raw = json.loads(calendar_feed.EVENTS_PATH.read_text(encoding="utf-8"))
        events = calendar_feed.load_events()
        self.assertEqual(len(events), len(raw["events"]), "every shipped row must validate")
        for event in events:
            self.assertIn(event["game"], SUPPORTED_GAMES)
            self.assertTrue(event["url"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()
