from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from backend import vm_caddyfile
from backend.tests.test_vm_runtime_config import _extract_shell_block

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RENDERER = BACKEND_ROOT / "vm_caddyfile.py"
DEPLOY_SCRIPT = BACKEND_ROOT / "deploy_to_vm.sh"

# Baked into shipped App Store / TestFlight binaries and old OTA bundles.
LEGACY_HOSTS = {
    "staging": "looty.34.134.72.20.sslip.io",
    "production": "looty.34.59.188.129.sslip.io",
}


def _dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


class ParseHostsTests(unittest.TestCase):
    def test_primary_first_then_aliases_deduped(self) -> None:
        hosts = vm_caddyfile.parse_hosts(
            "Looty.34.134.72.20.sslip.io",
            "staging-api.ekalight.com, looty.34.134.72.20.sslip.io  extra.ekalight.com.",
        )
        self.assertEqual(
            hosts,
            ["looty.34.134.72.20.sslip.io", "staging-api.ekalight.com", "extra.ekalight.com"],
        )

    def test_empty_aliases(self) -> None:
        self.assertEqual(vm_caddyfile.parse_hosts("api.ekalight.com", ""), ["api.ekalight.com"])

    def test_refuses_anything_that_is_not_a_plain_hostname(self) -> None:
        for bad in (
            "",
            "https://api.ekalight.com",
            "api.ekalight.com:443",
            "api.ekalight.com {",
            "*.ekalight.com",
            "localhost",
            "api.ekalight.com}\nevil.com",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(vm_caddyfile.CaddyfileError):
                    vm_caddyfile.parse_hosts(bad, "")
        with self.assertRaises(vm_caddyfile.CaddyfileError):
            vm_caddyfile.parse_hosts("api.ekalight.com", "ok.ekalight.com,{bad}")


class RenderTests(unittest.TestCase):
    def test_one_site_block_serves_every_host(self) -> None:
        text = vm_caddyfile.render_caddyfile(
            ["looty.34.59.188.129.sslip.io", "api.ekalight.com"], mcp_routes=False
        )
        self.assertIn("looty.34.59.188.129.sslip.io, api.ekalight.com {\n", text)
        self.assertIn("\treverse_proxy 127.0.0.1:8788\n", text)
        self.assertNotIn("8790", text)
        self.assertEqual(text.count("{"), text.count("}"))

    def test_mcp_routes_match_the_hand_built_staging_config(self) -> None:
        text = vm_caddyfile.render_caddyfile(["looty.34.134.72.20.sslip.io"], mcp_routes=True)
        self.assertIn(
            "@mcp path /mcp /mcp/* /.well-known/oauth-protected-resource "
            "/.well-known/oauth-protected-resource/* /oauth/consent /api/v1/assistant/*",
            text,
        )
        self.assertIn("handle @mcp {\n\t\treverse_proxy 127.0.0.1:8790\n\t}", text)
        self.assertIn("handle {\n\t\treverse_proxy 127.0.0.1:8788\n\t}", text)

    def test_cli_rejects_bad_host_with_nonzero_exit(self) -> None:
        result = subprocess.run(
            [sys.executable, str(RENDERER), "--primary-host", "bad host"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_cli_print_hosts(self) -> None:
        result = subprocess.run(
            [sys.executable, str(RENDERER), "--primary-host", "a.ekalight.com", "--aliases", "b.ekalight.com", "--print-hosts"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(result.stdout, "a.ekalight.com,b.ekalight.com\n")


class CommittedEnvTests(unittest.TestCase):
    def test_every_env_keeps_serving_its_legacy_sslip_host(self) -> None:
        for environment, legacy in LEGACY_HOSTS.items():
            with self.subTest(environment=environment):
                values = _dotenv(BACKEND_ROOT / f".env.{environment}")
                hosts = vm_caddyfile.parse_hosts(
                    values.get("SPOTLIGHT_PUBLIC_HOST", ""),
                    values.get("SPOTLIGHT_PUBLIC_HOST_ALIASES", ""),
                )
                self.assertIn(legacy, hosts)

    def test_environments_never_share_a_host(self) -> None:
        seen: dict[str, str] = {}
        for environment in LEGACY_HOSTS:
            values = _dotenv(BACKEND_ROOT / f".env.{environment}")
            for host in vm_caddyfile.parse_hosts(
                values["SPOTLIGHT_PUBLIC_HOST"], values.get("SPOTLIGHT_PUBLIC_HOST_ALIASES", "")
            ):
                self.assertNotIn(host, seen, f"{host} listed for {seen.get(host)} and {environment}")
                seen[host] = environment

    def test_deploy_script_installs_the_caddyfile(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('read_dotenv_value "$ENV_FILE" "SPOTLIGHT_PUBLIC_HOST"', source)
        self.assertIn('read_dotenv_value "$ENV_FILE" "SPOTLIGHT_PUBLIC_HOST_ALIASES"', source)
        self.assertIn("caddy validate --adapter caddyfile", source)
        self.assertIn('write_runtime_override "SPOTLIGHT_MCP_ALLOWED_HOSTS" "$PUBLIC_HOSTS"', source)
        self.assertIn("\ninstall_caddyfile\n", source)


STUBS = {
    # sudo runs the command as us; drop install's root ownership flags.
    "sudo": """#!/bin/bash
args=()
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -o|-g) skip=1; continue ;; esac
  args+=("$a")
done
exec "${args[@]}"
""",
    "systemctl": """#!/bin/bash
echo "systemctl $*" >> "$STUB_LOG"
case "$1" in
  cat) exit "${STUB_MCP_UNIT_RC:-1}" ;;
  reload) exit "${STUB_RELOAD_RC:-0}" ;;
esac
exit 0
""",
    "caddy": """#!/bin/bash
echo "caddy $*" >> "$STUB_LOG"
[ "$1" = validate ] && exit "${STUB_VALIDATE_RC:-0}"
exit 0
""",
}


class InstallCaddyfileShellTests(unittest.TestCase):
    """Runs the real install_caddyfile() from deploy_to_vm.sh against stubs."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in STUBS.items():
            path = bin_dir / name
            path.write_text(body, encoding="utf-8")
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        self.caddyfile = self.root / "Caddyfile"
        self.caddyfile.write_text("looty.34.59.188.129.sslip.io {\n\treverse_proxy 127.0.0.1:8788\n}\n")
        self.log = self.root / "stub.log"
        self.function = _extract_shell_block(DEPLOY_SCRIPT.read_text(encoding="utf-8"), "install_caddyfile() {", "}")
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "STUB_LOG": str(self.log),
            "SPOTLIGHT_CADDYFILE_PATH": str(self.caddyfile),
            "TMPDIR": str(self.root),
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, *, primary: str = "looty.34.59.188.129.sslip.io", aliases: str = "api.ekalight.com", **stub_env: str):
        script = textwrap.dedent(
            f"""
            set -euo pipefail
            SCRIPT_DIR={BACKEND_ROOT}
            ENV_FILE=/dev/null
            PUBLIC_HOST='{primary}'
            PUBLIC_HOST_ALIASES='{aliases}'
            PUBLIC_HOSTS='{primary},{aliases}'
            CADDY_MCP_ROUTES=auto
            """
        ) + self.function + "\ninstall_caddyfile\n"
        return subprocess.run(
            ["bash", "-c", script], env={**self.env, **stub_env}, capture_output=True, text=True
        )

    def _log(self) -> str:
        return self.log.read_text() if self.log.exists() else ""

    def test_installs_both_hosts_and_reloads(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("looty.34.59.188.129.sslip.io, api.ekalight.com {", self.caddyfile.read_text())
        self.assertIn("systemctl reload caddy", self._log())
        self.assertEqual(len(list(self.root.glob("Caddyfile.pre-deploy-*"))), 1)

    def test_unchanged_config_does_not_reload(self) -> None:
        self.assertEqual(self._run().returncode, 0)
        self.log.unlink()
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("reload", self._log())

    def test_mcp_routes_follow_the_installed_unit(self) -> None:
        self.assertEqual(self._run(STUB_MCP_UNIT_RC="0").returncode, 0)
        self.assertIn("reverse_proxy 127.0.0.1:8790", self.caddyfile.read_text())

    def test_failed_validation_leaves_the_live_file_alone(self) -> None:
        before = self.caddyfile.read_text()
        result = self._run(STUB_VALIDATE_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.caddyfile.read_text(), before)
        self.assertNotIn("reload", self._log())

    def test_failed_reload_restores_the_previous_file(self) -> None:
        before = self.caddyfile.read_text()
        result = self._run(STUB_RELOAD_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.caddyfile.read_text(), before)

    def test_unset_primary_is_a_no_op(self) -> None:
        before = self.caddyfile.read_text()
        result = self._run(primary="", aliases="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.caddyfile.read_text(), before)
        self.assertEqual(self._log(), "")


if __name__ == "__main__":
    unittest.main()
