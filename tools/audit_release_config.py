#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse


PLACEHOLDER_SUBSTRINGS = (
    "example.com",
    "your-project-ref",
    "your-supabase-anon-or-publishable-key",
    "com.yourcompany.",
    "your-expo-account",
    "00000000-0000-0000-0000-000000000000",
)


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        raise FileNotFoundError(f"Missing env file: {path}")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (
            value
            and len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        values[key] = value
    return values


def has_placeholder(value: str) -> bool:
    normalized = value.strip()
    if not normalized:
        return True
    return any(token in normalized for token in PLACEHOLDER_SUBSTRINGS)


def flag_enabled(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def warn(condition: bool, message: str, warnings: list[str]) -> None:
    if not condition:
        warnings.append(message)


def require_non_placeholder(values: dict[str, str], key: str, failures: list[str]) -> None:
    value = values.get(key, "").strip()
    require(bool(value), f"Missing required value: {key}", failures)
    if value:
        require(not has_placeholder(value), f"Placeholder value detected for {key}", failures)


def require_https_url(values: dict[str, str], key: str, failures: list[str]) -> None:
    value = values.get(key, "").strip()
    require_non_placeholder(values, key, failures)
    if not value:
        return
    parsed = urlparse(value)
    require(parsed.scheme == "https", f"{key} must use https in staging/production", failures)
    require(
        parsed.hostname not in {None, "127.0.0.1", "localhost", "10.0.2.2"},
        f"{key} must not point at a local host in staging/production",
        failures,
    )


def audit_backend(
    *,
    environment: str,
    backend_env_path: Path,
    backend_secrets_path: Path,
    failures: list[str],
    warnings: list[str],
) -> None:
    env_values = parse_dotenv(backend_env_path)
    secret_values = parse_dotenv(backend_secrets_path)

    require(
        flag_enabled(env_values.get("SPOTLIGHT_AUTH_REQUIRED")),
        f"{backend_env_path.name} must set SPOTLIGHT_AUTH_REQUIRED=1",
        failures,
    )
    require_https_url(env_values, "SUPABASE_URL", failures)
    require_non_placeholder(secret_values, "SCRYDEX_API_KEY", failures)
    require_non_placeholder(secret_values, "SCRYDEX_TEAM_ID", failures)
    require(
        not secret_values.get("SPOTLIGHT_AUTH_FALLBACK_USER_ID", "").strip(),
        f"{backend_secrets_path.name} must not set SPOTLIGHT_AUTH_FALLBACK_USER_ID for {environment}",
        failures,
    )
    require(
        not env_values.get("SPOTLIGHT_AUTH_FALLBACK_USER_ID", "").strip(),
        f"{backend_env_path.name} must not set SPOTLIGHT_AUTH_FALLBACK_USER_ID for {environment}",
        failures,
    )
    require(
        flag_enabled(env_values.get("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED")),
        f"{backend_env_path.name} should keep SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED=1 for {environment}",
        failures,
    )
    require(
        env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_STORAGE", "").strip() == "gcs",
        f"{backend_env_path.name} must use SPOTLIGHT_SCAN_ARTIFACTS_STORAGE=gcs",
        failures,
    )
    require_non_placeholder(env_values, "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", failures)

    ebay_enabled = flag_enabled(
        env_values.get("SPOTLIGHT_EBAY_BROWSE_ENABLED")
        or secret_values.get("SPOTLIGHT_EBAY_BROWSE_ENABLED")
    )
    if ebay_enabled:
        require_non_placeholder(secret_values, "EBAY_CLIENT_ID", failures)
        require_non_placeholder(secret_values, "EBAY_CLIENT_SECRET", failures)

    counterpart_name = ".env.production" if environment == "staging" else ".env.staging"
    counterpart_path = backend_env_path.with_name(counterpart_name)
    if counterpart_path.exists():
        counterpart_values = parse_dotenv(counterpart_path)
        current_bucket = env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", "").strip()
        other_bucket = counterpart_values.get("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", "").strip()
        require(
            not current_bucket or not other_bucket or current_bucket != other_bucket,
            "Staging and production backend artifact buckets must be different",
            failures,
        )


def audit_mobile(
    *,
    environment: str,
    mobile_env_path: Path,
    failures: list[str],
    warnings: list[str],
) -> None:
    values = parse_dotenv(mobile_env_path)
    require_https_url(values, "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL", failures)
    require_https_url(values, "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME", failures)
    require_non_placeholder(values, "SPOTLIGHT_APP_SCHEME", failures)
    require_non_placeholder(values, "SPOTLIGHT_EXPO_OWNER", failures)
    require_non_placeholder(values, "SPOTLIGHT_EAS_PROJECT_ID", failures)
    require_non_placeholder(values, "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", failures)

    android_package = values.get("SPOTLIGHT_ANDROID_PACKAGE", "").strip()
    warn(bool(android_package) and not has_placeholder(android_package), "SPOTLIGHT_ANDROID_PACKAGE is still unset or placeholder", warnings)

    counterpart_name = ".env.production" if environment == "staging" else ".env.staging"
    counterpart_path = mobile_env_path.with_name(counterpart_name)
    if counterpart_path.exists():
        counterpart_values = parse_dotenv(counterpart_path)
        current_bundle = values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        other_bundle = counterpart_values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        warn(
            not current_bundle or not other_bundle or current_bundle != other_bundle,
            "Staging and production iOS bundle identifiers are identical; separate bundle IDs are safer for parallel installs/TestFlight lanes",
            warnings,
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit staged release configuration before deploy/build.")
    parser.add_argument("--environment", required=True, choices=("staging", "production"))
    parser.add_argument("--backend-secrets-file", default="backend/.env")
    parser.add_argument("--skip-backend", action="store_true")
    parser.add_argument("--skip-mobile", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    failures: list[str] = []
    warnings: list[str] = []

    if not args.skip_backend:
        audit_backend(
            environment=args.environment,
            backend_env_path=repo_root / "backend" / f".env.{args.environment}",
            backend_secrets_path=(repo_root / args.backend_secrets_file).resolve()
            if not Path(args.backend_secrets_file).is_absolute()
            else Path(args.backend_secrets_file),
            failures=failures,
            warnings=warnings,
        )

    if not args.skip_mobile:
        audit_mobile(
            environment=args.environment,
            mobile_env_path=repo_root / "apps" / "spotlight-rn" / f".env.{args.environment}",
            failures=failures,
            warnings=warnings,
        )

    if warnings:
        print("WARNINGS:")
        for warning in warnings:
            print(f"- {warning}")
        print()

    if failures:
        print("RELEASE CONFIG AUDIT FAILED:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"RELEASE CONFIG AUDIT PASSED for {args.environment}")
    if not args.skip_backend:
        print("- backend hosted env + secrets look production-safe")
    if not args.skip_mobile:
        print("- mobile release env file looks production-safe")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
