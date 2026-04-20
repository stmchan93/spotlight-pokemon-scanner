from __future__ import annotations

import argparse
import json

from scrydex_adapter import scrydex_request_audit_summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize persistent Scrydex usage audit data.")
    parser.add_argument("--hours", type=int, default=24, help="Lookback window for grouped counts")
    parser.add_argument("--limit", type=int, default=25, help="Number of recent requests to include")
    args = parser.parse_args()

    summary = scrydex_request_audit_summary(hours=args.hours, recent_limit=args.limit)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
