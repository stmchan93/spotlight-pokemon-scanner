"""Quick debug: print the raw shape of Scrydex /pokemon/v1/expansions response.

Run from backend dir:
    .venv/bin/python3 tools/debug_scrydex_expansions.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from env_loader import load_backend_env_file  # noqa: E402
from scrydex_adapter import scrydex_api_request  # noqa: E402

load_backend_env_file(BACKEND_ROOT / ".env")

payload = scrydex_api_request("/pokemon/v1/expansions", request_type="expansions_debug")

print("=" * 60)
print("Top-level type:", type(payload).__name__)
if isinstance(payload, dict):
    print("Top-level keys:", list(payload.keys()))
    data = payload.get("data") or payload.get("expansions") or payload.get("results")
    if isinstance(data, list) and data:
        print(f"\nFound {len(data)} items in list")
        print("\nFirst item keys:", list(data[0].keys()) if isinstance(data[0], dict) else "not a dict")
        print("\nFirst item (truncated):")
        print(json.dumps(data[0], indent=2, default=str)[:2000])
elif isinstance(payload, list) and payload:
    print(f"Found {len(payload)} items at top level")
    print("\nFirst item keys:", list(payload[0].keys()) if isinstance(payload[0], dict) else "not a dict")
    print("\nFirst item (truncated):")
    print(json.dumps(payload[0], indent=2, default=str)[:2000])
print("=" * 60)
