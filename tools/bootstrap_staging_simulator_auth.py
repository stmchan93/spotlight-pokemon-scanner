#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from tools.mobile_env_resolver import resolve_mobile_env_values
except ModuleNotFoundError:  # pragma: no cover - direct script execution path
    from mobile_env_resolver import resolve_mobile_env_values


def require_env(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    mobile_env = resolve_mobile_env_values(repo_root, "staging", "staging")
    supabase_url = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL") or "").strip().rstrip("/")
    anon_key = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY") or "").strip()
    redirect_url = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL") or "").strip()
    auth_scheme = str(mobile_env.get("EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME") or "").strip() or "spotlight"
    if not redirect_url:
        redirect_url = f"{auth_scheme}://login-callback"

    if not supabase_url or not anon_key:
        raise RuntimeError("Staging mobile env must define Supabase URL and anon key.")

    email = require_env("SPOTLIGHT_STAGING_SMOKE_EMAIL")
    password = require_env("SPOTLIGHT_STAGING_SMOKE_PASSWORD")

    payload = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{supabase_url}/auth/v1/token?grant_type=password",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "apikey": anon_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        auth_payload = json.loads(response.read().decode("utf-8"))

    access_token = str(auth_payload.get("access_token") or "").strip()
    refresh_token = str(auth_payload.get("refresh_token") or "").strip()
    if not access_token or not refresh_token:
        raise RuntimeError("Supabase password login did not return access_token and refresh_token.")

    fragment = urllib.parse.urlencode(
        {
            "access_token": access_token,
            "refresh_token": refresh_token,
        },
        quote_via=urllib.parse.quote,
    )
    print(f"{redirect_url}#{fragment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
