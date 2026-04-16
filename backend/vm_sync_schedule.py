from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class CronExpression:
    minute: str
    hour: str
    day_of_month: str
    month: str
    day_of_week: str


def parse_cron_expression(expression: str) -> CronExpression:
    parts = str(expression or "").strip().split()
    if len(parts) != 5:
        raise ValueError(f"Expected 5 cron fields, got {len(parts)}: {expression!r}")
    return CronExpression(*parts)


def _is_wildcard(field: str) -> bool:
    return field.strip() in {"*", "?"}


def _coerce_field_value(raw: str, *, minimum: int, maximum: int, day_of_week: bool = False) -> int:
    value = int(raw)
    if day_of_week and value == 7:
        value = 0
    if not minimum <= value <= maximum:
        raise ValueError(f"Field value {value} outside {minimum}..{maximum}")
    return value


def _field_matches(
    value: int,
    expression: str,
    *,
    minimum: int,
    maximum: int,
    day_of_week: bool = False,
) -> bool:
    for raw_part in expression.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if _is_wildcard(part):
            return True

        step = 1
        if "/" in part:
            base, raw_step = part.split("/", 1)
            step = int(raw_step)
            part = base.strip() or "*"

        if _is_wildcard(part):
            start = minimum
            end = maximum
        elif "-" in part:
            raw_start, raw_end = part.split("-", 1)
            start = _coerce_field_value(
                raw_start.strip(),
                minimum=minimum,
                maximum=maximum,
                day_of_week=day_of_week,
            )
            end = _coerce_field_value(
                raw_end.strip(),
                minimum=minimum,
                maximum=maximum,
                day_of_week=day_of_week,
            )
        else:
            start = _coerce_field_value(
                part,
                minimum=minimum,
                maximum=maximum,
                day_of_week=day_of_week,
            )
            end = start

        if start <= value <= end and ((value - start) % step == 0):
            return True

    return False


def cron_matches(dt_local: datetime, expression: str) -> bool:
    cron = parse_cron_expression(expression)
    day_of_week = (dt_local.weekday() + 1) % 7

    minute_matches = _field_matches(dt_local.minute, cron.minute, minimum=0, maximum=59)
    hour_matches = _field_matches(dt_local.hour, cron.hour, minimum=0, maximum=23)
    month_matches = _field_matches(dt_local.month, cron.month, minimum=1, maximum=12)
    dom_matches = _field_matches(dt_local.day, cron.day_of_month, minimum=1, maximum=31)
    dow_matches = _field_matches(
        day_of_week,
        cron.day_of_week,
        minimum=0,
        maximum=6,
        day_of_week=True,
    )

    if _is_wildcard(cron.day_of_month) and _is_wildcard(cron.day_of_week):
        day_matches = True
    elif _is_wildcard(cron.day_of_month):
        day_matches = dow_matches
    elif _is_wildcard(cron.day_of_week):
        day_matches = dom_matches
    else:
        day_matches = dom_matches or dow_matches

    return all([minute_matches, hour_matches, month_matches, day_matches])


def should_run_now(
    expression: str,
    timezone_name: str,
    *,
    now_utc: datetime | None = None,
) -> bool:
    tz = ZoneInfo(timezone_name)
    current_utc = now_utc or datetime.now(timezone.utc)
    if current_utc.tzinfo is None:
        current_utc = current_utc.replace(tzinfo=timezone.utc)
    return cron_matches(current_utc.astimezone(tz), expression)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a cron expression in a target timezone.")
    parser.add_argument("--cron", required=True, help="Five-field cron expression")
    parser.add_argument("--timezone", required=True, help="IANA timezone name")
    parser.add_argument(
        "--should-run-now",
        action="store_true",
        help="Exit 0 when the current time in the target timezone matches the cron expression",
    )
    args = parser.parse_args()

    if args.should_run_now:
        raise SystemExit(0 if should_run_now(args.cron, args.timezone) else 1)

    now_local = datetime.now(timezone.utc).astimezone(ZoneInfo(args.timezone))
    print(
        {
            "cron": args.cron,
            "timezone": args.timezone,
            "nowLocal": now_local.isoformat(),
            "matches": cron_matches(now_local, args.cron),
        }
    )


if __name__ == "__main__":
    main()
