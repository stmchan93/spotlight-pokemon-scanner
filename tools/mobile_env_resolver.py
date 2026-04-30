#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


UUID_PATTERN = re.compile(r"/([0-9a-fA-F-]{36})/?$")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def app_dir(root: Path) -> Path:
    return root / "apps" / "spotlight-rn"


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value

    return values


def serialize_dotenv(values: dict[str, str]) -> str:
    lines = [f"{key}={value}" for key, value in values.items()]
    return "\n".join(lines) + ("\n" if lines else "")


def load_eas_profile(root: Path, profile: str) -> dict[str, Any]:
    eas_config = json.loads((app_dir(root) / "eas.json").read_text(encoding="utf-8"))
    build_profiles = eas_config.get("build") or {}
    profile_config = build_profiles.get(profile)
    if not isinstance(profile_config, dict):
        raise RuntimeError(f"Missing EAS build profile: {profile}")
    return profile_config


def extract_project_id(root: Path, values: dict[str, str]) -> str:
    explicit = str(values.get("SPOTLIGHT_EAS_PROJECT_ID") or "").strip()
    if explicit:
        return explicit

    app_json = json.loads((app_dir(root) / "app.json").read_text(encoding="utf-8"))
    updates_url = str((((app_json.get("expo") or {}).get("updates") or {}).get("url")) or "").strip()
    match = UUID_PATTERN.search(updates_url)
    if match:
        return match.group(1)

    return ""


def merge_missing(base: dict[str, str], fallback: dict[str, str]) -> dict[str, str]:
    merged = dict(base)
    for key, value in fallback.items():
        if key not in merged or not str(merged[key]).strip():
            merged[key] = value
    return merged


def pull_eas_environment(root: Path, eas_environment: str, project_id: str) -> dict[str, str]:
    if not eas_environment or not project_id:
        return {}

    temp_handle = tempfile.NamedTemporaryFile(
        prefix=f"spotlight-eas-{eas_environment}-",
        suffix=".env",
        delete=False,
    )
    temp_path = Path(temp_handle.name)
    temp_handle.close()

    try:
        env = os.environ.copy()
        env["SPOTLIGHT_EAS_PROJECT_ID"] = project_id
        env["EXPO_NO_DOTENV"] = "1"
        command = [
            "pnpm",
            "dlx",
            "eas-cli",
            "env:pull",
            "--environment",
            eas_environment,
            "--path",
            str(temp_path),
            "--non-interactive",
        ]
        result = subprocess.run(
            command,
            cwd=app_dir(root),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip() or result.stdout.strip() or "unknown eas env:pull failure"
            raise RuntimeError(stderr)
        return parse_dotenv(temp_path)
    finally:
        temp_path.unlink(missing_ok=True)


def resolve_mobile_env_values(root: Path, environment: str, profile: str | None = None) -> dict[str, str]:
    resolved_profile = profile or environment
    profile_config = load_eas_profile(root, resolved_profile)

    static_env = {
        key: str(value)
        for key, value in (profile_config.get("env") or {}).items()
        if isinstance(key, str)
    }
    eas_environment = str(profile_config.get("environment") or environment).strip()
    local_env_path = app_dir(root) / f".env.{environment}"
    local_env = parse_dotenv(local_env_path)

    merged = dict(static_env)
    merged["SPOTLIGHT_APP_ENV"] = environment

    project_id = extract_project_id(root, merged)
    if environment == "staging":
        merged.update(pull_eas_environment(root, eas_environment, project_id))

    return merge_missing(merged, local_env)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve mobile env from eas.json, EAS env, and local fallback env files.",
    )
    parser.add_argument("--environment", required=True, choices=("development", "staging", "production"))
    parser.add_argument("--profile")
    parser.add_argument("--format", choices=("dotenv", "json"), default="dotenv")
    parser.add_argument("--output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = repo_root()
    values = resolve_mobile_env_values(root, args.environment, args.profile)

    if args.format == "json":
        payload = json.dumps(values, indent=2, sort_keys=True)
    else:
        payload = serialize_dotenv(values)

    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
