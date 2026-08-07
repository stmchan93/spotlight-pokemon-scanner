from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import audit_release_config
from tools.audit_release_config import (
    audit_backend,
    audit_mobile,
    require_distinct_supabase_project,
)


STAGING_PROJECT_URL = "https://stagingprojectref.supabase.co"
PRODUCTION_PROJECT_URL = "https://productionprojectref.supabase.co"
STAGING_PUBLISHABLE_KEY = "sb_publishable_stagingkeyvalue_0001"
PRODUCTION_PUBLISHABLE_KEY = "sb_publishable_productionkeyvalue_0002"


def collision_failures(failures: list[str]) -> list[str]:
    return [failure for failure in failures if failure.startswith("SUPABASE PROJECT COLLISION")]


def backend_env_text(supabase_url: str, *, environment: str) -> str:
    artifacts = (
        "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED=1\n"
        "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE=gcs\n"
        "SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET=spotlight-scan-artifacts-production\n"
        if environment == "production"
        else (
            "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED=false\n"
            "SPOTLIGHT_SCAN_ARTIFACTS_STORAGE=filesystem\n"
        )
    )
    return f"SPOTLIGHT_AUTH_REQUIRED=1\nSUPABASE_URL={supabase_url}\n{artifacts}"


def backend_secrets_text(publishable_key: str, *, environment: str) -> str:
    scrydex = (
        "SCRYDEX_API_KEY=live-scrydex-key\nSCRYDEX_TEAM_ID=live-scrydex-team\n"
        if environment == "production"
        else ""
    )
    return textwrap.dedent(
        f"""
        SUPABASE_JWT_SECRET=jwt-secret-for-{environment}
        SUPABASE_SERVICE_ROLE_KEY=service-role-secret-for-{environment}
        EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY={publishable_key}
        """
    ).lstrip() + scrydex


class SupabaseCollisionHelperTests(unittest.TestCase):
    def test_identical_value_fails_with_actionable_message(self) -> None:
        failures: list[str] = []

        require_distinct_supabase_project(
            key="SUPABASE_URL",
            non_production_environment="staging",
            non_production_source="backend/.env.staging",
            non_production_value=PRODUCTION_PROJECT_URL,
            production_source="backend/.env.production",
            production_value=PRODUCTION_PROJECT_URL,
            failures=failures,
        )

        self.assertEqual(len(failures), 1)
        message = failures[0]
        self.assertIn("SUPABASE_URL", message)
        self.assertIn("staging", message)
        self.assertIn("production", message)
        self.assertIn("backend/.env.staging", message)
        self.assertIn("backend/.env.production", message)
        self.assertIn("REAL user accounts", message)
        self.assertIn(PRODUCTION_PROJECT_URL, message)

    def test_distinct_values_pass(self) -> None:
        failures: list[str] = []

        require_distinct_supabase_project(
            key="SUPABASE_URL",
            non_production_environment="staging",
            non_production_source="backend/.env.staging",
            non_production_value=STAGING_PROJECT_URL,
            production_source="backend/.env.production",
            production_value=PRODUCTION_PROJECT_URL,
            failures=failures,
        )

        self.assertEqual(failures, [])

    def test_missing_value_on_either_side_is_not_a_collision(self) -> None:
        failures: list[str] = []

        require_distinct_supabase_project(
            key="SUPABASE_SERVICE_ROLE_KEY",
            non_production_environment="staging",
            non_production_source="backend/.env.staging.secrets",
            non_production_value="",
            production_source="backend/.env.production.secrets",
            production_value="",
            failures=failures,
        )

        self.assertEqual(failures, [])

    def test_secret_values_are_redacted_in_the_message(self) -> None:
        failures: list[str] = []
        shared_secret = "service-role-secret-shared-between-environments"

        require_distinct_supabase_project(
            key="SUPABASE_SERVICE_ROLE_KEY",
            non_production_environment="staging",
            non_production_source="backend/.env.staging.secrets",
            non_production_value=shared_secret,
            production_source="backend/.env.production.secrets",
            production_value=shared_secret,
            failures=failures,
        )

        self.assertEqual(len(failures), 1)
        self.assertNotIn(shared_secret, failures[0])
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", failures[0])


class BackendSupabaseCollisionTests(unittest.TestCase):
    def run_backend_audit(
        self,
        *,
        environment: str,
        staging_url: str,
        production_url: str,
        staging_key: str = STAGING_PUBLISHABLE_KEY,
        production_key: str = PRODUCTION_PUBLISHABLE_KEY,
    ) -> list[str]:
        failures: list[str] = []
        warnings: list[str] = []
        with tempfile.TemporaryDirectory() as tempdir:
            backend_dir = Path(tempdir)
            (backend_dir / ".env.staging").write_text(
                backend_env_text(staging_url, environment="staging"), encoding="utf-8"
            )
            (backend_dir / ".env.production").write_text(
                backend_env_text(production_url, environment="production"), encoding="utf-8"
            )
            (backend_dir / ".env.staging.secrets").write_text(
                backend_secrets_text(staging_key, environment="staging"), encoding="utf-8"
            )
            (backend_dir / ".env.production.secrets").write_text(
                backend_secrets_text(production_key, environment="production"), encoding="utf-8"
            )

            audit_backend(
                environment=environment,
                backend_env_path=backend_dir / f".env.{environment}",
                backend_secrets_path=backend_dir / f".env.{environment}.secrets",
                failures=failures,
                warnings=warnings,
            )
        return failures

    def test_split_supabase_projects_report_no_collision(self) -> None:
        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                failures = self.run_backend_audit(
                    environment=environment,
                    staging_url=STAGING_PROJECT_URL,
                    production_url=PRODUCTION_PROJECT_URL,
                )
                self.assertEqual(collision_failures(failures), [])

    def test_shared_supabase_url_fails_from_either_environment(self) -> None:
        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                failures = self.run_backend_audit(
                    environment=environment,
                    staging_url=PRODUCTION_PROJECT_URL,
                    production_url=PRODUCTION_PROJECT_URL,
                )
                collisions = collision_failures(failures)
                self.assertEqual(len(collisions), 1)
                self.assertIn("SUPABASE_URL", collisions[0])
                self.assertIn(".env.staging", collisions[0])
                self.assertIn(".env.production", collisions[0])
                self.assertIn("REAL user accounts", collisions[0])

    def test_shared_publishable_key_fails_even_when_urls_differ(self) -> None:
        failures = self.run_backend_audit(
            environment="staging",
            staging_url=STAGING_PROJECT_URL,
            production_url=PRODUCTION_PROJECT_URL,
            staging_key=PRODUCTION_PUBLISHABLE_KEY,
            production_key=PRODUCTION_PUBLISHABLE_KEY,
        )

        collisions = collision_failures(failures)
        self.assertEqual(len(collisions), 1)
        self.assertIn("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY", collisions[0])
        self.assertIn(".env.staging.secrets", collisions[0])
        self.assertIn(".env.production.secrets", collisions[0])


class MobileSupabaseCollisionTests(unittest.TestCase):
    @staticmethod
    def profile_values(url: str, key: str) -> dict[str, str]:
        return {
            "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL": "https://looty.example-host.test",
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL": url,
            "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY": key,
            "EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL": "looty://auth-callback",
            "EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME": "looty",
            "SPOTLIGHT_APP_SCHEME": "looty",
            "SPOTLIGHT_EXPO_OWNER": "looty-owner",
            "SPOTLIGHT_EAS_PROJECT_ID": "bd29d8aa-8a70-45ba-907e-f7136f2be4ff",
            "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER": "com.looty.app",
            "SPOTLIGHT_ANDROID_PACKAGE": "com.looty.app",
        }

    def run_mobile_audit(self, environment: str, profiles: dict[str, dict[str, str]]) -> list[str]:
        failures: list[str] = []
        warnings: list[str] = []

        def fake_resolve(root: Path, resolved_environment: str, profile: str | None = None) -> dict[str, str]:
            return profiles[resolved_environment]

        with patch.object(audit_release_config, "resolve_mobile_env_values", fake_resolve):
            audit_mobile(environment=environment, failures=failures, warnings=warnings)
        return failures

    def split_profiles(self) -> dict[str, dict[str, str]]:
        return {
            "development": self.profile_values(STAGING_PROJECT_URL, STAGING_PUBLISHABLE_KEY),
            "staging": self.profile_values(STAGING_PROJECT_URL, STAGING_PUBLISHABLE_KEY),
            "production": self.profile_values(PRODUCTION_PROJECT_URL, PRODUCTION_PUBLISHABLE_KEY),
        }

    def test_split_profiles_report_no_collision(self) -> None:
        profiles = self.split_profiles()
        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                self.assertEqual(collision_failures(self.run_mobile_audit(environment, profiles)), [])

    def test_staging_profile_pointing_at_production_fails(self) -> None:
        profiles = self.split_profiles()
        profiles["staging"] = self.profile_values(PRODUCTION_PROJECT_URL, PRODUCTION_PUBLISHABLE_KEY)

        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                collisions = collision_failures(self.run_mobile_audit(environment, profiles))
                self.assertEqual(len(collisions), 2)
                self.assertTrue(any("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL" in item for item in collisions))
                self.assertTrue(any("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY" in item for item in collisions))
                for item in collisions:
                    self.assertIn("EAS build profile 'staging'", item)
                    self.assertIn("EAS build profile 'production'", item)
                    self.assertIn("REAL user accounts", item)

    def test_shared_publishable_key_fails_even_when_urls_differ(self) -> None:
        profiles = self.split_profiles()
        profiles["staging"] = self.profile_values(STAGING_PROJECT_URL, PRODUCTION_PUBLISHABLE_KEY)
        profiles["development"] = profiles["staging"]

        collisions = collision_failures(self.run_mobile_audit("staging", profiles))

        self.assertEqual(len(collisions), 2)
        for item in collisions:
            self.assertIn("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY", item)

    def test_development_profile_pointing_at_production_fails(self) -> None:
        profiles = self.split_profiles()
        profiles["development"] = self.profile_values(PRODUCTION_PROJECT_URL, PRODUCTION_PUBLISHABLE_KEY)

        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                collisions = collision_failures(self.run_mobile_audit(environment, profiles))
                self.assertEqual(len(collisions), 2)
                for item in collisions:
                    self.assertIn("EAS build profile 'development'", item)
                    self.assertIn("EAS build profile 'production'", item)


if __name__ == "__main__":
    unittest.main()
