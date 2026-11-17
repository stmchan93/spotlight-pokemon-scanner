"""Render the VM's /etc/caddy/Caddyfile from the env file (deploy_to_vm.sh).

One site block answers on every public hostname of the box: the legacy
`looty.<ip>.sslip.io` name (baked into shipped binaries and old OTA bundles, so
it must keep working) plus any ekalight.com aliases. Caddy manages each name's
certificate on its own, in the background, so a name whose DNS isn't live yet
just keeps retrying its ACME order; the other names keep serving.
"""

from __future__ import annotations

import argparse
import re
import sys

BACKEND_UPSTREAM = "127.0.0.1:8788"
MCP_UPSTREAM = "127.0.0.1:8790"
# Paths owned by the separate MCP process (spotlight-mcp.service), incl. the
# in-app assistant API. `handle @mcp` wins over the matcher-less catch-all
# `handle` (Caddy sorts handles by matcher specificity; only one runs).
MCP_PATHS = (
    "/mcp",
    "/mcp/*",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/*",
    "/oauth/consent",
    "/api/v1/assistant",
    "/api/v1/assistant/*",
)

# Plain DNS names only: a value lands verbatim in the Caddyfile, so anything
# else (spaces, braces, schemes, ports, wildcards) is refused, not escaped.
_HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class CaddyfileError(ValueError):
    pass


def parse_hosts(primary: str, aliases: str) -> list[str]:
    """Primary first, then aliases (comma or whitespace separated), deduped."""
    if not primary or not primary.strip():
        raise CaddyfileError("primary host is required")
    hosts: list[str] = []
    for raw in [primary, *re.split(r"[,\s]+", aliases or "")]:
        host = (raw or "").strip().lower().rstrip(".")
        if not host:
            continue
        if not _HOSTNAME_RE.match(host):
            raise CaddyfileError(f"not a plain hostname: {raw!r}")
        if host not in hosts:
            hosts.append(host)
    return hosts


def render_caddyfile(hosts: list[str], *, mcp_routes: bool) -> str:
    if not hosts:
        raise CaddyfileError("at least one host is required")
    lines = [
        "# Managed by backend/deploy_to_vm.sh (backend/vm_caddyfile.py).",
        "# Hand edits are overwritten on the next deploy: change SPOTLIGHT_PUBLIC_HOST /",
        "# SPOTLIGHT_PUBLIC_HOST_ALIASES in backend/.env.<environment> instead.",
        f"{', '.join(hosts)} {{",
        "\tencode gzip zstd",
    ]
    if mcp_routes:
        lines += [
            "\t# Ekalight MCP server (separate process; see spotlight-mcp.service)",
            f"\t@mcp path {' '.join(MCP_PATHS)}",
            "\thandle @mcp {",
            f"\t\treverse_proxy {MCP_UPSTREAM}",
            "\t}",
            "\thandle {",
            f"\t\treverse_proxy {BACKEND_UPSTREAM}",
            "\t}",
        ]
    else:
        lines.append(f"\treverse_proxy {BACKEND_UPSTREAM}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--primary-host", required=True)
    parser.add_argument("--aliases", default="")
    parser.add_argument("--mcp-routes", choices=("0", "1"), default="0")
    parser.add_argument(
        "--print-hosts",
        action="store_true",
        help="print the comma-joined host list instead of the Caddyfile",
    )
    args = parser.parse_args(argv)
    try:
        hosts = parse_hosts(args.primary_host, args.aliases)
        output = ",".join(hosts) + "\n" if args.print_hosts else render_caddyfile(hosts, mcp_routes=args.mcp_routes == "1")
    except CaddyfileError as error:
        print(f"vm_caddyfile: {error}", file=sys.stderr)
        return 2
    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
