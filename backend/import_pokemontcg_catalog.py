from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from catalog_tools import utc_now

API_BASE_URL = "https://api.pokemontcg.io/v2/cards"
SETS_API_BASE_URL = "https://api.pokemontcg.io/v2/sets"
USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"
DEFAULT_FIELDS = [
    "id",
    "name",
    "supertype",
    "subtypes",
    "types",
    "number",
    "artist",
    "rarity",
    "nationalPokedexNumbers",
    "regulationMark",
    "rules",
    "images",
    "set",
    "tcgplayer",
    "cardmarket",
]
DEFAULT_QUERY = "set.series:\"Scarlet & Violet\""
DEFAULT_PAGE_SIZE = 250
DEFAULT_SLEEP_SECONDS = 0.2
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import Pokémon card metadata from Pokémon TCG API. Local reference image download is optional and legacy.")
    parser.add_argument("--api-key", default=os.environ.get("POKEMONTCG_API_KEY"))
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--max-cards", type=int, default=None)
    parser.add_argument("--sleep-seconds", type=float, default=DEFAULT_SLEEP_SECONDS)
    parser.add_argument("--download-images", action="store_true", default=False)
    parser.add_argument("--skip-image-download", action="store_true")
    parser.add_argument("--catalog-json", default=None)
    parser.add_argument("--images-dir", default=None)
    parser.add_argument("--order-by", default="set.releaseDate,name,number")
    parser.add_argument("--replace-output", action="store_true")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--card-id", action="append", default=[])
    parser.add_argument("--exact-only", action="store_true")
    return parser.parse_args()


def backend_root() -> Path:
    return Path(__file__).resolve().parent


def default_images_dir() -> Path:
    return backend_root() / "catalog" / "pokemontcg" / "images"


def load_catalog_cards(catalog_path: Path) -> dict[str, dict[str, Any]]:
    if not catalog_path.exists():
        return {}

    try:
        existing_cards = json.loads(catalog_path.read_text())
    except json.JSONDecodeError:
        return {}

    normalized_cards: dict[str, dict[str, Any]] = {}
    for card in existing_cards:
        normalized_cards[str(card["id"])] = {
            "id": str(card["id"]),
            "name": str(card.get("name") or ""),
            "set_name": str(card.get("set_name") or ""),
            "number": str(card.get("number") or ""),
            "image_url": str(
                card.get("image_url")
                or card.get("reference_image_small_url")
                or card.get("reference_image_url")
                or ""
            ),
        }
    return normalized_cards


def write_catalog_cards(catalog_path: Path, cards_by_id: dict[str, dict[str, Any]]) -> None:
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    minimal_cards = [
        {
            "id": str(card["id"]),
            "name": str(card.get("name") or ""),
            "set_name": str(card.get("set_name") or ""),
            "number": str(card.get("number") or ""),
            "image_url": str(
                card.get("image_url")
                or card.get("reference_image_small_url")
                or card.get("reference_image_url")
                or ""
            ),
        }
        for card in cards_by_id.values()
    ]
    cards_output = sorted(
        minimal_cards,
        key=lambda card: (
            card.get("set_name") or "",
            card.get("name") or "",
            card.get("number") or "",
        ),
    )
    catalog_path.write_text(json.dumps(cards_output, indent=2, sort_keys=True))


def api_request(
    url: str,
    api_key: str | None,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    request = Request(url)
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    if api_key:
        request.add_header("X-Api-Key", api_key)

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def slugify_filename(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-") or "card"


def image_extension_from_url(url: str) -> str:
    suffix = Path(url).suffix.lower()
    return suffix if suffix in {".png", ".jpg", ".jpeg", ".webp"} else ".png"


def download_image(urls: list[str], destination: Path, api_key: str | None) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None

    for url in urls:
        if not url:
            continue

        request = Request(url)
        request.add_header("User-Agent", USER_AGENT)
        if api_key:
            request.add_header("X-Api-Key", api_key)

        try:
            with urlopen(request) as response:
                destination.write_bytes(response.read())
            return url
        except (HTTPError, URLError) as error:
            last_error = error
            continue

    if last_error is not None:
        raise last_error

    raise URLError("No valid image URL provided")


def map_card(card: dict[str, Any], local_image_path: Path | None) -> dict[str, Any]:
    set_info = card.get("set") or {}
    images = card.get("images") or {}
    raw_number = str(card["number"])
    printed_total = set_info.get("printedTotal")
    set_name = set_info.get("name") or "Unknown Set"
    set_series = set_info.get("series")
    is_promo_set = "promo" in f"{set_name} {set_series or ''}".lower()
    resolved_number = raw_number

    if printed_total and "/" not in raw_number and not is_promo_set:
        resolved_number = f"{raw_number}/{printed_total}"

    return {
        "id": card["id"],
        "name": card["name"],
        "set_name": set_name,
        "number": resolved_number,
        "rarity": card.get("rarity") or "Unknown",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": str(local_image_path) if local_image_path else None,
        "reference_image_url": images.get("large") or images.get("small"),
        "reference_image_small_url": images.get("small"),
        "source": "pokemontcg_api",
        "source_record_id": card["id"],
        "set_id": set_info.get("id"),
        "set_series": set_info.get("series"),
        "set_ptcgo_code": set_info.get("ptcgoCode"),
        "set_release_date": set_info.get("releaseDate"),
        "supertype": card.get("supertype"),
        "subtypes": card.get("subtypes") or [],
        "types": card.get("types") or [],
        "artist": card.get("artist"),
        "regulation_mark": card.get("regulationMark"),
        "national_pokedex_numbers": card.get("nationalPokedexNumbers") or [],
        "tcgplayer": card.get("tcgplayer") or {},
        "cardmarket": card.get("cardmarket") or {},
        "source_payload": card,
        "imported_at": utc_now(),
    }


def build_page_url(page: int, page_size: int, query: str, order_by: str) -> str:
    query_string = urlencode(
        {
            "page": page,
            "pageSize": page_size,
            "q": query,
            "orderBy": order_by,
            "select": ",".join(DEFAULT_FIELDS),
        }
    )
    return f"{API_BASE_URL}?{query_string}"


def build_search_cards_url(query: str, page_size: int, order_by: str, page: int = 1) -> str:
    query_string = urlencode(
        {
            "page": page,
            "pageSize": page_size,
            "q": query,
            "orderBy": order_by,
            "select": ",".join(DEFAULT_FIELDS),
        }
    )
    return f"{API_BASE_URL}?{query_string}"


def build_search_sets_url(query: str, page_size: int = 10, page: int = 1) -> str:
    query_string = urlencode(
        {
            "page": page,
            "pageSize": page_size,
            "q": query,
        }
    )
    return f"{SETS_API_BASE_URL}?{query_string}"


def build_card_url(card_id: str, fields: list[str] | None = None) -> str:
    query_string = urlencode({"select": ",".join(fields or DEFAULT_FIELDS)}) if fields else ""
    base = f"{API_BASE_URL}/{card_id}"
    return f"{base}?{query_string}" if query_string else base


def fetch_card_by_id(
    card_id: str,
    api_key: str | None,
    *,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    payload = api_request(build_card_url(card_id), api_key, timeout=timeout)
    card = payload.get("data")
    if not isinstance(card, dict):
        raise ValueError(f"Card {card_id} was not returned by the Pokémon TCG API")
    return card


def search_cards(
    query: str,
    api_key: str | None,
    *,
    page_size: int = 10,
    order_by: str = "set.releaseDate,name,number",
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    payload = api_request(
        build_search_cards_url(query, page_size=page_size, order_by=order_by),
        api_key,
        timeout=timeout,
    )
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def search_sets(
    query: str,
    api_key: str | None,
    *,
    page_size: int = 10,
    timeout: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    payload = api_request(build_search_sets_url(query, page_size=page_size), api_key, timeout=timeout)
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def import_exact_card_ids(
    *,
    card_ids: list[str],
    cards_by_id: dict[str, dict[str, Any]],
    images_dir: Path,
    download_images_enabled: bool,
    sleep_seconds: float,
    api_key: str | None,
) -> None:
    for card_id in card_ids:
        raw_card = fetch_card_by_id(card_id, api_key)
        images = raw_card.get("images") or {}
        large_image_url = images.get("large")
        small_image_url = images.get("small")
        image_url = large_image_url or small_image_url
        local_image_path: Path | None = None

        if image_url and download_images_enabled:
            extension = image_extension_from_url(image_url)
            local_image_path = images_dir / f"{slugify_filename(card_id)}{extension}"
            if not local_image_path.exists():
                try:
                    downloaded_url = download_image(
                        [large_image_url, small_image_url],
                        local_image_path,
                        api_key,
                    )
                    if downloaded_url != image_url:
                        extension = image_extension_from_url(downloaded_url)
                        corrected_path = images_dir / f"{slugify_filename(card_id)}{extension}"
                        if corrected_path != local_image_path:
                            if corrected_path.exists():
                                corrected_path.unlink()
                            local_image_path.rename(corrected_path)
                            local_image_path = corrected_path
                    time.sleep(max(0.0, sleep_seconds))
                except (HTTPError, URLError) as error:
                    print(f"warning: could not download reference image for {card_id}: {error}", flush=True)
                    local_image_path = None
        elif image_url:
            extension = image_extension_from_url(image_url)
            local_image_path = images_dir / f"{slugify_filename(card_id)}{extension}"

        cards_by_id[card_id] = map_card(raw_card, local_image_path)
        print(f"Imported exact card {card_id}", flush=True)


def main() -> None:
    args = parse_args()
    catalog_path = Path(args.catalog_json) if args.catalog_json else None
    images_dir = Path(args.images_dir) if args.images_dir else default_images_dir()
    download_images_enabled = args.download_images and not args.skip_image_download

    cards_by_id: dict[str, dict[str, Any]] = {}
    if catalog_path is not None and not args.replace_output:
        cards_by_id = load_catalog_cards(catalog_path)

    page = args.start_page

    if args.card_id:
        try:
            import_exact_card_ids(
                card_ids=args.card_id,
                cards_by_id=cards_by_id,
                images_dir=images_dir,
                download_images_enabled=download_images_enabled,
                sleep_seconds=args.sleep_seconds,
                api_key=args.api_key,
            )
        except HTTPError as error:
            print(f"HTTP error while importing exact Pokémon cards: {error}", file=sys.stderr)
            sys.exit(1)
        except URLError as error:
            print(f"Network error while importing exact Pokémon cards: {error}", file=sys.stderr)
            sys.exit(1)

        if args.exact_only:
            if download_images_enabled:
                images_dir.mkdir(parents=True, exist_ok=True)
            if catalog_path is not None:
                write_catalog_cards(catalog_path, cards_by_id)
                print(f"Wrote {len(cards_by_id)} cards to {catalog_path}", flush=True)
            else:
                print(f"Imported {len(cards_by_id)} cards (no catalog JSON output path configured)", flush=True)
            if download_images_enabled:
                print(f"Reference images stored in {images_dir}", flush=True)
            return

    try:
        while True:
            if args.max_pages is not None and page > args.max_pages:
                break

            url = build_page_url(page, args.page_size, args.query, args.order_by)
            payload = api_request(url, args.api_key)
            batch = payload.get("data") or []
            if not batch:
                break

            for raw_card in batch:
                card_id = raw_card["id"]
                images = raw_card.get("images") or {}
                large_image_url = images.get("large")
                small_image_url = images.get("small")
                image_url = large_image_url or small_image_url
                local_image_path: Path | None = None

                if image_url and download_images_enabled:
                    extension = image_extension_from_url(image_url)
                    local_image_path = images_dir / f"{slugify_filename(card_id)}{extension}"
                    if not local_image_path.exists():
                        try:
                            downloaded_url = download_image(
                                [large_image_url, small_image_url],
                                local_image_path,
                                args.api_key,
                            )
                            if downloaded_url != image_url:
                                extension = image_extension_from_url(downloaded_url)
                                corrected_path = images_dir / f"{slugify_filename(card_id)}{extension}"
                                if corrected_path != local_image_path:
                                    if corrected_path.exists():
                                        corrected_path.unlink()
                                    local_image_path.rename(corrected_path)
                                    local_image_path = corrected_path
                            time.sleep(max(0.0, args.sleep_seconds))
                        except (HTTPError, URLError) as error:
                            print(f"warning: could not download reference image for {card_id}: {error}", flush=True)
                            local_image_path = None
                elif image_url:
                    extension = image_extension_from_url(image_url)
                    local_image_path = images_dir / f"{slugify_filename(card_id)}{extension}"

                cards_by_id[card_id] = map_card(raw_card, local_image_path)

                if args.max_cards is not None and len(cards_by_id) >= args.max_cards:
                    break

            print(f"Fetched page {page}: total cards so far {len(cards_by_id)}", flush=True)

            if args.max_cards is not None and len(cards_by_id) >= args.max_cards:
                break

            count = payload.get("count")
            if count is not None and int(count) < args.page_size:
                break

            total_count = payload.get("totalCount")
            if total_count is not None and len(cards_by_id) >= int(total_count):
                break

            page += 1
            time.sleep(max(0.0, args.sleep_seconds))

    except HTTPError as error:
        print(f"HTTP error while importing Pokémon TCG catalog: {error}", file=sys.stderr)
        sys.exit(1)
    except URLError as error:
        print(f"Network error while importing Pokémon TCG catalog: {error}", file=sys.stderr)
        sys.exit(1)

    if download_images_enabled:
        images_dir.mkdir(parents=True, exist_ok=True)
    if catalog_path is not None:
        write_catalog_cards(catalog_path, cards_by_id)
        print(f"Wrote {len(cards_by_id)} cards to {catalog_path}", flush=True)
    else:
        print(f"Imported {len(cards_by_id)} cards (no catalog JSON output path configured)", flush=True)
    if download_images_enabled:
        print(f"Reference images stored in {images_dir}", flush=True)


if __name__ == "__main__":
    main()
