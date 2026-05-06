from __future__ import annotations

import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
