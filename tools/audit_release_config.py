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


# Until 2026-08-06 development, staging AND production all resolved to ONE Supabase
# project: eas.json hardcoded the same URL + publishable key in every build profile and
# backend/.env.staging was byte-identical to backend/.env.production. Every staging
# sign-in, smoke fixture and schema migration therefore ran against the project holding
# the real user accounts, and it went unnoticed for months because this gate only ever
# validated each environment in isolation. The checks below are the regression guard.
# They compare resolved values between environments and never assert a literal project
# ref, so recreating a Supabase project does not break them.
SUPABASE_IDENTITY_KEYS = (
    "SUPABASE_URL",
    "SUPABASE_JWKS_URL",
    "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
)

MOBILE_SUPABASE_IDENTITY_KEYS = (
    "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL",
    "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY",
)


def summarize_shared_value(key: str, value: str) -> str:
    trimmed = value.strip()
    if "URL" in key.upper():
        return trimmed
    if len(trimmed) <= 12:
        return "(identical value)"
    return f"{trimmed[:10]}...{trimmed[-4:]}"


def require_distinct_supabase_project(
    *,
    key: str,
    non_production_environment: str,
    non_production_source: str,
    non_production_value: str,
    production_source: str,
    production_value: str,
    failures: list[str],
) -> None:
    """Fail when a non-production environment resolves to production's Supabase project."""
    non_production = str(non_production_value or "").strip()
    production = str(production_value or "").strip()
    if not non_production or not production or non_production != production:
        return
    failures.append(
        f"SUPABASE PROJECT COLLISION: {key} is identical in {non_production_environment} "
        f"({non_production_source}) and production ({production_source}); shared value "
        f"{summarize_shared_value(key, production)}. Both environments therefore talk to the "
        "SAME Supabase project, and production holds the REAL user accounts -- every "
        f"{non_production_environment} sign-in, smoke fixture and schema migration would run "
        f"against live user data. Give {non_production_environment} its own Supabase project "
        f"(its own project ref AND its own publishable/anon and service-role keys) in "
        f"{non_production_source} before releasing."
    )


def require_distinct_supabase_projects(
    *,
    keys: tuple[str, ...],
    non_production_environment: str,
    non_production_source: str,
    non_production_values: dict[str, str],
    production_source: str,
    production_values: dict[str, str],
    failures: list[str],
) -> None:
    for key in keys:
        require_distinct_supabase_project(
            key=key,
            non_production_environment=non_production_environment,
            non_production_source=non_production_source,
            non_production_value=non_production_values.get(key, ""),
            production_source=production_source,
            production_value=production_values.get(key, ""),
            failures=failures,
        )


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
    # Split 2026-07-10: only PRODUCTION talks to Scrydex. Staging is keyless by
    # design (its data arrives via litestream restore from prod), so a key
    # PRESENT on staging is the failure — it would let staging burn paid credits.
    if environment == "production":
        require_non_placeholder(secret_values, "SCRYDEX_API_KEY", failures)
        require_non_placeholder(secret_values, "SCRYDEX_TEAM_ID", failures)
    else:
        require(
            not secret_values.get("SCRYDEX_API_KEY", "").strip(),
            f"{backend_secrets_path.name} must NOT set SCRYDEX_API_KEY for staging (keyless by design)",
            failures,
        )
        require(
            not secret_values.get("PPT_API_KEY", "").strip(),
            f"{backend_secrets_path.name} must NOT set PPT_API_KEY for staging (keyless by design)",
            failures,
        )

    # Account deletion (App Store guideline 5.1.1(v)) deletes the Supabase auth user
    # via the Admin API. Without the service-role key the delete silently skips the
    # auth user, the login survives a "Delete Account", and App Review re-rejects.
    # Require it server-side so a deploy fails loudly instead of shipping that.
    service_role_key = (
        secret_values.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or secret_values.get("SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or env_values.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or env_values.get("SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    )
    require(
        bool(service_role_key) and not has_placeholder(service_role_key),
        (
            f"{backend_secrets_path.name} must set SUPABASE_SERVICE_ROLE_KEY (the Supabase "
            "service_role secret) so account deletion removes the auth user — App Store "
            "guideline 5.1.1(v). Without it a 'Delete Account' leaves the login working."
        ),
        failures,
    )
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
    # Split 2026-07-10: scan artifacts are TRAINING DATA and only production
    # collects them. Staging must keep uploads OFF and must not point at a GCS
    # bucket at all (defense-in-depth: even an accidentally re-enabled flag
    # could then only write to the local disk, never the labeled corpus).
    if environment == "production":
        require(
            flag_enabled(env_values.get("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED")),
            f"{backend_env_path.name} should keep SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED=1 for production",
            failures,
        )
        require(
            env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_STORAGE", "").strip() == "gcs",
            f"{backend_env_path.name} must use SPOTLIGHT_SCAN_ARTIFACTS_STORAGE=gcs",
            failures,
        )
        require_non_placeholder(env_values, "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", failures)
    else:
        require(
            not flag_enabled(env_values.get("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED")),
            f"{backend_env_path.name} must keep SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED=false for staging (corpus purity)",
            failures,
        )
        require(
            env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_STORAGE", "").strip() != "gcs"
            and not env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", "").strip(),
            f"{backend_env_path.name} must not point staging artifacts at GCS (use filesystem, no bucket)",
            failures,
        )

    ebay_enabled = flag_enabled(
        env_values.get("SPOTLIGHT_EBAY_BROWSE_ENABLED")
        or secret_values.get("SPOTLIGHT_EBAY_BROWSE_ENABLED")
    )
    if ebay_enabled:
        require_non_placeholder(secret_values, "EBAY_CLIENT_ID", failures)
        require_non_placeholder(secret_values, "EBAY_CLIENT_SECRET", failures)

    counterpart_environment = "production" if environment == "staging" else "staging"
    counterpart_path = backend_env_path.with_name(f".env.{counterpart_environment}")
    if counterpart_path.exists():
        counterpart_values = parse_required_dotenv(counterpart_path)
        current_bucket = env_values.get("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", "").strip()
        other_bucket = counterpart_values.get("SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET", "").strip()
        require(
            not current_bucket or not other_bucket or current_bucket != other_bucket,
            "Staging and production backend artifact buckets must be different",
            failures,
        )

        if environment == "staging":
            staging_env, production_env = env_values, counterpart_values
            staging_source, production_source = backend_env_path.name, counterpart_path.name
        else:
            staging_env, production_env = counterpart_values, env_values
            staging_source, production_source = counterpart_path.name, backend_env_path.name
        require_distinct_supabase_projects(
            keys=SUPABASE_IDENTITY_KEYS,
            non_production_environment="staging",
            non_production_source=staging_source,
            non_production_values=staging_env,
            production_source=production_source,
            production_values=production_env,
            failures=failures,
        )

    # The Supabase publishable/anon, service-role and JWKS values live in the secrets
    # files, not the plain env files: a shared key means a shared project even when the
    # URLs were edited to look split.
    counterpart_secrets_path = backend_secrets_path.with_name(f".env.{counterpart_environment}.secrets")
    if counterpart_secrets_path.exists() and counterpart_secrets_path != backend_secrets_path:
        counterpart_secret_values = parse_required_dotenv(counterpart_secrets_path)
        if environment == "staging":
            staging_secrets, production_secrets = secret_values, counterpart_secret_values
            staging_source, production_source = backend_secrets_path.name, counterpart_secrets_path.name
        else:
            staging_secrets, production_secrets = counterpart_secret_values, secret_values
            staging_source, production_source = counterpart_secrets_path.name, backend_secrets_path.name
        require_distinct_supabase_projects(
            keys=SUPABASE_IDENTITY_KEYS,
            non_production_environment="staging",
            non_production_source=staging_source,
            non_production_values=staging_secrets,
            production_source=production_source,
            production_values=production_secrets,
            failures=failures,
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
        counterpart_values: dict[str, str] | None = resolve_mobile_env_values(
            repo_root_path, counterpart_environment, counterpart_environment
        )
    except Exception:
        counterpart_values = None

    if counterpart_values is not None:
        current_bundle = values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        other_bundle = counterpart_values.get("SPOTLIGHT_IOS_BUNDLE_IDENTIFIER", "").strip()
        warn(
            not current_bundle or not other_bundle or current_bundle != other_bundle,
            "Staging and production iOS bundle identifiers are identical; separate bundle IDs are safer for parallel installs/TestFlight lanes",
            warnings,
        )

    production_values = values if environment == "production" else counterpart_values
    if production_values is not None:
        production_source = "EAS build profile 'production' (apps/spotlight-rn/eas.json)"
        staging_values = values if environment == "staging" else counterpart_values
        if staging_values is not None:
            require_distinct_supabase_projects(
                keys=MOBILE_SUPABASE_IDENTITY_KEYS,
                non_production_environment="staging",
                non_production_source="EAS build profile 'staging' (apps/spotlight-rn/eas.json)",
                non_production_values=staging_values,
                production_source=production_source,
                production_values=production_values,
                failures=failures,
            )

        # The original bug also pointed local development at production, so every dev
        # sign-in wrote to real user accounts. Guard that profile too.
        try:
            development_values: dict[str, str] | None = resolve_mobile_env_values(
                repo_root_path, "development", "development"
            )
        except Exception:
            development_values = None
        if development_values is not None:
            require_distinct_supabase_projects(
                keys=MOBILE_SUPABASE_IDENTITY_KEYS,
                non_production_environment="development",
                non_production_source="EAS build profile 'development' (apps/spotlight-rn/eas.json)",
                non_production_values=development_values,
                production_source=production_source,
                production_values=production_values,
                failures=failures,
            )


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
    # Only the env-scoped override is honored. The generic
    # SPOTLIGHT_BACKEND_SECRETS_FILE var is deliberately ignored: a stale
    # generic value once nearly audited/shipped staging secrets against prod.
    env_override = os.environ.get(env_key, "").strip()
    candidate = env_override or str(backend_dir / f".env.{environment}.secrets")
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
