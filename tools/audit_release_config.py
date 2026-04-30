#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
from urllib.parse import urlparse

try:
    from tools.mobile_env_resolver import parse_dotenv, resolve_mobile_env_values
except ModuleNotFoundError:  # pragma: no cover - direct script execution path
    from mobile_env_resolver import parse_dotenv, resolve_mobile_env_values


PLACEHOLDER_SUBSTRINGS = (
    "example.com",
    "your-project-ref",
    "your-supabase-anon-or-publishable-key",
    "com.yourcompany.",
    "your-expo-account",
    "00000000-0000-0000-0000-000000000000",
)


def parse_required_dotenv(path: Path) -> dict[str, str]:
    resolved_path = path.expanduser().resolve()
    if not resolved_path.exists():
        raise FileNotFoundError(f"Missing env file: {resolved_path}")
    return parse_dotenv(resolved_path)


def has_placeholder(value: str) -> bool:
    normalized = value.strip()
    if not normalized:
        return True
    lowered = normalized.lower()
    return lowered.startswith("your_") or "placeholder" in lowered or any(token in normalized for token in PLACEHOLDER_SUBSTRINGS)


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


def resolve_supabase_jwks_url(env_values: dict[str, str], secret_values: dict[str, str]) -> str:
    explicit_url = (
        env_values.get("SUPABASE_JWKS_URL", "").strip()
        or env_values.get("SPOTLIGHT_SUPABASE_JWKS_URL", "").strip()
        or secret_values.get("SUPABASE_JWKS_URL", "").strip()
        or secret_values.get("SPOTLIGHT_SUPABASE_JWKS_URL", "").strip()
    )
    if explicit_url:
        return explicit_url
    supabase_url = env_values.get("SUPABASE_URL", "").strip().rstrip("/")
    if not supabase_url:
        return ""
    return f"{supabase_url}/auth/v1/.well-known/jwks.json"


def hosted_auth_ready(
    env_values: dict[str, str],
    secret_values: dict[str, str],
) -> tuple[bool, str | None]:
    supabase_jwt_secret = (
        secret_values.get("SUPABASE_JWT_SECRET", "").strip()
        or env_values.get("SUPABASE_JWT_SECRET", "").strip()
    )
    if supabase_jwt_secret and not has_placeholder(supabase_jwt_secret):
        return True, None

    jwks_url = resolve_supabase_jwks_url(env_values, secret_values)
    if not jwks_url:
        return False, "missing SUPABASE_JWKS_URL and unable to derive one from SUPABASE_URL"
    try:
        with urlopen(jwks_url, timeout=10) as response:
            payload = json.load(response)
    except (OSError, URLError, ValueError) as error:
        return False, f"could not load JWKS from {jwks_url}: {error}"

    keys = payload.get("keys")
    if not isinstance(keys, list) or not keys:
        return False, f"JWKS endpoint {jwks_url} returned no signing keys"
    return True, None


def audit_backend(
    *,
    environment: str,
    backend_env_path: Path,
    backend_secrets_path: Path,
    failures: list[str],
    warnings: list[str],
) -> None:
    env_values = parse_required_dotenv(backend_env_path)
    secret_values = parse_required_dotenv(backend_secrets_path)

    require(
        flag_enabled(env_values.get("SPOTLIGHT_AUTH_REQUIRED")),
        f"{backend_env_path.name} must set SPOTLIGHT_AUTH_REQUIRED=1",
        failures,
    )
    require_https_url(env_values, "SUPABASE_URL", failures)
    auth_ready, auth_error = hosted_auth_ready(env_values, secret_values)
    require(
        auth_ready,
        (
            f"Hosted auth verification requires either a valid SUPABASE_JWT_SECRET or "
            f"a reachable Supabase JWKS endpoint. {auth_error}"
        ),
        failures,
    )
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
        not secret_values.get("SPOTLIGHT_LEGACY_OWNER_USER_ID", "").strip(),
        f"{backend_secrets_path.name} must not set SPOTLIGHT_LEGACY_OWNER_USER_ID for {environment}; it is migration-only",
        failures,
    )
    require(
        not env_values.get("SPOTLIGHT_LEGACY_OWNER_USER_ID", "").strip(),
        f"{backend_env_path.name} must not set SPOTLIGHT_LEGACY_OWNER_USER_ID for {environment}; it is migration-only",
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
        counterpart_values = parse_required_dotenv(counterpart_path)
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
    failures: list[str],
    warnings: list[str],
) -> None:
    repo_root_path = Path(__file__).resolve().parents[1]
    values = resolve_mobile_env_values(repo_root_path, environment, environment)
    require_https_url(values, "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL", failures)
    require_https_url(values, "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL", failures)
    require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME", failures)
    require_non_placeholder(values, "SPOTLIGHT_APP_SCHEME", failures)
    require_non_placeholder(values, "SPOTLIGHT_EXPO_OWNER", failures)
    require_non_placeholder(values, "SPOTLIGHT_EAS_PROJECT_ID", failures)
    require_non_placeholder(values, "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", failures)

    if flag_enabled(values.get("EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED")):
        require_non_placeholder(values, "EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY", failures)
        require_https_url(values, "EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST", failures)

    android_package = values.get("SPOTLIGHT_ANDROID_PACKAGE", "").strip()
    warn(bool(android_package) and not has_placeholder(android_package), "SPOTLIGHT_ANDROID_PACKAGE is still unset or placeholder", warnings)

    counterpart_environment = "production" if environment == "staging" else "staging"
    try:
        counterpart_values = resolve_mobile_env_values(repo_root_path, counterpart_environment, counterpart_environment)
        current_bundle = values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        other_bundle = counterpart_values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        warn(
            not current_bundle or not other_bundle or current_bundle != other_bundle,
            "Staging and production iOS bundle identifiers are identical; separate bundle IDs are safer for parallel installs/TestFlight lanes",
            warnings,
        )
    except Exception:
        pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit staged release configuration before deploy/build.")
    parser.add_argument("--environment", required=True, choices=("staging", "production"))
    parser.add_argument("--backend-secrets-file")
    parser.add_argument("--skip-backend", action="store_true")
    parser.add_argument("--skip-mobile", action="store_true")
    return parser


def default_backend_secrets_file(repo_root: Path, environment: str) -> Path:
    backend_dir = resolve_backend_dir(repo_root)
    env_key = f"SPOTLIGHT_BACKEND_{environment.upper()}_SECRETS_FILE"
    generic_override = os.environ.get("SPOTLIGHT_BACKEND_SECRETS_FILE", "").strip()
    env_override = os.environ.get(env_key, "").strip()
    candidate = env_override or generic_override or str(backend_dir / f".env.{environment}.secrets")
    path = Path(candidate)
    if not path.is_absolute():
        path = (repo_root / path).resolve()
    return path


def resolve_backend_dir(repo_root: Path) -> Path:
    candidate = repo_root / "backend"
    if candidate.exists():
        return candidate
    return repo_root


def main() -> int:
    args = build_parser().parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    failures: list[str] = []
    warnings: list[str] = []
    backend_dir = resolve_backend_dir(repo_root)

    if not args.skip_backend:
        backend_secrets_path = (
            Path(args.backend_secrets_file).resolve()
            if args.backend_secrets_file
            else default_backend_secrets_file(repo_root, args.environment)
        )
        audit_backend(
            environment=args.environment,
            backend_env_path=backend_dir / f".env.{args.environment}",
            backend_secrets_path=backend_secrets_path,
            failures=failures,
            warnings=warnings,
        )

    if not args.skip_mobile:
        audit_mobile(
            environment=args.environment,
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
        print("- resolved mobile release config looks production-safe")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
