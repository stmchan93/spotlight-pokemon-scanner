from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

from catalog_tools import (
    apply_schema,
    connect,
    import_slab_sales,
    load_cards_json,
    normalize_grade,
    parse_datetime_value,
    parse_psa_grade,
    resolve_catalog_json_path,
    seed_catalog,
    utc_now,
)


PSA_AUCTION_PRICES_SOURCE = "psa_auction_prices"
EBAY_SOLD_SOURCE = "ebay_sold"
GOLDIN_AUCTIONS_SOURCE = "goldin_auctions"
HERITAGE_AUCTIONS_SOURCE = "heritage_auctions"
FANATICS_AUCTIONS_SOURCE = "fanatics_collect"
ENV_PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


@dataclass
class HTMLCell:
    kind: str
    text: str
    href: str | None


@dataclass
class HTMLRow:
    cells: list[HTMLCell]
    attrs: dict[str, str]


@dataclass
class HTMLTable:
    rows: list[HTMLRow]


class TableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[HTMLTable] = []
        self._table_stack: list[list[HTMLRow]] = []
        self._row_stack: list[tuple[list[HTMLCell], dict[str, str]]] = []
        self._cell_stack: list[tuple[str, list[str], str | None]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value or "" for key, value in attrs}

        if tag == "table":
            self._table_stack.append([])
            return

        if not self._table_stack:
            return

        if tag == "tr":
            self._row_stack.append(([], attr_map))
            return

        if tag in {"th", "td"} and self._row_stack:
            self._cell_stack.append((tag, [], None))
            return

        if tag == "a" and self._cell_stack:
            kind, parts, href = self._cell_stack.pop()
            self._cell_stack.append((kind, parts, attr_map.get("href") or href))

    def handle_data(self, data: str) -> None:
        if not self._cell_stack:
            return
        kind, parts, href = self._cell_stack.pop()
        parts.append(data)
        self._cell_stack.append((kind, parts, href))

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self._cell_stack and self._row_stack:
            kind, parts, href = self._cell_stack.pop()
            cells, attrs = self._row_stack.pop()
            cells.append(HTMLCell(kind=kind, text=" ".join(" ".join(parts).split()), href=href))
            self._row_stack.append((cells, attrs))
            return

        if tag == "tr" and self._row_stack and self._table_stack:
            cells, attrs = self._row_stack.pop()
            if cells:
                self._table_stack[-1].append(HTMLRow(cells=cells, attrs=attrs))
            return

        if tag == "table" and self._table_stack:
            rows = self._table_stack.pop()
            if rows:
                self.tables.append(HTMLTable(rows=rows))


def normalize_header(value: str) -> str:
    return " ".join(value.lower().replace("#", " ").replace("-", " ").split())


def parse_money_value(value: str) -> float | None:
    cleaned = (
        value.replace("$", "")
        .replace(",", "")
        .replace("usd", "")
        .replace("us", "")
        .strip()
    )
    if not cleaned:
        return None
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return None


def parse_human_date(value: str) -> str | None:
    for pattern in (
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m/%d/%y",
        "%b %d, %Y",
        "%B %d, %Y",
    ):
        try:
            parsed = datetime.strptime(value.strip(), pattern).replace(tzinfo=UTC)
            return parsed.isoformat()
        except ValueError:
            continue

    parsed_value = parse_datetime_value(value)
    if parsed_value is None:
        return None
    return parsed_value.isoformat()


def parse_grade_text(value: str) -> str | None:
    normalized = normalize_grade(value)
    if normalized and normalized.isdigit():
        return normalized

    match = re.search(r"\b(10|[1-9])\b", value)
    if match:
        return match.group(1)

    return None


def lookup_path(payload: Any, path: str) -> Any:
    value = payload
    for key in path.split("."):
        if isinstance(value, list):
            try:
                value = value[int(key)]
            except (ValueError, IndexError):
                return None
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def records_from_json_payload(payload: Any, records_path: str | None = None) -> list[dict[str, Any]]:
    value = lookup_path(payload, records_path) if records_path else payload
    if isinstance(value, list):
        return [record for record in value if isinstance(record, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def first_present(record: dict[str, Any], paths: list[str]) -> Any:
    for path in paths:
        value = lookup_path(record, path)
        if value not in {None, ""}:
            return value
    return None


def parse_market_sales_json(
    payload: str,
    *,
    source: dict[str, Any],
    source_id: str,
    source_url: str,
    provider_default_source: str,
    price_paths: list[str],
    date_paths: list[str],
    title_paths: list[str],
    url_paths: list[str],
    cert_paths: list[str],
    grade_paths: list[str],
) -> list[dict[str, Any]]:
    decoded = json.loads(payload)
    records = records_from_json_payload(decoded, source.get("recordsPath"))
    extracted: list[dict[str, Any]] = []

    for record in records:
        grade_text = str(source.get("fixedGrade") or first_present(record, grade_paths) or "").strip()
        grade = (
            parse_grade_text(grade_text)
            or parse_psa_grade(f"PSA {grade_text}")
            or parse_psa_grade(grade_text)
        )
        if grade is None:
            continue

        sale_price = parse_money_value(str(first_present(record, price_paths) or ""))
        sale_date = parse_human_date(str(first_present(record, date_paths) or ""))
        if sale_price is None or sale_date is None:
            continue

        title = str(first_present(record, title_paths) or source.get("title") or "").strip() or None
        cert_number = str(first_present(record, cert_paths) or "").strip() or None
        listing_url = str(first_present(record, url_paths) or "").strip() or None
        sale_url = urljoin(source_url, listing_url) if listing_url else source_url

        sale = {
            "cardID": source["cardID"],
            "grader": str(source.get("grader") or "PSA").upper(),
            "grade": grade,
            "salePrice": sale_price,
            "currencyCode": str(source.get("currencyCode") or "USD").upper(),
            "saleDate": sale_date,
            "source": str(source.get("source") or provider_default_source),
            "sourceURL": sale_url,
            "certNumber": cert_number,
            "title": title,
            "bucketKey": source.get("bucketKey"),
            "accepted": True,
            "sourcePayload": {
                "provider": source.get("provider"),
                "sourceID": source_id,
                "sourceURL": source_url,
                "record": record,
            },
        }
        source_listing_id = first_present(record, ["itemId", "legacyItemId", "id", "lotNumber", "listingId"])
        sale["sourceListingID"] = str(source_listing_id) if source_listing_id else source_listing_id_for_sale(source_id, sale)
        extracted.append(sale)

    return extracted


def parse_ebay_sold_json(payload: str, *, source: dict[str, Any], source_id: str, source_url: str) -> list[dict[str, Any]]:
    return parse_market_sales_json(
        payload,
        source=source,
        source_id=source_id,
        source_url=source_url,
        provider_default_source=EBAY_SOLD_SOURCE,
        price_paths=["price.value", "currentBidPrice.value", "salePrice", "price"],
        date_paths=["soldDate", "itemEndDate", "saleDate", "endedAt"],
        title_paths=["title", "name"],
        url_paths=["itemWebUrl", "viewItemURL", "url"],
        cert_paths=["certNumber", "psaCertNumber"],
        grade_paths=["grade", "psaGrade"],
    )


def parse_goldin_sales_json(payload: str, *, source: dict[str, Any], source_id: str, source_url: str) -> list[dict[str, Any]]:
    return parse_market_sales_json(
        payload,
        source=source,
        source_id=source_id,
        source_url=source_url,
        provider_default_source=GOLDIN_AUCTIONS_SOURCE,
        price_paths=["price_realized", "final_price", "salePrice", "price"],
        date_paths=["closed_at", "ended_at", "saleDate", "endDate"],
        title_paths=["title", "name", "lotTitle"],
        url_paths=["url", "lotUrl", "href"],
        cert_paths=["certNumber", "psaCertNumber"],
        grade_paths=["grade", "psaGrade"],
    )


def parse_heritage_sales_json(payload: str, *, source: dict[str, Any], source_id: str, source_url: str) -> list[dict[str, Any]]:
    return parse_market_sales_json(
        payload,
        source=source,
        source_id=source_id,
        source_url=source_url,
        provider_default_source=HERITAGE_AUCTIONS_SOURCE,
        price_paths=["priceRealized", "realizedPrice", "salePrice", "price"],
        date_paths=["endDate", "soldDate", "saleDate", "closedAt"],
        title_paths=["title", "name", "lotTitle"],
        url_paths=["url", "lotUrl", "href"],
        cert_paths=["certNumber", "psaCertNumber"],
        grade_paths=["grade", "psaGrade"],
    )


def parse_fanatics_sales_json(payload: str, *, source: dict[str, Any], source_id: str, source_url: str) -> list[dict[str, Any]]:
    return parse_market_sales_json(
        payload,
        source=source,
        source_id=source_id,
        source_url=source_url,
        provider_default_source=FANATICS_AUCTIONS_SOURCE,
        price_paths=["realizedPrice", "salePrice", "price.value", "price"],
        date_paths=["endedAt", "soldDate", "saleDate", "closedAt"],
        title_paths=["title", "name", "listingTitle"],
        url_paths=["url", "listingUrl", "href"],
        cert_paths=["certNumber", "psaCertNumber"],
        grade_paths=["grade", "psaGrade"],
    )


def source_listing_id_for_sale(source_id: str, sale: dict[str, Any]) -> str:
    parts = [
        source_id,
        str(sale.get("cardID") or ""),
        str(sale.get("grade") or ""),
        str(sale.get("saleDate") or ""),
        str(sale.get("salePrice") or ""),
        str(sale.get("title") or ""),
        str(sale.get("sourceURL") or ""),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]


def manifest_source_id(source: dict[str, Any], index: int) -> str:
    return str(source.get("id") or f"{source.get('provider', 'source')}-{source.get('cardID', 'unknown')}-{index}")


def load_slab_source_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or not isinstance(payload.get("sources"), list):
        raise ValueError("Manifest must be an object with a sources array")
    return payload


def env_placeholders(value: str) -> list[str]:
    return ENV_PLACEHOLDER_PATTERN.findall(value)


def expand_env_placeholders(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        return os.environ.get(match.group(1), "")

    return ENV_PLACEHOLDER_PATTERN.sub(replace, value)


def required_source_env_vars(source: dict[str, Any]) -> list[str]:
    env_names: set[str] = set()

    def collect_from_mapping(mapping: Any) -> None:
        if not isinstance(mapping, dict):
            return
        for key, value in mapping.items():
            if key is None or value is None:
                continue
            env_names.add(str(value))

    def collect_from_string(value: Any) -> None:
        if not isinstance(value, str):
            return
        for name in env_placeholders(value):
            env_names.add(name)

    collect_from_mapping(source.get("headerEnvs"))
    collect_from_mapping(source.get("queryParamEnvs"))

    if source.get("urlEnv"):
        env_names.add(str(source["urlEnv"]))
    if source.get("bodyEnv"):
        env_names.add(str(source["bodyEnv"]))

    for name in source.get("requiredEnvVars") or []:
        if name:
            env_names.add(str(name))

    collect_from_string(source.get("url"))
    collect_from_string(source.get("body") if isinstance(source.get("body"), str) else None)

    for mapping_key in ("headers", "queryParams"):
        mapping = source.get(mapping_key)
        if isinstance(mapping, dict):
            for value in mapping.values():
                collect_from_string(value)

    return sorted(env_names)


def missing_source_env_vars(source: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for env_name in required_source_env_vars(source):
        if not os.environ.get(env_name):
            missing.append(env_name)
    return missing


def source_sync_status(source: dict[str, Any], *, source_id: str, manifest_root: Path) -> dict[str, Any]:
    missing = missing_source_env_vars(source)
    file_path = source.get("filePath")
    fetch_mode = "file" if file_path else "remote"

    resolved_url = None
    if fetch_mode == "remote":
        try:
            resolved_url = resolve_source_url(source)
        except Exception:
            resolved_url = None

    return {
        "sourceID": source_id,
        "provider": source.get("provider"),
        "cardID": source.get("cardID"),
        "grader": source.get("grader"),
        "fetchMode": fetch_mode,
        "filePath": str((manifest_root / file_path).resolve()) if file_path and not Path(str(file_path)).is_absolute() else file_path,
        "resolvedURL": resolved_url,
        "requiredEnvVars": required_source_env_vars(source),
        "missingEnvVars": missing,
        "authReady": len(missing) == 0,
    }


def manifest_sync_status(manifest_path: Path) -> dict[str, Any]:
    manifest = load_slab_source_manifest(manifest_path)
    sources = [
        source_sync_status(source, source_id=manifest_source_id(source, index), manifest_root=manifest_path.parent)
        for index, source in enumerate(manifest["sources"])
    ]
    return {
        "manifestPath": str(manifest_path),
        "sourceCount": len(sources),
        "readySourceCount": sum(1 for source in sources if source["authReady"]),
        "missingEnvSourceCount": sum(1 for source in sources if source["missingEnvVars"]),
        "sources": sources,
    }


def resolve_source_headers(source: dict[str, Any]) -> dict[str, str]:
    headers = {"User-Agent": "Spotlight/1.0 (+https://spotlight.local)"}

    for key, value in (source.get("headers") or {}).items():
        if value:
            headers[str(key)] = expand_env_placeholders(str(value))

    for key, env_name in (source.get("headerEnvs") or {}).items():
        env_value = os.environ.get(str(env_name))
        if env_value:
            headers[str(key)] = env_value

    return headers


def resolve_source_url(source: dict[str, Any]) -> str:
    url_value = source.get("url")
    if not url_value and source.get("urlEnv"):
        url_value = os.environ.get(str(source["urlEnv"]))
    if not url_value:
        raise ValueError("Source must define either filePath or url/urlEnv")

    url_value = expand_env_placeholders(str(url_value))
    query_params: dict[str, str] = {}

    for key, value in (source.get("queryParams") or {}).items():
        if value is not None:
            query_params[str(key)] = expand_env_placeholders(str(value))

    for key, env_name in (source.get("queryParamEnvs") or {}).items():
        env_value = os.environ.get(str(env_name))
        if env_value:
            query_params[str(key)] = env_value

    if not query_params:
        return url_value

    parsed = urlparse(url_value)
    merged_query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    merged_query.update(query_params)
    return urlunparse(parsed._replace(query=urlencode(merged_query)))


def resolve_source_body(source: dict[str, Any]) -> tuple[bytes | None, str | None]:
    if source.get("bodyEnv"):
        body_value = os.environ.get(str(source["bodyEnv"]))
        if body_value is None:
            return None, None
        return body_value.encode("utf-8"), str(source.get("bodyContentType") or "application/json")

    if "body" not in source:
        return None, None

    body = source.get("body")
    if isinstance(body, (dict, list)):
        return json.dumps(body).encode("utf-8"), "application/json"
    if body is None:
        return None, None
    return expand_env_placeholders(str(body)).encode("utf-8"), str(source.get("bodyContentType") or "application/json")


def fetch_source_payload(source: dict[str, Any], manifest_root: Path) -> tuple[str, str]:
    file_path = source.get("filePath")
    if file_path:
        resolved = Path(file_path)
        if not resolved.is_absolute():
            resolved = manifest_root / resolved
        return resolved.read_text(encoding="utf-8"), resolved.as_uri()

    missing_envs = missing_source_env_vars(source)
    if missing_envs:
        raise ValueError(f"Missing required env vars: {', '.join(missing_envs)}")

    url = resolve_source_url(source)
    method = str(source.get("method") or "GET").upper()
    body, content_type = resolve_source_body(source)
    headers = resolve_source_headers(source)
    if body is not None and content_type and "Content-Type" not in headers:
        headers["Content-Type"] = content_type

    request = Request(str(url), headers=headers, data=body, method=method)
    with urlopen(request, timeout=int(source.get("timeoutSeconds", 20))) as response:
        body = response.read().decode("utf-8", "ignore")
    return body, str(url)


def header_index_map(headers: list[str]) -> dict[str, int]:
    aliases = {
        "date": {"date", "sale date", "auction date"},
        "price": {"price", "sale price", "value"},
        "grade": {"grade", "psa", "psa grade"},
        "cert": {"cert", "cert number", "cert #"},
        "title": {"title", "item", "card"},
        "source": {"source", "auction", "auction house", "venue"},
        "link": {"link", "details"},
    }

    mapping: dict[str, int] = {}
    for index, header in enumerate(headers):
        normalized = normalize_header(header)
        for key, candidates in aliases.items():
            if normalized in candidates and key not in mapping:
                mapping[key] = index
    return mapping


def parse_psa_auction_prices_html(
    html: str,
    *,
    source: dict[str, Any],
    source_id: str,
    source_url: str,
) -> list[dict[str, Any]]:
    parser = TableHTMLParser()
    parser.feed(html)

    extracted: list[dict[str, Any]] = []

    for table in parser.tables:
        if len(table.rows) < 2:
            continue

        header_row = table.rows[0]
        if not all(cell.kind == "th" for cell in header_row.cells):
            continue

        headers = [cell.text for cell in header_row.cells]
        mapping = header_index_map(headers)
        if not {"date", "price"} <= set(mapping.keys()):
            continue
        if "grade" not in mapping and not source.get("fixedGrade"):
            continue

        for row in table.rows[1:]:
            cells = row.cells

            def cell_text(key: str) -> str:
                index = mapping.get(key)
                if index is None or index >= len(cells):
                    return ""
                return cells[index].text

            def cell_href(key: str) -> str | None:
                index = mapping.get(key)
                if index is None or index >= len(cells):
                    return None
                return cells[index].href

            grade_text = str(source.get("fixedGrade") or cell_text("grade")).strip()
            if not grade_text:
                continue

            grade = parse_grade_text(grade_text) or parse_psa_grade(f"PSA {grade_text}") or parse_psa_grade(grade_text)
            if grade is None:
                continue

            sale_price = parse_money_value(cell_text("price"))
            sale_date = parse_human_date(cell_text("date"))
            if sale_price is None or sale_date is None:
                continue

            title = cell_text("title") or str(source.get("title") or "")
            cert_number = cell_text("cert") or None
            listing_href = cell_href("link")
            sale_url = urljoin(source_url, listing_href) if listing_href else source_url
            market_source = cell_text("source") or PSA_AUCTION_PRICES_SOURCE

            sale = {
                "cardID": source["cardID"],
                "grader": str(source.get("grader") or "PSA").upper(),
                "grade": grade,
                "salePrice": sale_price,
                "currencyCode": str(source.get("currencyCode") or "USD").upper(),
                "saleDate": sale_date,
                "source": str(source.get("source") or PSA_AUCTION_PRICES_SOURCE),
                "sourceURL": sale_url,
                "certNumber": cert_number,
                "title": title or None,
                "bucketKey": source.get("bucketKey"),
                "accepted": True,
                "sourcePayload": {
                    "provider": source.get("provider"),
                    "sourceID": source_id,
                    "sourceURL": source_url,
                    "row": {headers[index]: cells[index].text for index in range(min(len(headers), len(cells)))},
                    "marketSource": market_source,
                },
            }
            sale["sourceListingID"] = source_listing_id_for_sale(source_id, sale)
            extracted.append(sale)

    return extracted


def sales_from_source(source: dict[str, Any], *, source_id: str, manifest_root: Path) -> tuple[list[dict[str, Any]], str]:
    provider = str(source.get("provider") or "").strip()
    if not provider:
        raise ValueError("Source provider is required")

    payload, source_url = fetch_source_payload(source, manifest_root)

    if provider == "psa_apr_html":
        return parse_psa_auction_prices_html(
            payload,
            source=source,
            source_id=source_id,
            source_url=source_url,
        ), source_url
    if provider == "ebay_sold_json":
        return parse_ebay_sold_json(
            payload,
            source=source,
            source_id=source_id,
            source_url=source_url,
        ), source_url
    if provider == "goldin_sales_json":
        return parse_goldin_sales_json(
            payload,
            source=source,
            source_id=source_id,
            source_url=source_url,
        ), source_url
    if provider == "heritage_sales_json":
        return parse_heritage_sales_json(
            payload,
            source=source,
            source_id=source_id,
            source_url=source_url,
        ), source_url
    if provider == "fanatics_sales_json":
        return parse_fanatics_sales_json(
            payload,
            source=source,
            source_id=source_id,
            source_url=source_url,
        ), source_url

    raise ValueError(f"Unsupported slab source provider: {provider}")


def load_sync_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"updatedAt": None, "sources": {}}
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        return {"updatedAt": None, "sources": {}}
    payload.setdefault("sources", {})
    return payload


def write_sync_state(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True))


def sync_slab_sources_once(
    *,
    database_path: Path,
    repo_root: Path,
    manifest_path: Path,
    cards_file: str | None = None,
    state_path: Path | None = None,
) -> dict[str, Any]:
    backend_root = repo_root / "backend"
    connection = connect(database_path)
    try:
        apply_schema(connection, backend_root / "schema.sql")
        if cards_file is not None:
            cards_path = resolve_catalog_json_path(backend_root, explicit_path=cards_file)
            seed_catalog(connection, load_cards_json(cards_path), repo_root)

        manifest = load_slab_source_manifest(manifest_path)
        state_path = state_path or backend_root / "data" / "slab_source_sync_state.json"
        existing_state = load_sync_state(state_path)

        started_at = utc_now()
        overall_sources: list[dict[str, Any]] = []
        total_inserted = 0
        total_skipped = 0

        for index, source in enumerate(manifest["sources"]):
            source_id = manifest_source_id(source, index)
            source_started_at = utc_now()
            readiness = source_sync_status(source, source_id=source_id, manifest_root=manifest_path.parent)
            try:
                sales, resolved_source_url = sales_from_source(source, source_id=source_id, manifest_root=manifest_path.parent)
                summary = import_slab_sales(connection, sales)
                total_inserted += summary["inserted"]
                total_skipped += summary["skippedDuplicates"]
                source_result = {
                    "sourceID": source_id,
                    "provider": source.get("provider"),
                    "cardID": source.get("cardID"),
                    "status": "ok",
                    "fetchedAt": source_started_at,
                    "sourceURL": resolved_source_url,
                    "missingEnvVars": readiness["missingEnvVars"],
                    "authReady": readiness["authReady"],
                    "saleCount": len(sales),
                    "summary": summary,
                }
            except Exception as error:
                source_result = {
                    "sourceID": source_id,
                    "provider": source.get("provider"),
                    "cardID": source.get("cardID"),
                    "status": "error",
                    "fetchedAt": source_started_at,
                    "missingEnvVars": readiness["missingEnvVars"],
                    "authReady": readiness["authReady"],
                    "error": str(error),
                }
            overall_sources.append(source_result)
            existing_state["sources"][source_id] = source_result

        finished_at = utc_now()
        existing_state["updatedAt"] = finished_at
        write_sync_state(state_path, existing_state)

        return {
            "startedAt": started_at,
            "finishedAt": finished_at,
            "manifestPath": str(manifest_path),
            "statePath": str(state_path),
            "inserted": total_inserted,
            "skippedDuplicates": total_skipped,
            "sources": overall_sources,
        }
    finally:
        connection.close()


def run_slab_source_sync_loop(
    *,
    database_path: Path,
    repo_root: Path,
    manifest_path: Path,
    interval_seconds: int,
    cards_file: str | None = None,
    state_path: Path | None = None,
) -> None:
    while True:
        summary = sync_slab_sources_once(
            database_path=database_path,
            repo_root=repo_root,
            manifest_path=manifest_path,
            cards_file=cards_file,
            state_path=state_path,
        )
        print(json.dumps({"summary": summary}, indent=2), flush=True)
        time.sleep(max(interval_seconds, 1))
