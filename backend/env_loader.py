from __future__ import annotations

import os
from pathlib import Path


def load_backend_env_file(env_path: Path) -> None:
    """Load backend/.env without requiring python-dotenv at runtime."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        if not env_path.exists():
            return
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            parsed_value = value.strip()
            if (
                len(parsed_value) >= 2
                and parsed_value[0] == parsed_value[-1]
                and parsed_value[0] in {'"', "'"}
            ):
                parsed_value = parsed_value[1:-1]
            os.environ[key] = parsed_value
        return

    load_dotenv(env_path, override=False)
