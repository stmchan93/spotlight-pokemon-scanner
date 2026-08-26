from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = BACKEND_ROOT / "deploy_to_vm.sh"
MODERATION_RUNNER = BACKEND_ROOT / "run_social_moderation_vm.sh"


def _extract_shell_block(source: str, opening_prefix: str, closing: str) -> str:
    """Pull a real block out of deploy_to_vm.sh so tests exercise shipped code.

    Copying the logic into the test would only assert that the copy works, which
    is exactly the failure mode these tests exist to catch.
    """
    lines = source.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(opening_prefix):
            for end in range(index + 1, len(lines)):
                if lines[end] == closing:
                    return "\n".join(lines[index : end + 1])
            break
    raise AssertionError(f"could not find a block starting with {opening_prefix!r}")


def _extract_heredoc(source: str, opening_line: str) -> str:
    """Pull the body of a quoted `<<'PY'` heredoc out of deploy_to_vm.sh."""
    lines = source.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == opening_line:
            body: list[str] = []
            for candidate in lines[index + 1 :]:
                if candidate == "PY":
                    return "\n".join(body)
                body.append(candidate)
            break
    raise AssertionError(f"could not find a heredoc opened by {opening_line!r}")


class VMRuntimeConfigTests(unittest.TestCase):
    def test_shell_escaped_cron_schedule_sources_as_literal(self) -> None:
        runtime_config = textwrap.dedent(
            """
            SPOTLIGHT_VM_SYNC_CRON=0\\ 6,18\\ \\*\\ \\*\\ \\*
            SPOTLIGHT_VM_SYNC_CRON_TZ=America/Los_Angeles
            SPOTLIGHT_SYNC_LOCK_FILE=/home/stephenchan/spotlight/data/scrydex-sync.lock
            """
        ).strip()

        with tempfile.TemporaryDirectory() as tempdir:
            config_path = Path(tempdir) / ".vm-runtime.conf"
            config_path.write_text(runtime_config + "\n", encoding="utf-8")

            result = subprocess.run(
                [
                    "bash",
                    "-lc",
                    f"set -a; . '{config_path}'; printf '%s\\n%s\\n%s' "
                    '"$SPOTLIGHT_VM_SYNC_CRON" "$SPOTLIGHT_VM_SYNC_CRON_TZ" "$SPOTLIGHT_SYNC_LOCK_FILE"',
                ],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertEqual(
            result.stdout.splitlines(),
            [
                "0 6,18 * * *",
                "America/Los_Angeles",
                "/home/stephenchan/spotlight/data/scrydex-sync.lock",
            ],
        )


class ModerationCronScheduleTests(unittest.TestCase):
    """The social-moderation cron entry in deploy_to_vm.sh.

    This job is not optional polish: RLS hides `post_media` rows until the worker
    approves them, so if this entry stops being installed, every posted image
    becomes permanently invisible to everyone but its author.
    """

    def setUp(self) -> None:
        self.source = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    def test_schedule_is_overridable_with_a_two_minute_default(self) -> None:
        self.assertIn(
            'MODERATION_CRON_SCHEDULE="${SPOTLIGHT_VM_MODERATION_CRON:-*/2 * * * *}"',
            self.source,
        )

    def test_cron_line_uses_the_variable_not_a_hardcoded_schedule(self) -> None:
        (line,) = [
            line
            for line in self.source.splitlines()
            if line.startswith("SOCIAL_MODERATION_LINE=")
        ]
        self.assertTrue(
            line.startswith('SOCIAL_MODERATION_LINE="$MODERATION_CRON_SCHEDULE '),
            f"override env var is bypassed by a hardcoded schedule: {line}",
        )
        # --once, not --loop: cron owns the cadence so a crashed run self-heals.
        self.assertIn("run_social_moderation_vm.sh", line)
        self.assertNotIn("--loop", line)

    def test_entry_is_installed_on_both_environments(self) -> None:
        # The Scrydex/PPT jobs are production-only; moderation must NOT be, because
        # staging is where the users are.
        production_only = _extract_shell_block(
            self.source, '  if [ "$ENVIRONMENT" = "production" ]; then', "  fi"
        )
        self.assertIn("$SYNC_LINE", production_only)
        self.assertNotIn("$SOCIAL_MODERATION_LINE", production_only)
        self.assertIn('  echo "$SOCIAL_MODERATION_LINE"', self.source)

    def test_deploy_refuses_to_run_without_flock(self) -> None:
        # The cron entry relies on flock for its overlap guard, so the deploy has
        # to verify flock exists rather than let the guard silently no-op.
        self.assertIn('if ! command -v flock >/dev/null 2>&1; then', self.source)

    def test_closing_summary_reports_the_log_path(self) -> None:
        summary = [
            line for line in self.source.splitlines() if line.startswith('echo "  ')
        ]
        self.assertTrue(
            any("$SOCIAL_MODERATION_LOG_FILE" in line for line in summary),
            "deploy summary never names the moderation log path",
        )
        self.assertTrue(
            any("$MODERATION_CRON_SCHEDULE" in line for line in summary),
            "deploy summary never names the moderation schedule",
        )

    # --- the shipped validation loop, executed ------------------------------- #

    def _run_schedule_validation(self, moderation_cron: str) -> subprocess.CompletedProcess:
        block = _extract_shell_block(self.source, "for schedule_var in ", "done")
        self.assertIn("MODERATION_CRON_SCHEDULE", block)
        script = "\n".join(
            [
                "set -euo pipefail",
                "SYNC_CRON_SCHEDULE='0 18 * * *'",
                "TCGCSV_SYNC_CRON_SCHEDULE='5 13 * * *'",
                "HEALTH_CRON_SCHEDULE='*/5 * * * *'",
                "RESOURCE_CRON_SCHEDULE='*/15 * * * *'",
                'MODERATION_CRON_SCHEDULE="$1"',
                block,
                "echo VALIDATED",
            ]
        )
        return subprocess.run(
            ["bash", "-c", script, "bash", moderation_cron],
            capture_output=True,
            text=True,
        )

    def test_valid_schedule_passes_validation(self) -> None:
        result = self._run_schedule_validation("*/2 * * * *")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("VALIDATED", result.stdout)

    def test_empty_schedule_is_rejected(self) -> None:
        result = self._run_schedule_validation("")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODERATION_CRON_SCHEDULE", result.stderr)

    def test_multiline_schedule_is_rejected(self) -> None:
        # A newline would smuggle an extra crontab entry into the managed block.
        result = self._run_schedule_validation("*/2 * * * *\n* * * * * rm -rf /")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODERATION_CRON_SCHEDULE", result.stderr)


class ManagedCrontabMarkerTests(unittest.TestCase):
    """The begin/end marker discipline that lets a redeploy replace, not append."""

    def _filter(self, crontab_text: str) -> str:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        program = _extract_heredoc(
            source,
            'python3 - "$CURRENT_CRONTAB" "$CRON_BEGIN" "$CRON_END" <<\'PY\'',
        )
        with tempfile.TemporaryDirectory() as tempdir:
            crontab_path = Path(tempdir) / "crontab"
            crontab_path.write_text(crontab_text, encoding="utf-8")
            script_path = Path(tempdir) / "filter.py"
            script_path.write_text(program, encoding="utf-8")
            subprocess.run(
                [
                    "python3",
                    str(script_path),
                    str(crontab_path),
                    "# BEGIN spotlight-backend-vm",
                    "# END spotlight-backend-vm",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return crontab_path.read_text(encoding="utf-8")

    def test_previous_managed_block_is_stripped_before_reinstall(self) -> None:
        existing = textwrap.dedent(
            """\
            # BEGIN spotlight-backend-vm
            */2 * * * * cd /home/x && /home/x/run_social_moderation_vm.sh
            # END spotlight-backend-vm
            """
        )
        self.assertEqual(self._filter(existing).strip(), "")

    def test_unmanaged_lines_survive(self) -> None:
        existing = textwrap.dedent(
            """\
            0 3 * * * /usr/local/bin/somebody-elses-job
            # BEGIN spotlight-backend-vm
            */2 * * * * /home/x/run_social_moderation_vm.sh
            # END spotlight-backend-vm
            @reboot /usr/local/bin/another-job
            """
        )
        remaining = self._filter(existing).splitlines()
        self.assertEqual(
            remaining,
            [
                "0 3 * * * /usr/local/bin/somebody-elses-job",
                "@reboot /usr/local/bin/another-job",
            ],
        )

    def test_reinstall_is_idempotent_not_cumulative(self) -> None:
        # Two deploys in a row must leave one moderation entry, not two.
        block = (
            "# BEGIN spotlight-backend-vm\n"
            "*/2 * * * * /home/x/run_social_moderation_vm.sh\n"
            "# END spotlight-backend-vm\n"
        )
        after_first = self._filter(block) + block
        after_second = self._filter(after_first) + block
        self.assertEqual(after_second.count("run_social_moderation_vm.sh"), 1)


# A stand-in for util-linux flock(1), which macOS does not ship. It implements
# only what run_social_moderation_vm.sh uses -- `flock -n <fd>` on an inherited
# descriptor -- with the same semantics: the lock rides the open file
# description, so it stays held by the calling shell after this process exits.
_FLOCK_SHIM = """#!/usr/bin/env python3
import fcntl
import sys

args = [arg for arg in sys.argv[1:] if arg != "-n"]
try:
    fcntl.flock(int(args[0]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)
"""


class ModerationRunnerTests(unittest.TestCase):
    """run_social_moderation_vm.sh: overlap guard and loud missing-config lines."""

    def setUp(self) -> None:
        self.tempdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tempdir, True)
        self.sentinel = self.tempdir / "worker-invocations.log"
        self.lock_file = self.tempdir / "social-moderation.lock"

        self.flock_shim = self.tempdir / "flock"
        self.flock_shim.write_text(_FLOCK_SHIM, encoding="utf-8")
        self.flock_shim.chmod(0o755)

    def _write_fake_python(self, sleep_seconds: float = 0.0, name: str = "fake-python") -> Path:
        path = self.tempdir / name
        path.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/bash
                echo "invoked $*" >> {self.sentinel}
                sleep {sleep_seconds}
                """
            ),
            encoding="utf-8",
        )
        path.chmod(0o755)
        return path

    def _write_runtime_config(self, values: dict[str, str]) -> Path:
        path = self.tempdir / ".vm-runtime.conf"
        path.write_text(
            "".join(f"{key}={value}\n" for key, value in values.items()),
            encoding="utf-8",
        )
        return path

    def _config_values(self, **overrides: str) -> dict[str, str]:
        values = {
            "SPOTLIGHT_VM_PYTHON": str(self._write_fake_python()),
            "SPOTLIGHT_SOCIAL_MODERATION_LOCK_FILE": str(self.lock_file),
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
            "OPENAI_API_KEY": "sk-test",
            "SPOTLIGHT_POST_MEDIA_GCS_BUCKET": "looty-post-media",
        }
        for key, value in overrides.items():
            if value == "":
                values.pop(key, None)
            else:
                values[key] = value
        return values

    def _env(self, config_path: Path) -> dict[str, str]:
        # A fresh env, so a real OPENAI_API_KEY in the developer's shell cannot
        # make the missing-config tests pass by accident.
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "SPOTLIGHT_VM_RUNTIME_CONFIG": str(config_path),
            "FLOCK_BIN_OVERRIDE": str(self.flock_shim),
        }

    def _run(self, config_path: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(MODERATION_RUNNER)],
            capture_output=True,
            text=True,
            env=self._env(config_path),
        )

    def _invocations(self) -> list[str]:
        if not self.sentinel.exists():
            return []
        return [
            line
            for line in self.sentinel.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_worker_runs_once_when_fully_configured(self) -> None:
        result = self._run(self._write_runtime_config(self._config_values()))

        self.assertEqual(result.returncode, 0, result.stderr)
        (invocation,) = self._invocations()
        self.assertIn("social_moderation_worker.py", invocation)
        self.assertIn("--once", invocation)
        self.assertNotIn("--loop", invocation)
        self.assertNotIn("moderation disabled", result.stdout)

    def test_missing_credentials_log_a_greppable_disabled_line(self) -> None:
        config = self._write_runtime_config(
            self._config_values(SUPABASE_URL="", OPENAI_API_KEY="")
        )

        result = self._run(config)

        # Exit 0 so cron does not mail the operator every two minutes...
        self.assertEqual(result.returncode, 0, result.stderr)
        # ...but the log must say so, and name every missing var.
        self.assertIn(
            "moderation disabled: missing SUPABASE_URL, OPENAI_API_KEY",
            result.stdout,
        )
        # Never a silent no-op: the worker must not have been invoked at all.
        self.assertEqual(self._invocations(), [])

    def test_missing_bucket_disables_images_but_still_runs_the_text_pass(self) -> None:
        config = self._write_runtime_config(
            self._config_values(SPOTLIGHT_POST_MEDIA_GCS_BUCKET="")
        )

        result = self._run(config)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "image moderation disabled: missing SPOTLIGHT_POST_MEDIA_GCS_BUCKET",
            result.stdout,
        )
        self.assertEqual(len(self._invocations()), 1)

    def test_overlapping_tick_is_skipped_while_the_lock_is_held(self) -> None:
        # A distinct filename: _config_values() rewrites the default fake python,
        # which would otherwise clobber this one and make the run finish instantly.
        slow_python = self._write_fake_python(sleep_seconds=5, name="slow-fake-python")
        config = self._write_runtime_config(
            self._config_values(SPOTLIGHT_VM_PYTHON=str(slow_python))
        )

        first = subprocess.Popen(
            ["bash", str(MODERATION_RUNNER)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self._env(config),
        )
        def _reap() -> None:
            first.kill()
            first.communicate()  # also closes the pipes

        self.addCleanup(_reap)

        # Wait until the first run is genuinely inside the worker (lock held).
        deadline = time.time() + 10
        while time.time() < deadline and not self._invocations():
            time.sleep(0.05)
        self.assertEqual(len(self._invocations()), 1, "first run never started")

        second = self._run(config)

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("previous run still in progress", second.stdout)
        # The whole point: the second tick did NOT start a duplicate worker.
        self.assertEqual(len(self._invocations()), 1)

    def test_lock_is_released_when_the_run_finishes(self) -> None:
        config = self._write_runtime_config(self._config_values())

        self.assertEqual(self._run(config).returncode, 0)
        second = self._run(config)

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotIn("previous run still in progress", second.stdout)
        self.assertEqual(len(self._invocations()), 2)


if __name__ == "__main__":
    unittest.main()
