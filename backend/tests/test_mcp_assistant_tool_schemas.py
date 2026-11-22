"""Tool schemas the Anthropic API accepts.

Unit tests mock the API, so an invalid schema only fails live (2026-11-20: every
chat turn 400'd on `type: [string, null]` + `enum`). These static checks catch
the known-bad shapes before deploy.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_server.assistant.tools import TOOL_DEFINITIONS  # noqa: E402

MAX_STRICT_OPTIONAL = 24


def _walk(node: Any, path: str):
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from _walk(value, f"{path}/{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, f"{path}[{index}]")


class ToolSchemaTests(unittest.TestCase):
    def test_no_enum_under_a_type_list(self) -> None:
        bad = [
            f"{tool['name']}{path}"
            for tool in TOOL_DEFINITIONS
            for path, node in _walk(tool.get("input_schema", {}), "")
            if "enum" in node and isinstance(node.get("type"), list)
        ]
        self.assertEqual(bad, [], "use anyOf [{type:string, enum}, {type:null}] instead")

    def test_strict_tools_close_objects(self) -> None:
        for tool in TOOL_DEFINITIONS:
            if not tool.get("strict"):
                continue
            for path, node in _walk(tool["input_schema"], ""):
                if node.get("type") == "object" and "properties" in node:
                    self.assertIs(node.get("additionalProperties"), False, f"{tool['name']}{path}")

    def test_strict_optional_param_budget(self) -> None:
        optional = 0
        for tool in TOOL_DEFINITIONS:
            if not tool.get("strict"):
                continue
            for _, node in _walk(tool["input_schema"], ""):
                if node.get("type") == "object" and "properties" in node:
                    optional += len(set(node["properties"]) - set(node.get("required", [])))
        self.assertLessEqual(optional, MAX_STRICT_OPTIONAL)


if __name__ == "__main__":
    unittest.main()


class StrictToolBudgetTests(unittest.TestCase):
    def test_only_write_tools_are_strict(self) -> None:
        # Too many strict tools made the API reject every request (compiled grammar too large, 2026-11-22).
        from mcp_server.assistant.engine import TOOLS_PAYLOAD

        strict = sorted(tool["name"] for tool in TOOLS_PAYLOAD if tool.get("strict"))
        self.assertTrue(strict)
        for name in strict:
            self.assertTrue(name.startswith("propose_") or name == "add_to_collection_now", name)
        self.assertLessEqual(len(strict), 10)
