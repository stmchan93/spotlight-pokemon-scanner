#!/usr/bin/env python3
"""One-shot "we're done labeling — train on it" command for a show backfill.

When every card has a human decision, this runs the whole tail in order:

  1. progress    — how many queue scans still have no terminal human decision
                   (confirmed / unclear / not_in_top_10). Reported; with
                   --require-complete it hard-stops unless that's 0.
  2. finalize    — finalize_show_labels.py: pull friends' picks off the staging
                   VM, merge them into the AI-labeled CSV -> scan_review.final.csv
                   (+ friend-vs-AI accuracy if verify/audit_truth.json exists).
  3. import+train — import_confirmed_scans_to_training.py --run-batch --train:
                   resolve every label against the catalog, tier-route, copy the
                   photos into the raw-visual corpus, and refresh the training
                   manifest/fixtures so the labels feed the next model build.

The final adapter-train + index-build + release-gate eval + publish/restart is a
heavier, separate ML step. This script prints the exact command for it rather
than guessing, because the canonical retrain cycle is keyed on in-app labeling
SESSIONS while these labels arrive via the web tool / CSV (see --help notes).
Pass --retrain to also invoke that cycle.

Defaults target the 2026-05-31 show. Re-runnable / idempotent.

Examples:
  # Preview everything, touch nothing destructive:
  python3 tools/finalize_and_train_show.py --plan-only
  # Real run once labeling is done:
  python3 tools/finalize_and_train_show.py --require-complete
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS = REPO_ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from export_labeling_sessions_batch import default_database_path  # noqa: E402
from finalize_show_labels import queue_remaining  # noqa: E402

DEFAULT_BASE = Path(
    "~/spotlight-datasets/raw-visual-train/scan-review-exports/show-2026-05-31"
).expanduser()


def run(cmd: list[str], *, plan_only: bool) -> None:
    printable = " ".join(cmd)
    print(f"\n$ {printable}", flush=True)
    if plan_only:
        print("  (plan-only: not executed)")
        return
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base", type=Path, default=DEFAULT_BASE, help="show export dir")
    parser.add_argument("--queue", default="show-2026-05-31")
    parser.add_argument("--batch-id", default="show-2026-05-31")
    parser.add_argument("--instance", default="spotlight-backend-vm-small")
    parser.add_argument("--zone", default="us-central1-b")
    parser.add_argument("--db", type=Path, default=default_database_path())
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help="Abort unless every queue scan has a terminal human decision.",
    )
    parser.add_argument(
        "--skip-train",
        action="store_true",
        help="Import the labels into the corpus but do NOT refresh the training manifest.",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        help="Print every step and run nothing (no VM calls, no writes).",
    )
    parser.add_argument(
        "--dry-run-import",
        action="store_true",
        help="Stage the import batch + report but don't write the registry or import.",
    )
    args = parser.parse_args()

    base = args.base.expanduser()
    reviewed_csv = base / "scan_review.reviewed.csv"
    final_csv = base / "scan_review.final.csv"
    audit_truth = base / "verify" / "audit_truth.json"
    queue_path = f"~/spotlight/review_queues/{args.queue}.json"

    print("=" * 64)
    print(f"finalize_and_train_show — queue={args.queue} base={base}")
    print("=" * 64)

    # 1. progress
    remaining = None
    if not args.plan_only:
        remaining = queue_remaining(args.instance, args.zone, queue_path)
        print(
            f"\n[progress] queue scans still needing a terminal decision: {remaining}"
            if remaining is not None
            else "\n[progress] could not read remaining count from the VM"
        )
        if args.require_complete:
            if remaining is None:
                print("Refusing to proceed: --require-complete but remaining is unknown.", file=sys.stderr)
                return 1
            if remaining > 0:
                print(
                    f"Not done yet: {remaining} scan(s) still need a human decision. "
                    "Re-run when the queue is drained (or drop --require-complete).",
                    file=sys.stderr,
                )
                return 1
    else:
        print("\n[progress] (plan-only: skipping VM remaining check)")

    # 2. finalize
    finalize_cmd = [
        "python3", str(TOOLS / "finalize_show_labels.py"),
        "--csv", str(reviewed_csv),
        "--out", str(final_csv),
        "--db", str(args.db),
        "--instance", args.instance,
        "--zone", args.zone,
        "--queue", args.queue,
    ]
    if audit_truth.exists() or args.plan_only:
        finalize_cmd += ["--audit-truth", str(audit_truth)]
    run(finalize_cmd, plan_only=args.plan_only)

    # 3. import (+ train)
    import_cmd = [
        "python3", str(TOOLS / "import_confirmed_scans_to_training.py"),
        "--csv", str(final_csv),
        "--db", str(args.db),
        "--batch-id", args.batch_id,
    ]
    if args.dry_run_import:
        import_cmd.append("--dry-run")
    else:
        import_cmd.append("--run-batch")
        if not args.skip_train:
            import_cmd.append("--train")
    run(import_cmd, plan_only=args.plan_only)

    # 4. model build + eval handoff (publish is human-gated — agreed plan:
    #    "build + eval, then pause"). The run_labeling_retrain_cycle is keyed on
    #    in-app labeling SESSIONS, but these labels land in the corpus via the
    #    import above, so the build+eval phase drives the lower-level tools on
    #    the corpus directly:
    #      train:  tools/train_raw_visual_adapter.py
    #      eval:   the eval suite -> raw_visual_release_gate (release_gate_decision.json)
    #    then STOP and surface the scorecard. Publish only on explicit approval:
    #      publish: tools/publish_raw_visual_runtime_artifacts.py
    #      restart: spotlight-backend.service
    print(
        "\n[next] Labels are imported into the corpus and the training manifest is\n"
        "       refreshed. PHASE 2 (build + eval, then pause) is run at trigger time:\n"
        "         1. train_raw_visual_adapter.py        (rebuild from corpus)\n"
        "         2. eval suite + raw_visual_release_gate (accuracy / holdout scorecard)\n"
        "         -> PAUSE and show the scorecard for approval\n"
        "         3. on 'publish': publish_raw_visual_runtime_artifacts.py + restart\n"
        "            spotlight-backend.service (go live on staging)\n"
        "       Nothing is published without your OK."
    )

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
