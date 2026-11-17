"""Deploy restarts spotlight-mcp.service; the MCP runner passes env + secrets through."""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from backend.tests.test_vm_runtime_config import _extract_shell_block

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = BACKEND_ROOT / "deploy_to_vm.sh"
MCP_RUNNER = BACKEND_ROOT / "run_mcp_server_vm.sh"

ASSISTANT_ENV = (
    "ASSISTANT_ENABLED",
    "ASSISTANT_MODEL",
    "ASSISTANT_DAILY_LIMIT",
    "ASSISTANT_GUEST_DAILY_LIMIT",
    "ASSISTANT_UNLIMITED_USER_IDS",
    "ASSISTANT_DAILY_SPEND_CAP_USD",
    "ASSISTANT_MAX_TOOL_ROUNDS",
    "SPOTLIGHT_MCP_IDENTIFY_DAILY_LIMIT",
)

STUBS = {
    "sudo": '#!/bin/bash\nexec "$@"\n',
    "systemctl": """#!/bin/bash
echo "systemctl $*" >> "$STUB_LOG"
case "$1" in
  cat) exit "${STUB_UNIT_RC:-0}" ;;
  restart) exit "${STUB_RESTART_RC:-0}" ;;
esac
exit 0
""",
    "curl": """#!/bin/bash
echo "curl $*" >> "$STUB_LOG"
[ "${STUB_CURL_RC:-0}" = 0 ] && printf '{"ok": true}'
exit "${STUB_CURL_RC:-0}"
""",
    "sleep": "#!/bin/bash\nexit 0\n",
}


def _write_stubs(bin_dir: Path, stubs: dict[str, str]) -> None:
    bin_dir.mkdir()
    for name, body in stubs.items():
        path = bin_dir / name
        path.write_text(body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)


class RestartMcpServiceTests(unittest.TestCase):
    """Runs the real restart_mcp_service() from deploy_to_vm.sh against stubs."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        bin_dir = self.root / "bin"
        _write_stubs(bin_dir, STUBS)
        self.log = self.root / "stub.log"
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.function = _extract_shell_block(source, "restart_mcp_service() {", "}")
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "STUB_LOG": str(self.log),
                    "SPOTLIGHT_MCP_HEALTH_ATTEMPTS": "3"}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, **stub_env: str):
        script = textwrap.dedent(
            """
            set -euo pipefail
            MCP_SERVICE_NAME=spotlight-mcp.service
            MCP_HEALTH_URL=http://127.0.0.1:8790/healthz
            """
        ) + self.function + "\nrestart_mcp_service\n"
        return subprocess.run(["bash", "-c", script], env={**self.env, **stub_env}, capture_output=True, text=True)

    def _log(self) -> str:
        return self.log.read_text() if self.log.exists() else ""

    def test_restarts_installed_unit_and_prints_health(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("systemctl restart spotlight-mcp.service", self._log())
        self.assertIn("curl -fsS --max-time 3 http://127.0.0.1:8790/healthz", self._log())
        self.assertIn('{"ok": true}', result.stdout)

    def test_missing_unit_is_a_no_op(self) -> None:
        result = self._run(STUB_UNIT_RC="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("restart", self._log())
        self.assertNotIn("curl", self._log())

    def test_unhealthy_after_restart_fails(self) -> None:
        result = self._run(STUB_CURL_RC="7")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self._log().count("curl "), 3)
        self.assertIn("never answered", result.stderr)

    def test_failed_restart_fails(self) -> None:
        result = self._run(STUB_RESTART_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("curl", self._log())

    def test_wired_after_backend_restart_for_every_environment(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        backend_wait = source.index("if ! wait_for_backend_service; then")
        call = source.index("restart_mcp_service || mcp_restart_failed=1")
        caddy = source.index("\ninstall_caddyfile\n")
        self.assertLess(backend_wait, call)
        self.assertLess(call, caddy)
        # Unconditional (not wrapped in an environment branch): staging and the
        # production path (gated upstream by SPOTLIGHT_PROD_CONFIRM) both restart.
        line_start = source.rfind("\n", 0, call) + 1
        self.assertEqual(source[line_start:call], "")
        self.assertIn('if [ "$mcp_restart_failed" -ne 0 ]; then', source)

    def test_production_gate_untouched(self) -> None:
        wrapper = (BACKEND_ROOT.parent / "tools" / "deploy_backend.sh").read_text(encoding="utf-8")
        self.assertIn('[ "$ENVIRONMENT" = "production" ] && [ "${SPOTLIGHT_PROD_CONFIRM:-}" != "yes" ]', wrapper)


class McpRunnerEnvTests(unittest.TestCase):
    """run_mcp_server_vm.sh exports everything in the env + secrets files."""

    def test_assistant_and_secret_env_reach_the_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_python = root / "python"
            dump = root / "env.dump"
            fake_python.write_text(f'#!/bin/bash\nenv > "{dump}"\n', encoding="utf-8")
            fake_python.chmod(0o755)
            env_file = root / ".env.staging"
            env_file.write_text(
                "\n".join(f"{key}=from-env-file" for key in ASSISTANT_ENV) + "\nSPOTLIGHT_MCP_PORT=8790\n",
                encoding="utf-8",
            )
            secrets = root / ".env.staging.secrets"
            secrets.write_text("ANTHROPIC_API_KEY=sk-test-not-real\n", encoding="utf-8")
            runtime = root / ".vm-runtime.conf"
            runtime.write_text(
                f"SPOTLIGHT_RUNTIME_ENV_FILE={env_file}\nSPOTLIGHT_SECRETS_FILE={secrets}\n"
                f"SPOTLIGHT_VM_PYTHON={fake_python}\nSPOTLIGHT_PORT=8788\n",
                encoding="utf-8",
            )
            clean_env = {"PATH": os.environ["PATH"], "HOME": tmp, "SPOTLIGHT_VM_RUNTIME_CONFIG": str(runtime)}
            result = subprocess.run(["bash", str(MCP_RUNNER)], env=clean_env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            seen = dict(line.split("=", 1) for line in dump.read_text().splitlines() if "=" in line)
        for key in ASSISTANT_ENV:
            self.assertEqual(seen.get(key), "from-env-file", key)
        self.assertEqual(seen.get("ANTHROPIC_API_KEY"), "sk-test-not-real")
        # identify_card derives the main backend URL from this.
        self.assertEqual(seen.get("SPOTLIGHT_PORT"), "8788")


if __name__ == "__main__":
    unittest.main()
