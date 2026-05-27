#!/usr/bin/env python3
"""Promote/rollback safety gate for the user-photo rerank pool flywheel.

The rerank pool is rebuilt as more confirmed card-show scans accrue. Before a
freshly-built dated pool can replace the live one, it must clear a two-sided
safety gate so the flywheel can never silently degrade accuracy:

  * leave-one-out top-1 (covered-card LIFT) must not drop, AND
  * holdout top-1 (uncovered-card REGRESSION check) must not drop,

each compared against the last KNOWN-GOOD pool. Only then do we promote (swap
the active alias + advance the known-good marker + advance the watermark). Any
regression rolls back: the active alias is left untouched and the watermark is
NOT advanced, so the same window is retried next time.

This module is intentionally dependency-light (stdlib only) and pure so the
decision logic, the marker/watermark round-trips, and the eval-output parser
can all be unit-tested without building a pool or invoking the encoder.

State files (created under tools/state/, alongside this file's parent):
  * rerank_pool_known_good.json -> {version, leaveOneOutTop1, holdoutTop1, promotedAt}
  * rerank_pool_watermark.txt    -> a single ISO-8601 timestamp line
  * rerank_review_queue.csv      -> ingest trust-filter rejects (written by the builder)
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


TOOLS_ROOT = Path(__file__).resolve().parent
STATE_DIR = TOOLS_ROOT / "state"
KNOWN_GOOD_PATH = STATE_DIR / "rerank_pool_known_good.json"
WATERMARK_PATH = STATE_DIR / "rerank_pool_watermark.txt"


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def ensure_state_dir() -> Path:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return STATE_DIR


# --------------------------------------------------------------------------- #
# Promote / rollback decision (pure)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PromotionDecision:
    promote: bool
    reason: str
    new_leave_one_out_top1: int
    new_holdout_top1: int
    known_good_leave_one_out_top1: int
    known_good_holdout_top1: int

    def as_dict(self) -> dict[str, object]:
        return {
            "promote": self.promote,
            "reason": self.reason,
            "newLeaveOneOutTop1": self.new_leave_one_out_top1,
            "newHoldoutTop1": self.new_holdout_top1,
            "knownGoodLeaveOneOutTop1": self.known_good_leave_one_out_top1,
            "knownGoodHoldoutTop1": self.known_good_holdout_top1,
        }


def decide_promotion(
    new_leave_one_out_top1: int,
    new_holdout_top1: int,
    known_good_leave_one_out_top1: int,
    known_good_holdout_top1: int,
) -> PromotionDecision:
    """Promote only if BOTH metrics hold at or above the known-good baseline.

    A drop in either leave-one-out top-1 (the covered-card lift we are trying to
    grow) or holdout top-1 (uncovered cards we must not regress) blocks the
    promote. Ties promote so the watermark advances on steady-state windows.
    """
    loo_ok = new_leave_one_out_top1 >= known_good_leave_one_out_top1
    holdout_ok = new_holdout_top1 >= known_good_holdout_top1

    if loo_ok and holdout_ok:
        reason = (
            f"PROMOTE: leave_one_out top-1 {new_leave_one_out_top1} >= "
            f"{known_good_leave_one_out_top1} and holdout top-1 "
            f"{new_holdout_top1} >= {known_good_holdout_top1}"
        )
        promote = True
    else:
        regressions = []
        if not loo_ok:
            regressions.append(
                f"leave_one_out top-1 regressed {known_good_leave_one_out_top1} -> "
                f"{new_leave_one_out_top1}"
            )
        if not holdout_ok:
            regressions.append(
                f"holdout top-1 regressed {known_good_holdout_top1} -> "
                f"{new_holdout_top1}"
            )
        reason = "ROLLBACK: " + "; ".join(regressions)
        promote = False

    return PromotionDecision(
        promote=promote,
        reason=reason,
        new_leave_one_out_top1=new_leave_one_out_top1,
        new_holdout_top1=new_holdout_top1,
        known_good_leave_one_out_top1=known_good_leave_one_out_top1,
        known_good_holdout_top1=known_good_holdout_top1,
    )


# --------------------------------------------------------------------------- #
# Known-good marker round-trip
# --------------------------------------------------------------------------- #
@dataclass
class KnownGoodMarker:
    version: str
    leaveOneOutTop1: int
    holdoutTop1: int
    promotedAt: str

    def as_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "leaveOneOutTop1": int(self.leaveOneOutTop1),
            "holdoutTop1": int(self.holdoutTop1),
            "promotedAt": self.promotedAt,
        }


def read_known_good(path: Path = KNOWN_GOOD_PATH) -> KnownGoodMarker | None:
    path = Path(path)
    if not path.exists():
        return None
    payload = json.loads(path.read_text())
    return KnownGoodMarker(
        version=str(payload.get("version") or ""),
        leaveOneOutTop1=int(payload.get("leaveOneOutTop1") or 0),
        holdoutTop1=int(payload.get("holdoutTop1") or 0),
        promotedAt=str(payload.get("promotedAt") or ""),
    )


def write_known_good(marker: KnownGoodMarker, path: Path = KNOWN_GOOD_PATH) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(marker.as_dict(), indent=2, sort_keys=True) + "\n")
    return path


# --------------------------------------------------------------------------- #
# Watermark round-trip
# --------------------------------------------------------------------------- #
def read_watermark(path: Path = WATERMARK_PATH) -> str | None:
    path = Path(path)
    if not path.exists():
        return None
    text = path.read_text().strip()
    return text or None


def write_watermark(timestamp: str, path: Path = WATERMARK_PATH) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(timestamp.strip() + "\n")
    return path


# --------------------------------------------------------------------------- #
# eval_rerank_with_user_photos.py stdout parser
# --------------------------------------------------------------------------- #
# Each result row is emitted by evaluate() as (see eval_rerank_with_user_photos.py):
#   f"  {alpha:6.2f} {threshold:7.3f}  {n:>3}/{total:<3}    {n:>3}/{total:<3}    ..."
# i.e. "  0.10   0.800   42/100      55/100      60/100      2"
# The first numeric column after alpha/threshold is the top-1 "hits/total" cell.
_ROW_RE = re.compile(
    r"^\s*(?P<alpha>-?\d+(?:\.\d+)?)\s+"
    r"(?P<threshold>-?\d+(?:\.\d+)?)\s+"
    r"(?P<top1_hits>\d+)\s*/\s*(?P<top1_total>\d+)\b"
)


def parse_eval_top1(
    stdout: str,
    *,
    alpha: float,
    threshold: float,
    tolerance: float = 1e-3,
) -> int:
    """Extract the top-1 hit count at the (alpha, threshold) result row.

    Returns the integer hit count (the numerator of the "hits/total" top-1
    cell). Raises ValueError if no matching row is found, so a malformed or
    empty eval run is a hard failure rather than a silent zero.
    """
    for line in stdout.splitlines():
        match = _ROW_RE.match(line)
        if not match:
            continue
        row_alpha = float(match.group("alpha"))
        row_threshold = float(match.group("threshold"))
        if (
            abs(row_alpha - alpha) <= tolerance
            and abs(row_threshold - threshold) <= tolerance
        ):
            return int(match.group("top1_hits"))
    raise ValueError(
        f"no result row found for alpha={alpha} threshold={threshold} in eval output"
    )


# --------------------------------------------------------------------------- #
# CLI surface for the shell orchestrator
# --------------------------------------------------------------------------- #
def _cmd_decide(args: argparse.Namespace) -> int:
    decision = decide_promotion(
        new_leave_one_out_top1=args.new_loo_top1,
        new_holdout_top1=args.new_holdout_top1,
        known_good_leave_one_out_top1=args.known_good_loo_top1,
        known_good_holdout_top1=args.known_good_holdout_top1,
    )
    print(json.dumps(decision.as_dict()))
    # Exit 0 = promote, 1 = rollback, so the shell can branch on $?.
    return 0 if decision.promote else 1


def _cmd_parse_top1(args: argparse.Namespace) -> int:
    text = Path(args.file).read_text() if args.file else __import__("sys").stdin.read()
    top1 = parse_eval_top1(text, alpha=args.alpha, threshold=args.threshold)
    print(top1)
    return 0


def _cmd_read_known_good(args: argparse.Namespace) -> int:
    marker = read_known_good()
    if marker is None:
        print(json.dumps({}))
        return 1
    print(json.dumps(marker.as_dict()))
    return 0


def _cmd_write_known_good(args: argparse.Namespace) -> int:
    marker = KnownGoodMarker(
        version=args.version,
        leaveOneOutTop1=args.loo_top1,
        holdoutTop1=args.holdout_top1,
        promotedAt=args.promoted_at or utc_now_iso(),
    )
    path = write_known_good(marker)
    print(str(path))
    return 0


def _cmd_read_watermark(args: argparse.Namespace) -> int:
    watermark = read_watermark()
    if watermark is None:
        return 1
    print(watermark)
    return 0


def _cmd_write_watermark(args: argparse.Namespace) -> int:
    path = write_watermark(args.timestamp)
    print(str(path))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_decide = sub.add_parser("decide", help="Decide promote vs rollback; exit 0=promote 1=rollback.")
    p_decide.add_argument("--new-loo-top1", type=int, required=True)
    p_decide.add_argument("--new-holdout-top1", type=int, required=True)
    p_decide.add_argument("--known-good-loo-top1", type=int, required=True)
    p_decide.add_argument("--known-good-holdout-top1", type=int, required=True)
    p_decide.set_defaults(func=_cmd_decide)

    p_parse = sub.add_parser("parse-top1", help="Parse top-1 hits from eval stdout at alpha/threshold.")
    p_parse.add_argument("--alpha", type=float, required=True)
    p_parse.add_argument("--threshold", type=float, required=True)
    p_parse.add_argument("--file", help="File to read; defaults to stdin.")
    p_parse.set_defaults(func=_cmd_parse_top1)

    p_rkg = sub.add_parser("read-known-good", help="Print the known-good marker JSON (exit 1 if absent).")
    p_rkg.set_defaults(func=_cmd_read_known_good)

    p_wkg = sub.add_parser("write-known-good", help="Write the known-good marker.")
    p_wkg.add_argument("--version", required=True)
    p_wkg.add_argument("--loo-top1", type=int, required=True)
    p_wkg.add_argument("--holdout-top1", type=int, required=True)
    p_wkg.add_argument("--promoted-at", help="ISO timestamp; defaults to now.")
    p_wkg.set_defaults(func=_cmd_write_known_good)

    p_rw = sub.add_parser("read-watermark", help="Print the watermark (exit 1 if absent).")
    p_rw.set_defaults(func=_cmd_read_watermark)

    p_ww = sub.add_parser("write-watermark", help="Write the watermark timestamp.")
    p_ww.add_argument("timestamp")
    p_ww.set_defaults(func=_cmd_write_watermark)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
