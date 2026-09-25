#!/usr/bin/env python3
"""Block OTA updates whose JS could need native code the installed binary lacks.

An EAS update reaches every binary on its (channel, runtimeVersion). runtimeVersion
is a hand-set string in apps/spotlight-rn/app.config.js, so nothing stops a native
change (a new module such as expo-sqlite, a config plugin, an app extension) from
shipping as an OTA to binaries that were built without it — and those crash on
launch. This guard keeps, per (environment, runtimeVersion, platform), the
@expo/fingerprint hash of the native build that runtime was cut from, in
tools/native-fingerprints.json, and:

  check-update  refuses the OTA when the current fingerprint differs from the
                record, or when there is no record (unless seeding is asked for).
  check-build   refuses a native build that would put DIFFERENT native code on an
                existing runtimeVersion (old binaries on that runtime would then
                receive OTAs built against the new native code), and saves the
                fingerprint so `record` can store it once the build succeeds.
  record        stores a fingerprint (from check-build's file, or computed now).
  show          prints the current fingerprint and what check-update would decide.

tools/native_fingerprint.cjs does the hashing; everything here is policy.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "apps" / "spotlight-rn"
DEFAULT_RECORDS_PATH = ROOT / "tools" / "native-fingerprints.json"
FINGERPRINT_SCRIPT = ROOT / "tools" / "native_fingerprint.cjs"
PLATFORMS = ("ios", "android")
ENVIRONMENTS = ("development", "staging", "production")
SEED_ENV_VAR = "SPOTLIGHT_RECORD_FINGERPRINT"
OVERWRITE_ENV_VAR = "SPOTLIGHT_NATIVE_FINGERPRINT_OVERWRITE"
MAX_DIFF_LINES = 25


@dataclass(frozen=True)
class Fingerprint:
    platform: str
    runtime_version: str
    hash: str
    sources: Mapping[str, str | None] = field(default_factory=dict)

    @classmethod
    def from_json(cls, payload: Mapping[str, Any]) -> "Fingerprint":
        return cls(
            platform=str(payload["platform"]),
            runtime_version=str(payload["runtimeVersion"]),
            hash=str(payload["hash"]),
            sources=dict(payload.get("sources") or {}),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "runtimeVersion": self.runtime_version,
            "hash": self.hash,
            "sources": dict(self.sources),
        }


@dataclass(frozen=True)
class Decision:
    ok: bool
    status: str  # match | seed | missing | mismatch | new | overwrite
    message: str


# ---------------------------------------------------------------- pure logic


def lookup_record(records: Mapping[str, Any], environment: str, runtime_version: str, platform: str) -> dict[str, Any] | None:
    entry = ((records.get(environment) or {}).get(runtime_version) or {}).get(platform)
    return entry if isinstance(entry, dict) and entry.get("hash") else None


def with_record(
    records: Mapping[str, Any],
    environment: str,
    fingerprint: Fingerprint,
    *,
    via: str,
    git_commit: str | None,
    recorded_at: str,
) -> dict[str, Any]:
    """Return a copy of `records` with (environment, runtimeVersion, platform) set."""
    updated = json.loads(json.dumps(records))  # deep copy
    runtime_entry = updated.setdefault(environment, {}).setdefault(fingerprint.runtime_version, {})
    runtime_entry[fingerprint.platform] = {
        "hash": fingerprint.hash,
        "recordedAt": recorded_at,
        "via": via,
        "gitCommit": git_commit,
        "sources": dict(sorted(fingerprint.sources.items())),
    }
    return updated


def diff_sources(recorded: Mapping[str, str | None], current: Mapping[str, str | None]) -> list[str]:
    lines: list[str] = []
    for key in sorted(set(recorded) | set(current)):
        before, after = recorded.get(key), current.get(key)
        if before == after:
            continue
        if key not in recorded:
            lines.append(f"  + added    {key}")
        elif key not in current:
            lines.append(f"  - removed  {key}")
        else:
            lines.append(f"  ~ changed  {key}")
    return lines


def _format_diff(record: Mapping[str, Any], current: Fingerprint) -> str:
    recorded_sources = record.get("sources") or {}
    if not recorded_sources:
        return "  (the record has no per-source hashes, so the changed inputs can't be listed)"
    lines = diff_sources(recorded_sources, current.sources)
    if not lines:
        return "  (per-source hashes match; the difference is in how sources were combined)"
    if len(lines) > MAX_DIFF_LINES:
        lines = lines[:MAX_DIFF_LINES] + [f"  ... and {len(lines) - MAX_DIFF_LINES} more"]
    return "\n".join(lines)


def _mismatch_message(environment: str, record: Mapping[str, Any], current: Fingerprint, *, action: str) -> str:
    rv = current.runtime_version
    recorded_from = record.get("gitCommit") or "unknown commit"
    return (
        f"Native code changed since the {rv} build (fingerprint {current.hash} != {record['hash']}).\n"
        f"  environment={environment} platform={current.platform} runtimeVersion={rv} "
        f"(recorded {record.get('recordedAt', '?')} via {record.get('via', '?')} at {recorded_from})\n"
        f"Changed native inputs:\n{_format_diff(record, current)}\n"
        + (
            "Bump runtimeVersion in apps/spotlight-rn/app.config.js and ship a native build first."
            if action == "update"
            else "Bump runtimeVersion in apps/spotlight-rn/app.config.js before building, so binaries already on "
            f"{rv} stop receiving OTAs built against this native code. If every {rv} binary really is being "
            f"replaced, re-run with {OVERWRITE_ENV_VAR}=1."
        )
    )


def evaluate_update(
    records: Mapping[str, Any], environment: str, current: Fingerprint, *, allow_seed: bool
) -> Decision:
    record = lookup_record(records, environment, current.runtime_version, current.platform)
    if record is None:
        if allow_seed:
            return Decision(
                True,
                "seed",
                f"No native fingerprint recorded for {environment}/{current.runtime_version}/{current.platform}; "
                f"seeding it with {current.hash} ({SEED_ENV_VAR}=1). Commit tools/native-fingerprints.json.",
            )
        return Decision(
            False,
            "missing",
            f"!!! No native fingerprint recorded for {environment}/{current.runtime_version}/{current.platform}.\n"
            f"    The OTA cannot be checked against the installed binaries, so it is blocked.\n"
            f"    Current fingerprint: {current.hash}\n"
            f"    If this tree's native code matches the {current.runtime_version} binaries in users' hands, record it,\n"
            f"    commit tools/native-fingerprints.json, then publish:\n"
            f"      python3 tools/native_fingerprint_guard.py record --environment {environment} "
            f"--platform {current.platform} --resolve-env --via seed\n"
            f"    (or seed during a single-platform publish with {SEED_ENV_VAR}=1 "
            f"bash tools/run_mobile_eas.sh {environment} update {current.platform} {environment})",
        )
    if record["hash"] == current.hash:
        return Decision(True, "match", f"Native fingerprint matches the {current.runtime_version} build ({current.hash}).")
    return Decision(False, "mismatch", _mismatch_message(environment, record, current, action="update"))


def evaluate_build(
    records: Mapping[str, Any], environment: str, current: Fingerprint, *, allow_overwrite: bool
) -> Decision:
    record = lookup_record(records, environment, current.runtime_version, current.platform)
    if record is None:
        return Decision(
            True,
            "new",
            f"No record yet for {environment}/{current.runtime_version}/{current.platform}; "
            f"{current.hash} will be recorded if the build succeeds.",
        )
    if record["hash"] == current.hash:
        return Decision(True, "match", f"Native fingerprint matches the existing {current.runtime_version} record.")
    if allow_overwrite:
        return Decision(
            True,
            "overwrite",
            f"Native code differs from the {current.runtime_version} record ({record['hash']} -> {current.hash}); "
            f"overwriting on success because {OVERWRITE_ENV_VAR}=1.",
        )
    return Decision(False, "mismatch", _mismatch_message(environment, record, current, action="build"))


# ---------------------------------------------------------------- I/O


def load_records(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8") or "{}")


def save_records(path: Path, records: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def git_head() -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def resolve_standalone_env(environment: str, profile: str | None) -> dict[str, str]:
    """Mirror how run_mobile_eas.sh loads env, for runs outside that script."""
    sys.path.insert(0, str(ROOT / "tools"))
    import mobile_env_resolver  # noqa: E402

    if environment in {"staging", "development"}:
        values = mobile_env_resolver.resolve_mobile_env_values(ROOT, environment, profile)
    else:
        values = mobile_env_resolver.parse_dotenv(APP_DIR / f".env.{environment}")
    values["SPOTLIGHT_APP_ENV"] = environment
    values["EXPO_NO_DOTENV"] = "1"
    return values


def compute_fingerprint(environment: str, platform: str, env_overrides: Mapping[str, str] | None = None) -> Fingerprint:
    env = dict(os.environ)
    env.update(env_overrides or {})
    if env.get("SPOTLIGHT_APP_ENV") != environment:
        raise SystemExit(
            f"SPOTLIGHT_APP_ENV is {env.get('SPOTLIGHT_APP_ENV')!r}, expected {environment!r}: the fingerprint would hash "
            "a different app config than the EAS build. Run through tools/run_mobile_eas.sh or pass --resolve-env."
        )
    result = subprocess.run(
        ["node", str(FINGERPRINT_SCRIPT), "--platform", platform],
        cwd=str(APP_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"Fingerprint computation failed:\n{result.stderr.strip()}")
    return Fingerprint.from_json(json.loads(result.stdout))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("check-update", "check-build", "record", "show"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--environment", required=True, choices=ENVIRONMENTS)
        cmd.add_argument("--platform", required=True, choices=PLATFORMS)
        cmd.add_argument("--profile", help="EAS profile, for --resolve-env (defaults to the environment)")
        cmd.add_argument("--resolve-env", action="store_true", help="load the env like run_mobile_eas.sh does")
        cmd.add_argument("--records", default=str(DEFAULT_RECORDS_PATH))
        if name == "check-update":
            cmd.add_argument("--record-fingerprint", action="store_true", help=f"seed a missing record (= {SEED_ENV_VAR}=1)")
        if name == "check-build":
            cmd.add_argument("--save-to", required=True, help="where to stash the fingerprint for `record --from-file`")
        if name == "record":
            cmd.add_argument("--from-file", help="fingerprint JSON saved by check-build")
            cmd.add_argument("--via", default="manual")
            cmd.add_argument("--force", action="store_true", help="replace an existing, different record")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    records_path = Path(args.records)
    records = load_records(records_path)
    env_overrides = resolve_standalone_env(args.environment, args.profile) if args.resolve_env else None

    if args.command == "record" and args.from_file:
        current = Fingerprint.from_json(json.loads(Path(args.from_file).read_text(encoding="utf-8")))
    else:
        current = compute_fingerprint(args.environment, args.platform, env_overrides)
    if current.platform != args.platform:
        raise SystemExit(f"Fingerprint is for {current.platform}, expected {args.platform}.")

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    label = f"[native-fingerprint] {args.environment}/{current.runtime_version}/{current.platform}"

    if args.command == "show":
        decision = evaluate_update(records, args.environment, current, allow_seed=False)
        print(json.dumps({"environment": args.environment, "platform": current.platform,
                          "runtimeVersion": current.runtime_version, "hash": current.hash,
                          "updateDecision": decision.status}, indent=2))
        if not decision.ok:
            print(decision.message, file=sys.stderr)
        return 0

    if args.command == "check-update":
        allow_seed = args.record_fingerprint or is_truthy(os.environ.get(SEED_ENV_VAR))
        decision = evaluate_update(records, args.environment, current, allow_seed=allow_seed)
        print(f"{label}: {decision.message}", file=sys.stderr)
        if decision.status == "seed":
            save_records(records_path, with_record(records, args.environment, current, via="seed",
                                                   git_commit=git_head(), recorded_at=now))
        return 0 if decision.ok else 1

    if args.command == "check-build":
        decision = evaluate_build(records, args.environment, current,
                                  allow_overwrite=is_truthy(os.environ.get(OVERWRITE_ENV_VAR)))
        print(f"{label}: {decision.message}", file=sys.stderr)
        if decision.ok:
            Path(args.save_to).write_text(json.dumps(current.to_json()), encoding="utf-8")
        return 0 if decision.ok else 1

    # record
    existing = lookup_record(records, args.environment, current.runtime_version, current.platform)
    if existing and existing["hash"] != current.hash and not (args.force or args.via == "build"):
        print(_mismatch_message(args.environment, existing, current, action="build"), file=sys.stderr)
        print("Refusing to replace the record without --force.", file=sys.stderr)
        return 1
    save_records(records_path, with_record(records, args.environment, current, via=args.via,
                                           git_commit=git_head(), recorded_at=now))
    print(f"{label}: recorded {current.hash} in {records_path.relative_to(ROOT) if records_path.is_relative_to(ROOT) else records_path}. "
          "Commit it so the next OTA can be checked.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
