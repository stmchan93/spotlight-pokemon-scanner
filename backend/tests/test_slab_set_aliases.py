from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import slab_set_aliases


class SlabSetAliasesTests(unittest.TestCase):
    def tearDown(self) -> None:
        slab_set_aliases._load_alias_entries.cache_clear()

    def test_missing_alias_file_returns_empty_alias_set(self) -> None:
        with patch.object(
            slab_set_aliases.Path,
            "read_text",
            side_effect=FileNotFoundError("missing"),
        ):
            self.assertEqual(slab_set_aliases._load_alias_entries(), ())

    def test_loader_falls_back_to_alternate_alias_path(self) -> None:
        primary_path = Path("/tmp/primary-slab-set-aliases.json")
        fallback_path = Path("/tmp/fallback-slab-set-aliases.json")

        def fake_read_text(path: Path, *, encoding: str = "utf-8") -> str:
            self.assertEqual(encoding, "utf-8")
            if path == primary_path:
                raise FileNotFoundError("missing primary")
            if path == fallback_path:
                return '[{"aliases":["POKEMON MBG"],"scopes":["pokemon mega brave"]}]'
            raise AssertionError(f"Unexpected path: {path}")

        with patch.object(
            slab_set_aliases,
            "_alias_entry_paths",
            return_value=(primary_path, fallback_path),
        ), patch.object(
            slab_set_aliases.Path,
            "read_text",
            autospec=True,
            side_effect=fake_read_text,
        ):
            self.assertEqual(
                slab_set_aliases._load_alias_entries(),
                (
                    {
                        "aliases": ["POKEMON MBG"],
                        "scopes": ["pokemon mega brave"],
                    },
                ),
            )


if __name__ == "__main__":
    unittest.main()
