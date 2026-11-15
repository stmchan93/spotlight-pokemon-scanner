#!/usr/bin/env python3
"""Fill STAGING with a mock show so every booth-post feature can be tried on a phone.

    python3 tools/seed_booth_test_show.py                 # --plan: read-only, prints what it would do
    python3 tools/seed_booth_test_show.py --apply [--me-email you@example.com] [--save-credentials]
    python3 tools/seed_booth_test_show.py --refresh-live  # "N browsing" + flames again (they decay)
    python3 tools/seed_booth_test_show.py --cleanup       # removes everything the seed created

Staging only. The Supabase URL must be the staging project and the backend URL
the staging box; anything else is refused before a single request goes out.
There is no production mode.

What --apply does (idempotent; a re-run converges instead of duplicating):

1. Writes the show's floor map next to the real ones (gitignored, see
   .gitignore): Hawaii's tables + walls image with 20 fake ``test-*`` vendors.
   The VM only gets these files with the next staging backend deploy.
2. Upserts show ``ekalight-test-show`` through the admin events API (ops
   token), dated today..tomorrow in America/Los_Angeles so it is in its booth window.
3. Creates/refreshes 8 mock accounts (booth-test-N@ekalight.test, confirmed,
   fresh random password each run, never printed) with @handles.
4. Signs in as 5 of them and calls claim_booth, the app's own RPC.
5. Posts as those users through PostgREST (moderation triggers run), with
   placeholder JPEGs uploaded through the backend's /api/v1/post-media.
6. Inserts a few hours of booth_events (service role) so stats have numbers,
   then stamps presence + recent card opens ("N browsing", flames).

Credentials: backend/.env.staging + backend/.env.staging.secrets (SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, SPOTLIGHT_OPS_REFRESH_TOKEN, anon key); the anon key
and backend URL fall back to the staging profile in apps/spotlight-rn/eas.json.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import random
import secrets
import shutil
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
BACKEND = REPO / "backend"
MAPS_DIR = BACKEND / "data" / "spotlight_event_maps"
EAS_JSON = REPO / "apps" / "spotlight-rn" / "eas.json"
SOURCE_MAP_ID = "hawaii-2026-10"
SCRATCH_CREDENTIALS = Path(
    "/private/tmp/claude-501/-Users-stephenchan-Code-spotlight/"
    "7c4bbbfc-70c4-482e-88c0-ef70b3811067/scratchpad/booth-test-credentials.json"
)

EVENT_ID = "ekalight-test-show"
EVENT_TZ = "America/Los_Angeles"
STAGING_REF = "mphjenaaorntwkyivqtm"
PRODUCTION_REF = "lvnjshymwvagwadqeofm"
STAGING_API_HOST = "looty.34.134.72.20.sslip.io"
PRODUCTION_API_HOST = "looty.34.59.188.129.sslip.io"
MOCK_DOMAIN = "ekalight.test"
MOCK_PREFIX = "booth-test-"
HTTP_TIMEOUT = 30


class SeedError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Fixture data
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Vendor:
    id: str
    name: str
    tags: tuple[str, ...]
    instagram: str | None = None
    logo: bool = False


VENDORS: tuple[Vendor, ...] = (
    Vendor("test-slabs", "Test Vendor Slabs", ("Pokémon", "Graded"), "instagram", True),
    Vendor("test-mock-vintage", "Mock Vintage Co", ("Pokémon", "Vintage", "Singles"), "instagram", True),
    Vendor("test-placeholder-pulls", "Placeholder Pulls", ("Pokémon", "Sealed"), None, True),
    Vendor("test-sample-singles", "Sample Singles", ("Pokémon", "Singles", "Japanese"), "instagram"),
    Vendor("test-dummy-op", "Dummy Data One Piece", ("One Piece", "Sealed"), None, True),
    Vendor("test-your-booth", "Your Test Booth", ("Pokémon", "One Piece", "Singles"), "instagram", True),
    Vendor("test-fixture-sports", "Fixture Sports Cards", ("Sports", "Graded")),
    Vendor("test-lorem-lorcana", "Lorem Lorcana", ("Lorcana", "Singles"), None, True),
    Vendor("test-qa-graded", "QA Graded Gems", ("Pokémon", "Graded"), "instagram"),
    Vendor("test-staging-sealed", "Staging Sealed Supply", ("Pokémon", "One Piece", "Sealed"), None, True),
    Vendor("test-beta-binders", "Beta Binders", ("Pokémon", "Singles")),
    Vendor("test-sandbox-toys", "Sandbox Toys & Figures", ("Collectibles/Toys",), None, True),
    Vendor("test-debug-dragonball", "Debug Dragon Ball", ("Dragon Ball", "Singles")),
    Vendor("test-null-magic", "Null Pointer Magic", ("Magic", "Singles")),
    Vendor("test-mock-yugioh", "Mock Yu-Gi-Oh Vault", ("Yu-Gi-Oh", "Sealed"), None, True),
    Vendor("test-riftbound-lab", "Riftbound Test Lab", ("Riftbound", "Sealed")),
    Vendor("test-jp-imports", "Test JP Imports", ("Pokémon", "Japanese", "Sealed")),
    Vendor("test-bulk-bin", "Bulk Bin (Test)", ("Pokémon", "Singles")),
    Vendor("test-vintage-vault", "Vintage Vault (Mock)", ("Pokémon", "Vintage", "Graded"), None, True),
    Vendor("test-snack-stand", "Test Snack Stand", ("Food",)),
)
VENDOR_IDS = tuple(v.id for v in VENDORS)
# The "This is you · Claim booth" card for --me-email; never claimed by a mock user.
ME_VENDOR = "test-your-booth"


@dataclass(frozen=True)
class MockUser:
    n: int
    handle: str
    display_name: str
    claims: str | None  # vendor id, or None for an attendee

    @property
    def email(self) -> str:
        return f"{MOCK_PREFIX}{self.n}@{MOCK_DOMAIN}"


MOCK_USERS: tuple[MockUser, ...] = (
    MockUser(1, "test_vendor_1", "Slabs Tester", "test-slabs"),
    MockUser(2, "test_vendor_2", "Vintage Mock", "test-mock-vintage"),
    MockUser(3, "test_vendor_3", "Pulls Placeholder", "test-placeholder-pulls"),
    MockUser(4, "test_vendor_4", "Singles Sample", "test-sample-singles"),
    MockUser(5, "test_vendor_5", "OP Dummy", "test-dummy-op"),  # claims, never posts
    MockUser(6, "test_fan_1", "Test Fan One", None),
    MockUser(7, "test_fan_2", "Test Fan Two", None),
    MockUser(8, "test_fan_3", "Test Fan Three", None),
)


@dataclass(frozen=True)
class SeedPost:
    user: int
    vendor: str | None  # booth post when set, else a show-only attendee post
    body: str
    images: int
    minutes_ago: int


POSTS: tuple[SeedPost, ...] = (
    SeedPost(1, "test-slabs", "PSA 10 case is out, come say hi (TEST POST)", 3, 40),
    SeedPost(1, "test-slabs", "Restocked the graded wall this morning (TEST)", 1, 190),
    SeedPost(2, "test-mock-vintage", "Base set binders on the table, ask to flip (TEST)", 2, 95),
    SeedPost(3, "test-placeholder-pulls", "Fresh booster boxes just opened up (TEST)", 1, 15),
    SeedPost(4, "test-sample-singles", "Japanese singles, all priced, 3 for 20 (TEST)", 3, 300),
    SeedPost(6, None, "Anyone seen a Moonbreon on the floor? (TEST)", 1, 55),
    SeedPost(7, None, "First time at this show, where is the food? (TEST)", 0, 25),
    SeedPost(8, None, "My pulls so far today (TEST)", 2, 120),
)

# Booths that get recent card opens from >= 3 distinct people (event_hot_booths).
HOT_VENDORS = ("test-slabs", "test-placeholder-pulls", "test-staging-sealed")
# Booths with a few hours of history (stats, admin overview, recaps).
HISTORY_VENDORS = tuple(u.claims for u in MOCK_USERS if u.claims) + (
    ME_VENDOR,
    "test-staging-sealed",
    "test-qa-graded",
)
HISTORY_HOURS = 6
# History stays older than the 30-minute heat window, so only --refresh-live lights flames.
HISTORY_NEWEST_MINUTES = 35


# ---------------------------------------------------------------------------
# Env + guard
# ---------------------------------------------------------------------------
def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def eas_staging_env(eas_json: Path = EAS_JSON) -> dict[str, str]:
    try:
        document = json.loads(eas_json.read_text(encoding="utf-8"))
        env = document["build"]["staging"]["env"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    return {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {}


def guard_staging(supabase_url: str, api_base: str) -> None:
    """Refuse anything that is not exactly the staging Supabase project + staging backend."""
    supa_host = (urlparse(supabase_url).hostname or "").lower()
    api = urlparse(api_base)
    api_host = (api.hostname or "").lower()
    if PRODUCTION_REF in supabase_url or supa_host != f"{STAGING_REF}.supabase.co":
        raise SeedError(f"refusing: Supabase URL is not the staging project ({STAGING_REF})")
    if api_host == PRODUCTION_API_HOST or api_host != STAGING_API_HOST or api.scheme != "https":
        raise SeedError(f"refusing: backend URL is not the staging box (https://{STAGING_API_HOST})")


@dataclass(frozen=True)
class Config:
    supabase_url: str
    service_key: str
    anon_key: str
    api_base: str
    ops_token: str

    def secrets(self) -> tuple[str, ...]:
        # Real keys are long; a short placeholder would shred every line it matches.
        return tuple(s for s in (self.service_key, self.anon_key, self.ops_token) if len(s) >= 8)


def load_config(backend_dir: Path = BACKEND, eas_json: Path = EAS_JSON) -> Config:
    values = parse_env_file(backend_dir / ".env.staging")
    values.update(parse_env_file(backend_dir / ".env.staging.secrets"))
    eas = eas_staging_env(eas_json)
    config = Config(
        supabase_url=(values.get("SUPABASE_URL") or "").rstrip("/"),
        service_key=values.get("SUPABASE_SERVICE_ROLE_KEY") or "",
        anon_key=values.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY")
        or eas.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY")
        or "",
        api_base=(eas.get("EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL") or "").rstrip("/"),
        ops_token=values.get("SPOTLIGHT_OPS_REFRESH_TOKEN") or "",
    )
    guard_staging(config.supabase_url, config.api_base)
    missing = [
        name
        for name, value in (
            ("SUPABASE_SERVICE_ROLE_KEY", config.service_key),
            ("Supabase anon key", config.anon_key),
            ("SPOTLIGHT_OPS_REFRESH_TOKEN", config.ops_token),
        )
        if not value
    ]
    if missing:
        raise SeedError(f"missing from backend/.env.staging[.secrets]: {', '.join(missing)}")
    return config


# ---------------------------------------------------------------------------
# Pure builders
# ---------------------------------------------------------------------------
def show_dates(now: datetime | None = None) -> tuple[str, str]:
    moment = now or datetime.now(timezone.utc)
    today = moment.astimezone(ZoneInfo(EVENT_TZ)).date()
    return today.isoformat(), (today + timedelta(days=1)).isoformat()


def build_event(now: datetime | None = None) -> dict[str, Any]:
    start, end = show_dates(now)
    return {
        "id": EVENT_ID,
        "title": "Ekalight Test Show",
        "shortTitle": "Ekalight Test Show",
        "venue": "Placeholder Hall (TEST, not a real show)",
        "city": "Testville, CA",
        "address": "123 Mock Data Ave, Testville, CA 00000",
        "latitude": None,
        "longitude": None,
        "startDate": start,
        "endDate": end,
        "timezone": EVENT_TZ,
        "openTime": "00:00",
        "closeTime": "23:59",
        "tableCount": len(VENDORS),
        "categories": ["Pokemon", "One Piece", "Sports"],
        "about": "Staging-only mock show for testing booth posts. Vendors and posts are fake.",
        "pricing": None,
        "ticketUrl": None,
        "shareUrl": None,
        "featured": False,
        "accentColor": "#7C3AED",
    }


def pick_footprints(source: dict[str, Any], count: int) -> list[tuple[str, list[str]]]:
    """(location, tableIds) of `count` small Hawaii booths spread across the floor."""
    table_ids = {t.get("id") for t in source.get("tables") or [] if isinstance(t, dict)}
    small = sorted(
        (
            v
            for v in source.get("vendors") or []
            if isinstance(v, dict)
            and 1 <= len(v.get("tableIds") or []) <= 3
            and all(t in table_ids for t in v["tableIds"])
        ),
        key=lambda v: str(v.get("id")),
    )
    if len(small) < count:
        raise SeedError(f"{SOURCE_MAP_ID} has only {len(small)} usable booths, need {count}")
    step = len(small) / count
    picked = [small[int(i * step)] for i in range(count)]
    return [(str(v.get("location") or "-".join(v["tableIds"])), list(v["tableIds"])) for v in picked]


def build_map(source: dict[str, Any], updated_at: str) -> dict[str, Any]:
    footprints = pick_footprints(source, len(VENDORS))
    vendors = [
        {
            "id": vendor.id,
            "name": vendor.name,
            "location": location,
            "tableIds": tables,
            "tags": list(vendor.tags),
            "instagram": vendor.instagram,
        }
        for vendor, (location, tables) in zip(VENDORS, footprints)
    ]
    counts: dict[str, int] = {}
    for vendor in VENDORS:
        for tag in vendor.tags:
            counts[tag] = counts.get(tag, 0) + 1
    vector = dict(source.get("vector") or {})
    if vector:
        vector["baseImageFile"] = f"{EVENT_ID}-base.png"
    return {
        "eventId": EVENT_ID,
        "imageFile": f"{EVENT_ID}.png",
        "imageWidth": source.get("imageWidth"),
        "imageHeight": source.get("imageHeight"),
        "tables": source.get("tables") or [],
        "vendors": vendors,
        "tags": sorted(counts, key=lambda tag: (-counts[tag], tag)),
        "vector": vector or None,
        "updatedAt": updated_at,
    }


def map_paths(maps_dir: Path = MAPS_DIR) -> list[Path]:
    return [
        maps_dir / f"{EVENT_ID}.json",
        maps_dir / f"{EVENT_ID}.png",
        maps_dir / f"{EVENT_ID}-base.png",
        maps_dir / f"{EVENT_ID}-logos",
    ]


_PALETTE = ("#1E3A8A", "#7C2D12", "#065F46", "#6B21A8", "#9D174D", "#0F766E", "#854D0E", "#334155")


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def placeholder_jpeg(label: str, index: int, width: int = 1080, height: int = 1350) -> bytes:
    """A flat "card case" with slots and a big TEST, as a JPEG the moderator will pass."""
    from PIL import Image, ImageDraw

    background = _PALETTE[index % len(_PALETTE)]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    margin = 70
    draw.rounded_rectangle((margin, 220, width - margin, height - 220), radius=36, fill="#111827", outline="#E5E7EB", width=8)
    cols, rows = 4, 3
    slot_w = (width - 2 * margin - 60 - (cols - 1) * 24) // cols
    slot_h = (height - 440 - 60 - (rows - 1) * 24) // rows
    for r in range(rows):
        for c in range(cols):
            x = margin + 30 + c * (slot_w + 24)
            y = 250 + r * (slot_h + 24)
            shade = 200 - ((r * cols + c + index) % 5) * 25
            draw.rounded_rectangle((x, y, x + slot_w, y + slot_h), radius=12, fill=(shade, shade, 255 - shade // 2))
    draw.text((width // 2, 110), "TEST", fill="#FFFFFF", font=_font(150), anchor="mm")
    draw.text((width // 2, height - 120), f"{label} #{index + 1}", fill="#FFFFFF", font=_font(56), anchor="mm")
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=82, optimize=True)
    return out.getvalue()


def logo_webp(vendor: Vendor, index: int) -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (256, 256), _PALETTE[index % len(_PALETTE)])
    draw = ImageDraw.Draw(image)
    initials = "".join(word[0] for word in vendor.name.split() if word[:1].isalnum())[:2].upper() or "T"
    draw.text((128, 118), initials, fill="#FFFFFF", font=_font(110), anchor="mm")
    draw.text((128, 214), "TEST", fill="#FFFFFF", font=_font(36), anchor="mm")
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=80)
    return out.getvalue()


def email_sha256(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def history_events(
    user_ids: dict[int, str], now: datetime, rng: random.Random | None = None
) -> list[dict[str, Any]]:
    """A few hours of plausible booth activity from mock viewers (never the booth's own claimer)."""
    rng = rng or random.Random(20261031)
    claimer = {u.claims: u.n for u in MOCK_USERS if u.claims}
    posted = {p.vendor for p in POSTS if p.vendor}
    rows: list[dict[str, Any]] = []
    span = HISTORY_HOURS * 60 - HISTORY_NEWEST_MINUTES
    for vendor_id in HISTORY_VENDORS:
        for user in MOCK_USERS:
            if user.n == claimer.get(vendor_id) or user.n not in user_ids:
                continue
            plan = [("card_open", rng.randint(1, 5))]
            if rng.random() < 0.45:
                plan.append(("instagram_tap", rng.randint(1, 2)))
            if rng.random() < 0.2:
                plan.append(("message_start", 1))
            if vendor_id in posted:
                plan.append(("post_view", rng.randint(1, 4)))
            for kind, times in plan:
                # Same viewer + booth + kind at least 10 minutes apart, like the RPC dedupe.
                slots = rng.sample(range(0, span, 12), k=min(times, span // 12))
                for slot in slots:
                    created = now - timedelta(minutes=HISTORY_NEWEST_MINUTES + slot, seconds=rng.randint(0, 59))
                    rows.append(
                        {
                            "event_id": EVENT_ID,
                            "vendor_id": vendor_id,
                            "viewer_id": user_ids[user.n],
                            "kind": kind,
                            "created_at": created.isoformat(),
                        }
                    )
    rows.sort(key=lambda row: row["created_at"])
    return rows


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()
    except OSError as error:
        raise SeedError(f"{method} {urlparse(url).netloc}{urlparse(url).path} unreachable: {error}") from error


class Seeder:
    def __init__(
        self,
        config: Config,
        transport: Transport = urllib_transport,
        *,
        maps_dir: Path = MAPS_DIR,
        now: Callable[[], datetime] | None = None,
        out: Callable[[str], None] = print,
        credentials_path: Path | None = None,
    ) -> None:
        guard_staging(config.supabase_url, config.api_base)
        self.config = config
        self._transport = transport
        self.maps_dir = maps_dir
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._out = out
        self.credentials_path = credentials_path
        self.tokens: dict[int, str] = {}
        self.user_ids: dict[int, str] = {}

    # -- plumbing --------------------------------------------------------------
    def say(self, line: str) -> None:
        for secret in self.config.secrets():
            line = line.replace(secret, "<redacted>")
        self._out(line)

    def _call(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        payload: Any = None,
        *,
        raw: bytes | None = None,
        ok: tuple[int, ...] = (200, 201, 204),
    ) -> tuple[int, Any]:
        host = urlparse(url).hostname or ""
        if host not in {f"{STAGING_REF}.supabase.co", STAGING_API_HOST}:
            raise SeedError(f"refusing request to non-staging host {host}")
        body = raw if raw is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
        status, data = self._transport(method, url, headers, body)
        try:
            parsed = json.loads(data) if data else None
        except ValueError:
            parsed = None
        if status not in ok:
            detail = data.decode("utf-8", "replace")[:300] if isinstance(data, (bytes, bytearray)) else ""
            for secret in self.config.secrets():
                detail = detail.replace(secret, "<redacted>")
            raise SeedError(f"{method} {urlparse(url).path} -> {status}: {detail}")
        return status, parsed

    def _service_headers(self, prefer: str | None = None) -> dict[str, str]:
        key = self.config.service_key
        headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def rest(self, method: str, path: str, payload: Any = None, *, prefer: str | None = None, ok=(200, 201, 204)):
        return self._call(method, f"{self.config.supabase_url}/rest/v1/{path}", self._service_headers(prefer), payload, ok=ok)[1]

    def user_rest(self, n: int, method: str, path: str, payload: Any = None, *, prefer: str | None = None):
        headers = {
            "apikey": self.config.anon_key,
            "Authorization": f"Bearer {self.tokens[n]}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return self._call(method, f"{self.config.supabase_url}/rest/v1/{path}", headers, payload)[1]

    def auth_admin(self, method: str, path: str, payload: Any = None, ok=(200, 201, 204)):
        return self._call(method, f"{self.config.supabase_url}/auth/v1/admin/{path}", self._service_headers(), payload, ok=ok)[1]

    def admin_events(self, method: str, path: str = "", payload: Any = None, ok=(200,)):
        headers = {"X-Ops-Token": self.config.ops_token, "Content-Type": "application/json"}
        return self._call(method, f"{self.config.api_base}/api/v1/admin/events{path}", headers, payload, ok=ok)[1]

    # -- reads -----------------------------------------------------------------
    def mock_auth_users(self) -> dict[str, dict[str, Any]]:
        """{email: auth user} for every booth-test-*@ekalight.test account."""
        found: dict[str, dict[str, Any]] = {}
        page = 1
        while True:
            data = self.auth_admin("GET", f"users?page={page}&per_page=200") or {}
            users = data.get("users") if isinstance(data, dict) else data
            for user in users or []:
                email = str(user.get("email") or "").lower()
                if email.startswith(MOCK_PREFIX) and email.endswith(f"@{MOCK_DOMAIN}"):
                    found[email] = user
            if not users or len(users) < 200:
                return found
            page += 1

    def table_exists(self, table: str) -> bool:
        status, _ = self._call(
            "GET",
            f"{self.config.supabase_url}/rest/v1/{table}?select=*&limit=1",
            self._service_headers(),
            ok=(200, 400, 404),
        )
        return status == 200

    def admin_event_present(self) -> bool:
        listing = self.admin_events("GET") or {}
        return any(row.get("id") == EVENT_ID for row in listing.get("events") or [])

    def map_served(self) -> bool:
        status, _ = self._call("GET", f"{self.config.api_base}/api/v1/events/{EVENT_ID}/map", {}, ok=(200, 404))
        return status == 200

    # -- plan ------------------------------------------------------------------
    def plan(self, me_email: str | None = None) -> None:
        self.say(f"PLAN (staging only, no writes) for show {EVENT_ID}")
        start, end = show_dates(self._now())
        local = [p.name for p in map_paths(self.maps_dir) if p.exists()]
        self.say(f"- map files in backend/data/spotlight_event_maps: {'present ' + ', '.join(local) if local else 'would write'} "
                 f"({len(VENDORS)} test vendors on {SOURCE_MAP_ID} tables)")
        self.say(f"- admin show: {'present, would re-date' if self.admin_event_present() else 'would create'} "
                 f"{start}..{end} {EVENT_TZ}")
        self.say(f"- map served by staging backend: {'yes' if self.map_served() else 'NO (needs a staging backend deploy after --apply)'}")
        existing = self.mock_auth_users()
        self.say(f"- mock accounts: {len(existing)}/{len(MOCK_USERS)} exist; would create {len(MOCK_USERS) - len(existing)}, "
                 "reset passwords, set handles")
        claimers = [u for u in MOCK_USERS if u.claims]
        self.say(f"- claims: {', '.join(f'@{u.handle}->{u.claims}' for u in claimers)} (rpc claim_booth as each user)")
        booth = sum(1 for p in POSTS if p.vendor)
        images = sum(p.images for p in POSTS)
        self.say(f"- posts: {booth} booth + {len(POSTS) - booth} attendee posts, {images} placeholder images via /api/v1/post-media")
        self.say(f"- booth_events: ~{HISTORY_HOURS}h of history on {len(HISTORY_VENDORS)} booths; live heat on {', '.join(HOT_VENDORS)}")
        self.say(f"- presence: {len(MOCK_USERS)} mock users browsing now")
        has_29 = self.table_exists("booth_vendor_emails")
        has_27 = self.table_exists("booth_claims")
        self.say(f"- migrations: social_27 {'ok' if has_27 else 'MISSING (apply first)'}; "
                 f"social_29 {'ok' if has_29 else 'missing: --me-email and flames need it'}")
        if me_email:
            self.say(f"- --me-email: would map that email's sha256 to {ME_VENDOR}" + ("" if has_29 else " (SKIPPED: no social_29)"))

    # -- apply -----------------------------------------------------------------
    def write_map_files(self) -> None:
        source_path = self.maps_dir / f"{SOURCE_MAP_ID}.json"
        try:
            source = json.loads(source_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise SeedError(f"cannot read {source_path}: {error}") from error
        document = build_map(source, self._now().replace(microsecond=0).isoformat().replace("+00:00", "Z"))
        target = self.maps_dir / f"{EVENT_ID}.json"
        previous = target.read_text(encoding="utf-8") if target.exists() else None
        rendered = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        # Only rewrite when the vendors/tables change; a fresh updatedAt alone isn't a change.
        if previous is None or _without_updated_at(previous) != _without_updated_at(rendered):
            target.write_text(rendered, encoding="utf-8")
        for src_name, dst_name in (
            (str(source.get("imageFile") or f"{SOURCE_MAP_ID}.png"), f"{EVENT_ID}.png"),
            (str((source.get("vector") or {}).get("baseImageFile") or ""), f"{EVENT_ID}-base.png"),
        ):
            src = self.maps_dir / src_name
            dst = self.maps_dir / dst_name
            if src_name and src.is_file() and not dst.exists():
                shutil.copyfile(src, dst)
        logos = self.maps_dir / f"{EVENT_ID}-logos"
        logos.mkdir(exist_ok=True)
        for index, vendor in enumerate(VENDORS):
            path = logos / f"{vendor.id}.webp"
            if vendor.logo and not path.exists():
                path.write_bytes(logo_webp(vendor, index))
        self.say(f"map: wrote {EVENT_ID}.json/.png/-base.png/-logos locally (gitignored)")

    def upsert_event(self) -> None:
        event = build_event(self._now())
        self.admin_events("POST", "", event)
        self.say(f"show: {EVENT_ID} saved in the admin layer ({event['startDate']}..{event['endDate']})")

    def ensure_users(self) -> dict[int, str]:
        """Create missing mock accounts, give every one a fresh password, sign in. Returns passwords."""
        existing = self.mock_auth_users()
        passwords: dict[int, str] = {}
        for user in MOCK_USERS:
            password = secrets.token_urlsafe(24)
            passwords[user.n] = password
            meta = {"display_name": user.display_name, "seed": EVENT_ID}
            record = existing.get(user.email)
            if record is None:
                record = self.auth_admin(
                    "POST",
                    "users",
                    {"email": user.email, "password": password, "email_confirm": True, "user_metadata": meta},
                )
                self.say(f"user: created {user.email}")
            else:
                self.auth_admin("PUT", f"users/{record['id']}", {"password": password, "user_metadata": meta})
            self.user_ids[user.n] = str(record["id"])
            self.rest(
                "POST",
                "user_profiles?on_conflict=user_id",
                {"user_id": self.user_ids[user.n], "handle": user.handle, "display_name": user.display_name},
                prefer="resolution=merge-duplicates,return=minimal",
            )
            self.sign_in(user, password)
        self.say(f"users: {len(MOCK_USERS)} mock accounts ready (@{MOCK_USERS[0].handle} .. @{MOCK_USERS[-1].handle})")
        return passwords

    def sign_in(self, user: MockUser, password: str) -> None:
        headers = {"apikey": self.config.anon_key, "Content-Type": "application/json"}
        try:
            _, session = self._call(
                "POST",
                f"{self.config.supabase_url}/auth/v1/token?grant_type=password",
                headers,
                {"email": user.email, "password": password},
            )
        except SeedError as error:
            hint = " (is CAPTCHA on for staging sign-in?)" if "captcha" in str(error).lower() else ""
            raise SeedError(f"sign-in failed for {user.email}{hint}: {error}") from error
        token = (session or {}).get("access_token")
        if not token:
            raise SeedError(f"sign-in for {user.email} returned no session")
        self.tokens[user.n] = token

    def claim_booths(self) -> set[int]:
        """claim_booth as each claimer. Returns the users who hold their booth."""
        holders: set[int] = set()
        for user in MOCK_USERS:
            if not user.claims:
                continue
            result = self.user_rest(user.n, "POST", "rpc/claim_booth", {"p_vendor_id": user.claims, "p_event_id": EVENT_ID})
            self.say(f"claim: @{user.handle} -> {user.claims}: {result}")
            if result in ("claimed", "already_yours"):
                holders.add(user.n)
        return holders

    def seed_vendor_email(self, me_email: str) -> None:
        if not self.table_exists("booth_vendor_emails"):
            self.say("--me-email skipped: booth_vendor_emails missing (apply social_29 on staging first)")
            return
        written = self.rest(
            "POST",
            "rpc/replace_booth_vendor_emails",
            {"p_event_id": EVENT_ID, "p_hashes": {ME_VENDOR: [email_sha256(me_email)]}},
        )
        self.say(f"--me-email: {ME_VENDOR} now matches that account ({written} row)")

    def seed_posts(self, holders: set[int]) -> None:
        mock_ids = ",".join(self.user_ids.values())
        rows = self.rest(
            "GET",
            f"posts?select=id,author_id,body&event_id=eq.{EVENT_ID}&author_id=in.({mock_ids})&deleted_at=is.null",
        ) or []
        existing = {(row["author_id"], row.get("body")): row["id"] for row in rows}
        now = self._now()
        created = reused = uploaded = 0
        for index, post in enumerate(POSTS):
            if post.vendor and post.user not in holders:
                self.say(f"post skipped: user {post.user} does not hold {post.vendor}")
                continue
            author = self.user_ids[post.user]
            post_id = existing.get((author, post.body))
            if post_id is None:
                columns: dict[str, Any] = {"author_id": author, "body": post.body, "event_id": EVENT_ID}
                if post.vendor:
                    columns["booth_vendor_id"] = post.vendor
                inserted = self.user_rest(post.user, "POST", "posts?select=id", columns, prefer="return=representation")
                post_id = inserted[0]["id"]
                # Backdated so "From the floor" reads "2h ago" instead of all "now".
                stamp = (now - timedelta(minutes=post.minutes_ago)).isoformat()
                self.rest("PATCH", f"posts?id=eq.{post_id}", {"created_at": stamp}, prefer="return=minimal")
                created += 1
            else:
                reused += 1
            have = {
                int(row.get("position") or 0)
                for row in self.rest("GET", f"post_media?select=position&post_id=eq.{post_id}") or []
            }
            label = next((v.name for v in VENDORS if v.id == post.vendor), "Attendee")
            for position in range(post.images):
                if position in have:
                    continue
                self._call(
                    "POST",
                    f"{self.config.api_base}/api/v1/post-media?{urlencode({'postId': post_id, 'position': position})}",
                    {"Authorization": f"Bearer {self.tokens[post.user]}", "Content-Type": "image/jpeg"},
                    raw=placeholder_jpeg(label, index * 4 + position),
                )
                uploaded += 1
        self.say(f"posts: {created} created, {reused} already there, {uploaded} images uploaded (pending moderation)")

    def seed_history(self) -> None:
        mock_ids = ",".join(self.user_ids.values())
        marker = self.rest(
            "GET",
            f"booth_events?select=id&event_id=eq.{EVENT_ID}&kind=eq.instagram_tap&viewer_id=in.({mock_ids})&limit=1",
        )
        if marker:
            self.say("booth_events: history already seeded")
            return
        rows = history_events(self.user_ids, self._now())
        for start in range(0, len(rows), 500):
            self.rest("POST", "booth_events", rows[start : start + 500], prefer="return=minimal")
        self.say(f"booth_events: {len(rows)} history rows over the last {HISTORY_HOURS}h")

    def refresh_live(self) -> None:
        if not self.user_ids:
            emails = self.mock_auth_users()
            self.user_ids = {u.n: str(emails[u.email]["id"]) for u in MOCK_USERS if u.email in emails}
            if not self.user_ids:
                raise SeedError("no mock accounts on staging; run --apply first")
        now = self._now()
        presence = [
            {"event_id": EVENT_ID, "user_id": uid, "last_seen": now.isoformat()} for uid in self.user_ids.values()
        ]
        self.rest(
            "POST",
            "event_presence?on_conflict=event_id,user_id",
            presence,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        since = (now - timedelta(minutes=10)).isoformat()
        recent = self.rest(
            "GET",
            f"booth_events?select=vendor_id,viewer_id&event_id=eq.{EVENT_ID}&kind=eq.card_open"
            f"&created_at=gt.{quote(since)}&vendor_id=in.({','.join(HOT_VENDORS)})",
        ) or []
        seen = {(row["vendor_id"], row["viewer_id"]) for row in recent}
        claimer = {u.claims: u.n for u in MOCK_USERS if u.claims}
        rng = random.Random()
        rows = []
        for vendor_id in HOT_VENDORS:
            for user in MOCK_USERS:
                uid = self.user_ids.get(user.n)
                if uid is None or user.n == claimer.get(vendor_id) or (vendor_id, uid) in seen:
                    continue
                rows.append(
                    {
                        "event_id": EVENT_ID,
                        "vendor_id": vendor_id,
                        "viewer_id": uid,
                        "kind": "card_open",
                        "created_at": (now - timedelta(minutes=rng.randint(1, 8))).isoformat(),
                    }
                )
        if rows:
            self.rest("POST", "booth_events", rows, prefer="return=minimal")
        self.say(f"live: {len(presence)} browsing now (15 min), {len(rows)} new card opens on {', '.join(HOT_VENDORS)} "
                 "(flames for 30 min)")

    def apply(self, me_email: str | None = None) -> None:
        if not self.table_exists("booth_claims"):
            raise SeedError("social_27 is not applied on staging (no booth_claims)")
        self.write_map_files()
        self.upsert_event()
        passwords = self.ensure_users()
        if self.credentials_path:
            self.credentials_path.parent.mkdir(parents=True, exist_ok=True)
            self.credentials_path.write_text(
                json.dumps({u.email: passwords[u.n] for u in MOCK_USERS}, indent=2) + "\n", encoding="utf-8"
            )
            self.credentials_path.chmod(0o600)
            self.say(f"credentials: written to {self.credentials_path} (0600; replaced on every --apply)")
        holders = self.claim_booths()
        if me_email:
            self.seed_vendor_email(me_email)
        self.seed_posts(holders)
        self.seed_history()
        self.refresh_live()
        if not self.table_exists("booth_vendor_emails"):
            self.say("note: social_29 missing on staging, so the app's flames and 'This is you' card won't show yet")
        if not self.map_served():
            self.say("NEXT: the staging backend doesn't serve the map yet; run `pnpm backend:deploy:staging`")

    # -- cleanup ---------------------------------------------------------------
    def cleanup(self) -> None:
        users = self.mock_auth_users()
        deleted = 0
        for user in MOCK_USERS:
            record = users.get(user.email)
            if record is None:
                continue
            uid = str(record["id"])
            # The app's own account deletion also erases the user's post images in GCS.
            password = secrets.token_urlsafe(24)
            via = "account/delete"
            try:
                self.auth_admin("PUT", f"users/{uid}", {"password": password})
                self.sign_in(user, password)
                self._call(
                    "POST",
                    f"{self.config.api_base}/api/v1/account/delete",
                    {"Authorization": f"Bearer {self.tokens[user.n]}", "Content-Type": "application/json"},
                    {},
                )
            except SeedError as error:
                self.say(f"account/delete failed for {user.email} ({error}); deleting the auth user directly")
                self.auth_admin("DELETE", f"users/{uid}", ok=(200, 204, 404))
                via = "auth admin"
            deleted += 1
            self.say(f"user: deleted {user.email} via {via}")
        vendor_list = ",".join(VENDOR_IDS)
        leftovers = [
            ("posts", f"posts?event_id=eq.{EVENT_ID}"),
            ("booth_claims", f"booth_claims?vendor_id=in.({vendor_list})"),
            ("booth_reports", f"booth_reports?vendor_id=in.({vendor_list})"),
            ("booth_events", f"booth_events?event_id=eq.{EVENT_ID}"),
            ("booth_events (test vendors elsewhere)", f"booth_events?vendor_id=in.({vendor_list})"),
            ("event_presence", f"event_presence?event_id=eq.{EVENT_ID}"),
            ("notifications", f"notifications?type=eq.booth_recap&payload->>event_id=eq.{EVENT_ID}"),
        ]
        if self.table_exists("booth_vendor_emails"):
            leftovers.append(("booth_vendor_emails", f"booth_vendor_emails?event_id=eq.{EVENT_ID}"))
        for label, path in leftovers:
            rows = self.rest("DELETE", path, prefer="return=representation") or []
            self.say(f"delete {label}: {len(rows)} rows")
        self.admin_events("DELETE", f"/{EVENT_ID}")
        self.say(f"show: {EVENT_ID} removed from the admin layer")
        removed = []
        for path in map_paths(self.maps_dir):
            if path.is_dir():
                shutil.rmtree(path)
                removed.append(path.name)
            elif path.exists():
                path.unlink()
                removed.append(path.name)
        self.say(f"map: removed local {', '.join(removed) if removed else 'nothing (already gone)'}")
        self.say(
            "VM: deploys only ADD files, so the map copies stay on the staging box (unreachable: the show is gone). "
            "To delete them: gcloud compute ssh spotlight-backend-staging --zone us-central1-a --tunnel-through-iap "
            f"--command 'rm -rf ~/spotlight/data/spotlight_event_maps/{EVENT_ID}*'"
        )
        self.say(f"cleanup done: {deleted} mock accounts deleted")


def _without_updated_at(text: str) -> Any:
    try:
        document = json.loads(text)
    except ValueError:
        return text
    if isinstance(document, dict):
        document.pop("updatedAt", None)
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", action="store_true", help="default: read-only, print what --apply would do")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--refresh-live", action="store_true")
    mode.add_argument("--cleanup", action="store_true")
    parser.add_argument("--me-email", help="also make this email the 'This is you' match for test-your-booth")
    parser.add_argument(
        "--save-credentials",
        action="store_true",
        help=f"write the mock accounts' fresh passwords to {SCRATCH_CREDENTIALS} (0600) to sign in as one",
    )
    args = parser.parse_args(argv)
    if args.me_email and "@" not in args.me_email:
        parser.error("--me-email must be an email address")
    try:
        seeder = Seeder(load_config(), credentials_path=SCRATCH_CREDENTIALS if args.save_credentials else None)
        if args.apply:
            seeder.apply(args.me_email)
        elif args.refresh_live:
            seeder.refresh_live()
        elif args.cleanup:
            seeder.cleanup()
        else:
            seeder.plan(args.me_email)
    except SeedError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
