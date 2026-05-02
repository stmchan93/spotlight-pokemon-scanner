#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_ROOT = REPO_ROOT / "tools"
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "scan_artifact_store.py").exists():
    BACKEND_ROOT = REPO_ROOT
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_dataset_paths import (  # noqa: E402
    default_raw_visual_batch_audit_root,
    default_raw_visual_expansion_holdout_root,
    default_raw_visual_scan_registry_path,
    default_raw_visual_train_excluded_root,
    default_raw_visual_train_hard_negatives_path,
    default_raw_visual_train_manifest_path,
    default_raw_visual_train_root,
)
from raw_visual_release_gate import evaluate_release_gate, load_named_scorecards  # noqa: E402
from scan_artifact_store import (  # noqa: E402
    SCAN_ARTIFACTS_GCS_BUCKET_ENV,
    SCAN_ARTIFACTS_ROOT_ENV,
    SCAN_ARTIFACTS_STORAGE_ENV,
)


LEGACY_FIXTURE_ROOT = REPO_ROOT / "qa" / "raw-footer-layout-check"
VISUAL_REQUIREMENTS_PATH = REPO_ROOT / "tools" / "requirements_raw_visual_poc.txt"
VISUAL_VENV_PATH = REPO_ROOT / ".venv-raw-visual-poc"
ACTIVE_RUNTIME_METADATA_PATH = BACKEND_ROOT / "data" / "visual-models" / "raw_visual_runtime_active.json"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def run_id_default() -> str:
    return f"labeling-retrain-{utc_timestamp_slug()}"


def batch_id_default() -> str:
    return f"labeling-batch-{utc_timestamp_slug()}"


def ensure_visual_python() -> Path:
    python_path = VISUAL_VENV_PATH / "bin" / "python"
    if python_path.exists():
        return python_path
    subprocess.run([sys.executable, "-m", "venv", str(VISUAL_VENV_PATH)], check=True, cwd=REPO_ROOT)
    pip_path = VISUAL_VENV_PATH / "bin" / "pip"
    subprocess.run([str(pip_path), "install", "-r", str(VISUAL_REQUIREMENTS_PATH)], check=True, cwd=REPO_ROOT)
    return python_path


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(payload), indent=2, sort_keys=True) + "\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@dataclass(frozen=True)
class CompletedSession:
    session_id: str
    completed_at: str


def default_database_path() -> Path:
    return BACKEND_ROOT / "data" / "spotlight_scanner.sqlite"


def default_artifact_root() -> Path:
    configured = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
    if configured:
        return Path(configured).expanduser()
    return BACKEND_ROOT / "data" / "scan-artifacts"


def default_ops_root(training_root: Path) -> Path:
    return training_root / "ops"


def default_state_path(training_root: Path, environment: str) -> Path:
    return default_ops_root(training_root) / f"{environment}-retrain-state.json"


def default_run_root(training_root: Path, run_id: str) -> Path:
    return default_ops_root(training_root) / "runs" / run_id


def open_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": 1,
            "updatedAt": None,
            "processedThroughCursor": None,
            "lastRun": None,
            "lastPublished": None,
        }
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"State file must contain a JSON object: {path}")
    return {
        "schemaVersion": max(int(payload.get("schemaVersion") or 1), 1),
        "updatedAt": payload.get("updatedAt"),
        "processedThroughCursor": payload.get("processedThroughCursor"),
        "lastRun": payload.get("lastRun"),
        "lastPublished": payload.get("lastPublished"),
    }


def _cursor_pair(cursor_payload: Any) -> tuple[str | None, set[str]]:
    if not isinstance(cursor_payload, dict):
        return None, set()
    completed_at = str(cursor_payload.get("completedAt") or "").strip() or None
    session_ids = {
        str(item).strip()
        for item in (cursor_payload.get("sessionIDsAtTimestamp") or [])
        if str(item).strip()
    }
    return completed_at, session_ids


def _session_cursor_payload(sessions: list[CompletedSession]) -> dict[str, Any] | None:
    if not sessions:
        return None
    max_completed_at = max(session.completed_at for session in sessions)
    session_ids = sorted(session.session_id for session in sessions if session.completed_at == max_completed_at)
    return {
        "completedAt": max_completed_at,
        "sessionIDsAtTimestamp": session_ids,
    }


def list_completed_sessions(connection: sqlite3.Connection) -> list[CompletedSession]:
    rows = connection.execute(
        """
        SELECT
            session_id,
            COALESCE(completed_at, updated_at, created_at) AS cursor_timestamp
        FROM labeling_sessions
        WHERE status = 'completed'
        ORDER BY cursor_timestamp, session_id
        """
    ).fetchall()
    return [
        CompletedSession(
            session_id=str(row["session_id"] or "").strip(),
            completed_at=str(row["cursor_timestamp"] or "").strip(),
        )
        for row in rows
        if str(row["session_id"] or "").strip() and str(row["cursor_timestamp"] or "").strip()
    ]


def select_new_sessions(
    sessions: list[CompletedSession],
    *,
    after_completed_at: str | None,
    after_session_ids_at_timestamp: set[str] | None = None,
    limit: int | None = None,
) -> list[CompletedSession]:
    selected: list[CompletedSession] = []
    boundary_ids = after_session_ids_at_timestamp or set()
    for session in sessions:
        if after_completed_at is not None:
            if session.completed_at < after_completed_at:
                continue
            if session.completed_at == after_completed_at and session.session_id in boundary_ids:
                continue
        selected.append(session)
        if limit is not None and len(selected) >= limit:
            break
    return selected


def load_completed_sessions_by_ids(
    connection: sqlite3.Connection,
    session_ids: list[str],
) -> list[CompletedSession]:
    if not session_ids:
        return []
    placeholders = ", ".join("?" for _ in session_ids)
    rows = connection.execute(
        f"""
        SELECT
            session_id,
            COALESCE(completed_at, updated_at, created_at) AS cursor_timestamp
        FROM labeling_sessions
        WHERE status = 'completed'
          AND session_id IN ({placeholders})
        ORDER BY cursor_timestamp, session_id
        """,
        session_ids,
    ).fetchall()
    return [
        CompletedSession(
            session_id=str(row["session_id"] or "").strip(),
            completed_at=str(row["cursor_timestamp"] or "").strip(),
        )
        for row in rows
        if str(row["session_id"] or "").strip() and str(row["cursor_timestamp"] or "").strip()
    ]


def run_command(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, check=True, cwd=REPO_ROOT, env=env)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export new labeling sessions, route them into train/eval roots, train a candidate, evaluate it, and optionally publish/restart when guarded gates pass.",
    )
    parser.add_argument("--environment", default="staging")
    parser.add_argument("--database-path", type=Path, default=default_database_path())
    parser.add_argument("--artifact-root", type=Path, default=default_artifact_root())
    parser.add_argument("--storage", default=os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV, "filesystem"))
    parser.add_argument("--gcs-bucket", default=os.environ.get(SCAN_ARTIFACTS_GCS_BUCKET_ENV))
    parser.add_argument("--training-root", type=Path, default=default_raw_visual_train_root())
    parser.add_argument("--expansion-holdout-root", type=Path, default=default_raw_visual_expansion_holdout_root())
    parser.add_argument("--excluded-root", type=Path, default=default_raw_visual_train_excluded_root())
    parser.add_argument("--heldout-root", type=Path, default=LEGACY_FIXTURE_ROOT)
    parser.add_argument("--audit-root", type=Path, default=default_raw_visual_batch_audit_root())
    parser.add_argument("--registry-path", type=Path, default=default_raw_visual_scan_registry_path())
    parser.add_argument("--state-path", type=Path)
    parser.add_argument("--run-id", default=run_id_default())
    parser.add_argument("--batch-id", default=batch_id_default())
    parser.add_argument("--session-id", action="append", default=[], help="Run only these completed labeling sessions. Repeatable.")
    parser.add_argument("--session-limit", type=int, help="Optional cap on selected completed sessions when using the cursor flow.")
    parser.add_argument("--artifact-version", help="Optional explicit candidate adapter version label.")
    parser.add_argument("--focus-batch-provider-ratio", type=float, default=0.30)
    parser.add_argument("--max-train-images-per-provider-per-epoch", type=int, default=4)
    parser.add_argument("--restart-service", default="", help="Optional systemd service name to restart after publish, for example spotlight-backend.service.")
    parser.add_argument("--restart-command", default="", help="Optional full shell command to run after publish.")
    parser.add_argument("--publish-if-pass", action="store_true", help="Publish active runtime artifacts and restart backend when the candidate clears all gates.")
    parser.add_argument("--dry-run", action="store_true", help="Select sessions and write summary/state stubs without running export/process/train/eval.")
    return parser.parse_args()


def load_audit_summary(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"Audit summary must be a JSON object: {path}")
    return payload


def load_export_summary(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"Export summary must be a JSON object: {path}")
    return payload


def load_active_runtime_metadata(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"Active runtime metadata must be a JSON object: {path}")
    return payload


def build_candidate_artifact_version(*, batch_id: str, run_id: str) -> str:
    batch_slug = "".join(character if character.isalnum() or character == "-" else "-" for character in batch_id.lower())
    return f"vauto-{utc_timestamp_slug()}-{batch_slug[:32]}-{run_id[-8:]}"


def gate_import_issues(export_summary: Mapping[str, Any], audit_summary: Mapping[str, Any]) -> list[str]:
    failures: list[str] = []
    if int(export_summary.get("skippedArtifactCount") or 0) > 0:
        failures.append(f"Export skipped {int(export_summary.get('skippedArtifactCount') or 0)} artifacts.")
    if int(audit_summary.get("unresolvedRowCount") or 0) > 0:
        failures.append(f"Batch audit has {int(audit_summary.get('unresolvedRowCount') or 0)} unresolved rows.")
    if int(audit_summary.get("invalidSourcePhotoCount") or 0) > 0:
        failures.append(f"Batch audit found {int(audit_summary.get('invalidSourcePhotoCount') or 0)} invalid source photos.")
    if int(audit_summary.get("unreferencedPhotoCount") or 0) > 0:
        failures.append(f"Batch audit found {int(audit_summary.get('unreferencedPhotoCount') or 0)} unreferenced photos.")
    bucket_summary = audit_summary.get("bucketSummary") or {}
    manual_review_rows = int(((bucket_summary.get("manual_review") or {}).get("rows")) or 0)
    heldout_blocked_rows = int(((bucket_summary.get("heldout_blocked") or {}).get("rows")) or 0)
    if manual_review_rows > 0:
        failures.append(f"Batch audit routed {manual_review_rows} rows to manual_review.")
    if heldout_blocked_rows > 0:
        failures.append(f"Batch audit routed {heldout_blocked_rows} rows to heldout_blocked.")
    return failures


def markdown_summary(summary: Mapping[str, Any]) -> str:
    lines = [
        f"# Labeling Retrain Cycle: {summary.get('runID')}",
        "",
        f"- Status: `{summary.get('status')}`",
        f"- Environment: `{summary.get('environment')}`",
        f"- Batch ID: `{summary.get('batchID')}`",
        f"- Selected sessions: `{summary.get('selectedSessionCount')}`",
        f"- Published: `{bool(summary.get('published'))}`",
        "",
    ]

    selected = summary.get("selectedSessionIDs") or []
    if selected:
        lines.append("- Sessions:")
        for session_id in selected:
            lines.append(f"  - `{session_id}`")
        lines.append("")

    failure_reasons = summary.get("failureReasons") or []
    if failure_reasons:
        lines.append("- Failure reasons:")
        for reason in failure_reasons:
            lines.append(f"  - {reason}")
        lines.append("")

    improvement_reasons = summary.get("improvementReasons") or []
    if improvement_reasons:
        lines.append("- Improvement reasons:")
        for reason in improvement_reasons:
            lines.append(f"  - {reason}")
        lines.append("")

    commands = summary.get("commands") or {}
    if commands:
        lines.append("- Commands:")
        for key, command in commands.items():
            lines.append(f"  - `{key}`: `{command}`")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def maybe_restart_backend(*, restart_service: str, restart_command: str) -> list[str] | None:
    if restart_command.strip():
        return ["zsh", "-lc", restart_command.strip()]
    if restart_service.strip():
        return ["sudo", "systemctl", "restart", restart_service.strip()]
    return None


def main() -> int:
    args = parse_args()

    environment = str(args.environment).strip() or "staging"
    database_path = args.database_path.expanduser().resolve()
    artifact_root = args.artifact_root.expanduser().resolve()
    training_root = args.training_root.expanduser().resolve()
    expansion_holdout_root = args.expansion_holdout_root.expanduser().resolve()
    excluded_root = args.excluded_root.expanduser().resolve()
    heldout_root = args.heldout_root.expanduser().resolve()
    audit_root = args.audit_root.expanduser().resolve()
    registry_path = args.registry_path.expanduser().resolve()
    state_path = (args.state_path or default_state_path(training_root, environment)).expanduser().resolve()
    run_root = default_run_root(training_root, args.run_id).resolve()
    run_root.mkdir(parents=True, exist_ok=True)

    run_state_path = run_root / "run_state.json"
    summary_json_path = run_root / "summary.json"
    summary_md_path = run_root / "summary.md"

    state = load_state(state_path)
    current_cursor_at, current_cursor_ids = _cursor_pair(state.get("processedThroughCursor"))

    with open_database(database_path) as connection:
        if args.session_id:
            selected_sessions = load_completed_sessions_by_ids(
                connection,
                [str(value).strip() for value in args.session_id if str(value).strip()],
            )
        else:
            selected_sessions = select_new_sessions(
                list_completed_sessions(connection),
                after_completed_at=current_cursor_at,
                after_session_ids_at_timestamp=current_cursor_ids,
                limit=args.session_limit,
            )

    summary: dict[str, Any] = {
        "generatedAt": utc_now_iso(),
        "runID": args.run_id,
        "environment": environment,
        "batchID": args.batch_id,
        "databasePath": str(database_path),
        "artifactRoot": str(artifact_root),
        "trainingRoot": str(training_root),
        "expansionHoldoutRoot": str(expansion_holdout_root),
        "registryPath": str(registry_path),
        "statePath": str(state_path),
        "runRoot": str(run_root),
        "selectedSessionCount": len(selected_sessions),
        "selectedSessionIDs": [session.session_id for session in selected_sessions],
        "selectedCursor": _session_cursor_payload(selected_sessions),
        "published": False,
        "failureReasons": [],
        "improvementReasons": [],
        "commands": {},
    }

    if not selected_sessions:
        summary["status"] = "no_new_sessions"
        write_json(summary_json_path, summary)
        write_text(summary_md_path, markdown_summary(summary))
        write_json(
            run_state_path,
            {
                "generatedAt": utc_now_iso(),
                "status": summary["status"],
                "summaryPath": str(summary_json_path),
            },
        )
        return 0

    if args.dry_run:
        summary["status"] = "dry_run"
        write_json(summary_json_path, summary)
        write_text(summary_md_path, markdown_summary(summary))
        write_json(
            run_state_path,
            {
                "generatedAt": utc_now_iso(),
                "status": summary["status"],
                "summaryPath": str(summary_json_path),
            },
        )
        return 0

    export_root = run_root / "export"
    export_command = [
        sys.executable,
        str(REPO_ROOT / "tools" / "export_labeling_sessions_batch.py"),
        "--database-path",
        str(database_path),
        "--artifact-root",
        str(artifact_root),
        "--storage",
        str(args.storage),
        "--batch-id",
        args.batch_id,
        "--output-root",
        str(export_root),
    ]
    if args.gcs_bucket:
        export_command.extend(["--gcs-bucket", str(args.gcs_bucket)])
    for session in selected_sessions:
        export_command.extend(["--session-id", session.session_id])
    summary["commands"]["export"] = shell_join(export_command)
    run_command(export_command)
    export_summary = load_export_summary(export_root / "export_summary.json")
    summary["exportSummaryPath"] = str(export_root / "export_summary.json")
    summary["exportedArtifactCount"] = int(export_summary.get("exportedArtifactCount") or 0)

    batch_audit_parent = run_root / "batch-audits"
    process_command = [
        sys.executable,
        str(REPO_ROOT / "tools" / "process_raw_visual_batch.py"),
        "--spreadsheet",
        str(export_summary["spreadsheetPath"]),
        "--photo-root",
        str(export_summary["photoRoot"]),
        "--batch-id",
        args.batch_id,
        "--training-root",
        str(training_root),
        "--expansion-holdout-root",
        str(expansion_holdout_root),
        "--excluded-root",
        str(excluded_root),
        "--heldout-root",
        str(heldout_root),
        "--audit-root",
        str(batch_audit_parent),
        "--registry-path",
        str(registry_path),
        "--import-safe",
        "--run-training-pipeline",
    ]
    summary["commands"]["process"] = shell_join(process_command)
    run_command(process_command)

    batch_audit_root = batch_audit_parent / args.batch_id
    audit_summary = load_audit_summary(batch_audit_root / "audit_summary.json")
    summary["auditSummaryPath"] = str(batch_audit_root / "audit_summary.json")
    summary["auditBucketSummary"] = audit_summary.get("bucketSummary")
    summary["expansionHoldoutSummary"] = audit_summary.get("expansionHoldoutSummary")

    import_failures = gate_import_issues(export_summary, audit_summary)
    if import_failures:
        summary["status"] = "blocked_import"
        summary["failureReasons"] = import_failures
        write_json(summary_json_path, summary)
        write_text(summary_md_path, markdown_summary(summary))
        write_json(
            run_state_path,
            {
                "generatedAt": utc_now_iso(),
                "status": summary["status"],
                "summaryPath": str(summary_json_path),
                "failureReasons": import_failures,
            },
        )
        return 2

    training_import_row_count = int(
        ((audit_summary.get("expansionHoldoutSummary") or {}).get("trainingImportRowCount")) or 0
    )
    expansion_row_count = int(
        ((audit_summary.get("expansionHoldoutSummary") or {}).get("selectedRowCount")) or 0
    )
    summary["trainingImportRowCount"] = training_import_row_count
    summary["expansionHoldoutRowCount"] = expansion_row_count

    if training_import_row_count <= 0:
        summary["status"] = "holdout_only_processed"
        state["updatedAt"] = utc_now_iso()
        state["processedThroughCursor"] = summary["selectedCursor"]
        state["lastRun"] = {
            "runID": args.run_id,
            "batchID": args.batch_id,
            "status": summary["status"],
            "summaryPath": str(summary_json_path),
            "completedAt": state["updatedAt"],
            "selectedSessionCount": len(selected_sessions),
            "candidateArtifactVersion": None,
        }
        write_json(state_path, state)
        write_json(
            run_state_path,
            {
                "generatedAt": utc_now_iso(),
                "status": summary["status"],
                "summaryPath": str(summary_json_path),
                "published": False,
            },
        )
        write_json(summary_json_path, summary)
        write_text(summary_md_path, markdown_summary(summary))
        return 0

    active_runtime_metadata = load_active_runtime_metadata(ACTIVE_RUNTIME_METADATA_PATH)
    active_index_artifact_version = str(active_runtime_metadata.get("artifactVersion") or "").strip()
    active_model_suffix = str(active_runtime_metadata.get("modelSuffix") or "clip-vit-base-patch32").strip() or "clip-vit-base-patch32"
    if not active_index_artifact_version:
        raise SystemExit(f"Missing artifactVersion in active runtime metadata: {ACTIVE_RUNTIME_METADATA_PATH}")

    candidate_artifact_version = str(args.artifact_version or build_candidate_artifact_version(batch_id=args.batch_id, run_id=args.run_id)).strip()
    summary["candidateArtifactVersion"] = candidate_artifact_version

    visual_python = ensure_visual_python()
    env = os.environ.copy()
    env.update(load_env_file(BACKEND_ROOT / ".env"))

    hard_negatives_path = default_raw_visual_train_hard_negatives_path().expanduser().resolve()
    manifest_path = default_raw_visual_train_manifest_path().expanduser().resolve()
    if manifest_path.exists():
        mine_hard_negatives_command = [
            str(visual_python),
            str(REPO_ROOT / "tools" / "mine_raw_visual_hard_negatives.py"),
            "--manifest-path",
            str(manifest_path),
            "--output",
            str(hard_negatives_path),
        ]
        summary["commands"]["mineHardNegatives"] = shell_join(mine_hard_negatives_command)
        run_command(mine_hard_negatives_command, env=env)

    train_command = [
        str(visual_python),
        str(REPO_ROOT / "tools" / "train_raw_visual_adapter.py"),
        "--manifest-path",
        str(manifest_path),
        "--artifact-version",
        candidate_artifact_version,
        "--focus-batch-id",
        args.batch_id,
        "--focus-batch-provider-ratio",
        str(args.focus_batch_provider_ratio),
        "--max-train-images-per-provider-per-epoch",
        str(args.max_train_images_per_provider_per_epoch),
        "--scan-registry-path",
        str(registry_path),
    ]
    if hard_negatives_path.exists():
        train_command.extend(["--hard-negatives-path", str(hard_negatives_path)])
    summary["commands"]["train"] = shell_join(train_command)
    run_command(train_command, env=env)

    eval_root = run_root / "eval"
    eval_root.mkdir(parents=True, exist_ok=True)

    active_adapter_path = BACKEND_ROOT / "data" / "visual-models" / "raw_visual_adapter_active.pt"
    candidate_adapter_path = BACKEND_ROOT / "data" / "visual-models" / f"raw_visual_adapter_{candidate_artifact_version}.pt"
    batch_holdout_root = expansion_holdout_root / args.batch_id
    expansion_eval_root = batch_holdout_root if expansion_row_count > 0 and batch_holdout_root.exists() else expansion_holdout_root

    def eval_suite(adapter_path: Path, suite_name: str, fixture_roots: list[Path]) -> Path:
        output_path = eval_root / f"{adapter_path.stem}_{suite_name}.json"
        command = [
            str(visual_python),
            str(REPO_ROOT / "tools" / "eval_raw_visual_model.py"),
            "--adapter-checkpoint",
            str(adapter_path),
        ]
        for fixture_root in fixture_roots:
            command.extend(["--fixture-root", str(fixture_root)])
        command.extend(["--output", str(output_path)])
        summary["commands"][f"eval:{adapter_path.stem}:{suite_name}"] = shell_join(command)
        run_command(command, env=env)
        return output_path

    active_scorecard_paths = {
        "legacy": eval_suite(active_adapter_path, "legacy", [LEGACY_FIXTURE_ROOT]),
        "expansion": eval_suite(active_adapter_path, "expansion", [expansion_eval_root]),
        "mixed": eval_suite(active_adapter_path, "mixed", [LEGACY_FIXTURE_ROOT, expansion_holdout_root]),
    }
    candidate_scorecard_paths = {
        "legacy": eval_suite(candidate_adapter_path, "legacy", [LEGACY_FIXTURE_ROOT]),
        "expansion": eval_suite(candidate_adapter_path, "expansion", [expansion_eval_root]),
        "mixed": eval_suite(candidate_adapter_path, "mixed", [LEGACY_FIXTURE_ROOT, expansion_holdout_root]),
    }

    gate_decision = evaluate_release_gate(
        active_scorecards=load_named_scorecards(active_scorecard_paths),
        candidate_scorecards=load_named_scorecards(candidate_scorecard_paths),
    )
    gate_decision_path = eval_root / "release_gate_decision.json"
    write_json(gate_decision_path, gate_decision)
    summary["gateDecisionPath"] = str(gate_decision_path)
    summary["failureReasons"] = list(gate_decision.get("failureReasons") or [])
    summary["improvementReasons"] = list(gate_decision.get("primaryImprovementReasons") or [])

    should_publish = bool(gate_decision.get("passed")) and args.publish_if_pass
    if should_publish:
        publish_command = [
            sys.executable,
            str(REPO_ROOT / "tools" / "publish_raw_visual_runtime_artifacts.py"),
            "--artifact-version",
            active_index_artifact_version,
            "--base-artifact-version",
            candidate_artifact_version,
            "--model-suffix",
            active_model_suffix,
        ]
        summary["commands"]["publish"] = shell_join(publish_command)
        run_command(publish_command)
        restart_command = maybe_restart_backend(
            restart_service=args.restart_service,
            restart_command=args.restart_command,
        )
        if restart_command is not None:
            summary["commands"]["restart"] = shell_join(restart_command)
            run_command(restart_command)
        summary["published"] = True
        summary["status"] = "published"
    elif bool(gate_decision.get("passed")):
        summary["status"] = "passed_not_published"
    else:
        summary["status"] = "rejected"

    state["updatedAt"] = utc_now_iso()
    state["processedThroughCursor"] = summary["selectedCursor"]
    state["lastRun"] = {
        "runID": args.run_id,
        "batchID": args.batch_id,
        "status": summary["status"],
        "summaryPath": str(summary_json_path),
        "completedAt": state["updatedAt"],
        "selectedSessionCount": len(selected_sessions),
        "candidateArtifactVersion": candidate_artifact_version,
    }
    if summary["published"]:
        state["lastPublished"] = {
            "runID": args.run_id,
            "batchID": args.batch_id,
            "artifactVersion": candidate_artifact_version,
            "completedAt": state["updatedAt"],
            "summaryPath": str(summary_json_path),
        }
    write_json(state_path, state)

    write_json(
        run_state_path,
        {
            "generatedAt": utc_now_iso(),
            "status": summary["status"],
            "summaryPath": str(summary_json_path),
            "candidateArtifactVersion": candidate_artifact_version,
            "published": summary["published"],
        },
    )
    write_json(summary_json_path, summary)
    write_text(summary_md_path, markdown_summary(summary))

    return 0 if summary["status"] in {"published", "passed_not_published"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
