"""SQLite write-lock diagnostics.

`InstrumentedConnection` (pass as `factory=` to sqlite3.connect) logs slow or
locked writes, and a watchdog thread logs write transactions held open too
long, with the holder thread's live Python stack. Hot-path cost is a few
attribute reads per statement; anything heavier only runs on the slow path.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import traceback
import weakref
from http.server import BaseHTTPRequestHandler
from time import monotonic, perf_counter, sleep
from typing import Any, Callable

SLOW_WRITE_MS_ENV = "SPOTLIGHT_SQLITE_SLOW_WRITE_MS"
LONG_TRANSACTION_SECONDS_ENV = "SPOTLIGHT_SQLITE_LONG_TRANSACTION_SECONDS"
WATCHDOG_INTERVAL_SECONDS_ENV = "SPOTLIGHT_SQLITE_WATCHDOG_INTERVAL_SECONDS"
LONG_TRANSACTION_REPEAT_SECONDS = 60.0
_WRITE_PREFIXES = ("INSERT", "UPDATE", "DELETE", "REPLACE", "BEGIN", "COMMIT", "CREATE", "DROP", "ALTER")
_THIS_FILE = os.path.abspath(__file__)


def _env_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return value if value > 0 else default


def slow_write_threshold_seconds() -> float:
    return _env_float(SLOW_WRITE_MS_ENV, 2000.0) / 1000.0


def long_transaction_threshold_seconds() -> float:
    return _env_float(LONG_TRANSACTION_SECONDS_ENV, 10.0)


def is_lock_error(error: BaseException) -> bool:
    if not isinstance(error, sqlite3.OperationalError):
        return False
    message = str(error).lower()
    return "locked" in message or "busy" in message


def _default_emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)


_emit: Callable[[dict[str, Any]], None] = _default_emit


def set_log_emitter(emitter: Callable[[dict[str, Any]], None] | None) -> None:
    global _emit
    _emit = emitter or _default_emit


def _safe_emit(payload: dict[str, Any]) -> None:
    try:
        _emit(payload)
    except Exception:  # noqa: BLE001 - diagnostics must never break a write
        pass


def _caller_context(frame: Any) -> dict[str, Any]:
    """Nearest non-diagnostic call sites plus the HTTP endpoint, if any."""
    operation: list[str] = []
    endpoint: str | None = None
    while frame is not None:
        code = frame.f_code
        if os.path.abspath(code.co_filename) != _THIS_FILE:
            if len(operation) < 4:
                operation.append(f"{code.co_name} ({os.path.basename(code.co_filename)}:{frame.f_lineno})")
            if endpoint is None and code.co_name.startswith("do_"):
                handler = frame.f_locals.get("self")
                if isinstance(handler, BaseHTTPRequestHandler):
                    # Path only; query strings can carry tokens/emails.
                    path = str(getattr(handler, "path", "") or "").split("?", 1)[0]
                    endpoint = f"{getattr(handler, 'command', '')} {path}".strip()
        frame = frame.f_back
    return {"operation": operation, "endpoint": endpoint}


def _statement_preview(sql: Any) -> str:
    return " ".join(str(sql or "").split())[:120]


def _is_write_sql(sql: Any) -> bool:
    return str(sql or "").lstrip()[:7].upper().startswith(_WRITE_PREFIXES)


def report_lock_event(
    *,
    event: str,
    wait_seconds: float,
    statement: Any = None,
    error: BaseException | None = None,
    in_transaction: bool | None = None,
) -> None:
    context = _caller_context(sys._getframe(1))
    payload: dict[str, Any] = {
        "severity": "WARNING",
        "event": event,
        "thread": threading.current_thread().name,
        "endpoint": context["endpoint"],
        "operation": context["operation"],
        "waitMs": round(wait_seconds * 1000.0, 1),
        "statement": _statement_preview(statement) if statement is not None else None,
        "inTransaction": in_transaction,
    }
    if error is not None:
        payload["error"] = str(error)
    _safe_emit(payload)


_registry_lock = threading.Lock()
_registry: "weakref.WeakSet[InstrumentedConnection]" = weakref.WeakSet()


class InstrumentedConnection(sqlite3.Connection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.diag_thread_ident = threading.get_ident()
        self.diag_thread_name = threading.current_thread().name
        self.diag_tx_started: float | None = None
        with _registry_lock:
            _registry.add(self)

    def _after(self, was_in_transaction: bool) -> None:
        if self.in_transaction:
            if not was_in_transaction or self.diag_tx_started is None:
                self.diag_tx_started = monotonic()
        else:
            self.diag_tx_started = None

    def _timed(self, call: Callable[[], Any], statement: Any, *, always_write: bool = False) -> Any:
        was_in_transaction = self.in_transaction
        started = perf_counter()
        try:
            result = call()
        except sqlite3.OperationalError as error:
            if is_lock_error(error):
                report_lock_event(
                    event="sqlite_write_locked",
                    wait_seconds=perf_counter() - started,
                    statement=statement,
                    error=error,
                    in_transaction=was_in_transaction,
                )
            raise
        finally:
            try:
                self._after(was_in_transaction)
            except sqlite3.ProgrammingError:
                pass
        elapsed = perf_counter() - started
        if elapsed >= slow_write_threshold_seconds() and (always_write or _is_write_sql(statement)):
            report_lock_event(
                event="sqlite_slow_write",
                wait_seconds=elapsed,
                statement=statement,
                in_transaction=was_in_transaction,
            )
        return result

    def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:  # type: ignore[override]
        return self._timed(lambda: super(InstrumentedConnection, self).execute(sql, parameters), sql)

    def executemany(self, sql: str, parameters: Any, /) -> sqlite3.Cursor:  # type: ignore[override]
        return self._timed(lambda: super(InstrumentedConnection, self).executemany(sql, parameters), sql)

    def executescript(self, sql_script: str, /) -> sqlite3.Cursor:  # type: ignore[override]
        return self._timed(lambda: super(InstrumentedConnection, self).executescript(sql_script), sql_script)

    def commit(self) -> None:
        self._timed(lambda: super(InstrumentedConnection, self).commit(), "COMMIT", always_write=True)

    def rollback(self) -> None:
        try:
            super().rollback()
        finally:
            self.diag_tx_started = None


# Watchdog: id(connection) -> monotonic time the watchdog first saw it open.
# Fallback for transactions opened via cursor.execute (not timed above).
_first_seen_open: dict[int, float] = {}
_last_reported: dict[int, float] = {}
_watchdog_lock = threading.Lock()
_watchdog_thread: threading.Thread | None = None


def check_long_transactions(*, threshold_seconds: float | None = None, now: float | None = None) -> list[dict[str, Any]]:
    """One watchdog pass. Returns (and logs) every over-threshold transaction."""
    threshold = long_transaction_threshold_seconds() if threshold_seconds is None else threshold_seconds
    current = monotonic() if now is None else now
    with _registry_lock:
        connections = list(_registry)
    frames = None
    reports: list[dict[str, Any]] = []
    open_ids: set[int] = set()
    for connection in connections:
        try:
            in_transaction = connection.in_transaction
        except sqlite3.ProgrammingError:
            continue
        key = id(connection)
        if not in_transaction:
            continue
        open_ids.add(key)
        first_seen = _first_seen_open.setdefault(key, current)
        started = connection.diag_tx_started or first_seen
        age = current - started
        if age < threshold:
            continue
        last = _last_reported.get(key)
        if last is not None and current - last < LONG_TRANSACTION_REPEAT_SECONDS:
            continue
        _last_reported[key] = current
        if frames is None:
            frames = sys._current_frames()
        frame = frames.get(connection.diag_thread_ident)
        stack = traceback.format_stack(frame)[-25:] if frame is not None else []
        report = {
            "severity": "WARNING",
            "event": "sqlite_long_transaction",
            "thread": connection.diag_thread_name,
            "threadAlive": frame is not None,
            "ageSeconds": round(age, 1),
            "stack": [line.rstrip() for line in stack],
        }
        reports.append(report)
        _safe_emit(report)
    for key in list(_first_seen_open):
        if key not in open_ids:
            _first_seen_open.pop(key, None)
            _last_reported.pop(key, None)
    return reports


def _watchdog_loop(interval_seconds: float) -> None:
    while True:
        try:
            check_long_transactions()
        except Exception:  # noqa: BLE001 - keep watching
            pass
        sleep(interval_seconds)


def ensure_watchdog_started() -> None:
    global _watchdog_thread
    with _watchdog_lock:
        if _watchdog_thread is not None and _watchdog_thread.is_alive():
            return
        interval = _env_float(WATCHDOG_INTERVAL_SECONDS_ENV, 5.0)
        _watchdog_thread = threading.Thread(
            target=_watchdog_loop,
            args=(interval,),
            name="sqlite-long-transaction-watchdog",
            daemon=True,
        )
        _watchdog_thread.start()
