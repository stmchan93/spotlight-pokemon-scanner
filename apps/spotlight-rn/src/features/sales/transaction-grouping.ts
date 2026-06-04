import type { CardTransactionRecord } from '@spotlight/api-client';

/**
 * Pure, dependency-free helpers for the Transactions list screen.
 *
 * These functions never mutate their inputs and are deterministic so they can
 * be unit tested in isolation. Records with an invalid or missing `occurredAt`
 * are tolerated: they sort/bucket last instead of throwing.
 */

export type TransactionSortKey = 'date' | 'price';
export type TransactionSortDir = 'asc' | 'desc';

export type TransactionDayGroup = {
  /** Stable calendar-day key in `YYYY-MM-DD` form (or `unknown` for bad dates). */
  dayKey: string;
  /** Big day number for the group header, e.g. `"24"`. Empty for bad dates. */
  dayNumber: string;
  /** Short, uppercased month label for the group header, e.g. `"MAY"`. */
  monthLabel: string;
  records: CardTransactionRecord[];
};

const UNKNOWN_DAY_KEY = 'unknown';

const MONTH_LABELS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/** Returns a valid `Date` for `occurredAt`, or `null` when it cannot be parsed. */
function parseOccurredAt(isoText: string | null | undefined): Date | null {
  if (!isoText) {
    return null;
  }
  const parsed = new Date(isoText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Millisecond timestamp used for ordering; bad dates sink to the bottom. */
function occurredAtTime(record: CardTransactionRecord): number {
  const parsed = parseOccurredAt(record.occurredAt);
  return parsed ? parsed.getTime() : Number.NEGATIVE_INFINITY;
}

/**
 * Descending list of unique calendar years present in `records` (by
 * `occurredAt`). Records with unparseable dates are ignored.
 */
export function listTransactionYears(records: CardTransactionRecord[]): number[] {
  const years = new Set<number>();
  for (const record of records) {
    const parsed = parseOccurredAt(record.occurredAt);
    if (parsed) {
      years.add(parsed.getFullYear());
    }
  }
  return Array.from(years).sort((a, b) => b - a);
}

/**
 * Returns a new array sorted by `sortKey`/`dir`.
 *
 * - `date` orders by `occurredAt`; bad dates always sink to the end.
 * - `price` orders by `amountCents`; `null` prices always sink to the end
 *   regardless of direction (they have no comparable value).
 */
export function sortTransactions(
  records: CardTransactionRecord[],
  sortKey: TransactionSortKey,
  dir: TransactionSortDir,
): CardTransactionRecord[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...records];

  sorted.sort((a, b) => {
    if (sortKey === 'price') {
      const aNull = a.amountCents == null;
      const bNull = b.amountCents == null;
      if (aNull && bNull) {
        return 0;
      }
      // Null prices always sort last, independent of direction.
      if (aNull) {
        return 1;
      }
      if (bNull) {
        return -1;
      }
      return (a.amountCents! - b.amountCents!) * sign;
    }

    const aTime = occurredAtTime(a);
    const bTime = occurredAtTime(b);
    if (aTime === bTime) {
      return 0;
    }
    // Unparseable dates (NEGATIVE_INFINITY) always sort last.
    if (aTime === Number.NEGATIVE_INFINITY) {
      return 1;
    }
    if (bTime === Number.NEGATIVE_INFINITY) {
      return -1;
    }
    return (aTime - bTime) * sign;
  });

  return sorted;
}

/**
 * Buckets `records` by calendar day of `occurredAt`.
 *
 * - Groups are ordered newest-day-first.
 * - Records within a group are ordered newest-first.
 * - Records with an invalid/missing date collapse into a single trailing
 *   `unknown` group so they are never silently dropped.
 */
export function groupTransactionsByDay(
  records: CardTransactionRecord[],
): TransactionDayGroup[] {
  const buckets = new Map<string, TransactionDayGroup>();

  for (const record of records) {
    const parsed = parseOccurredAt(record.occurredAt);

    let dayKey: string;
    let dayNumber: string;
    let monthLabel: string;

    if (parsed) {
      const year = parsed.getFullYear();
      const month = parsed.getMonth();
      const day = parsed.getDate();
      dayKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      dayNumber = String(day);
      monthLabel = MONTH_LABELS[month];
    } else {
      dayKey = UNKNOWN_DAY_KEY;
      dayNumber = '';
      monthLabel = '';
    }

    const existing = buckets.get(dayKey);
    if (existing) {
      existing.records.push(record);
    } else {
      buckets.set(dayKey, { dayKey, dayNumber, monthLabel, records: [record] });
    }
  }

  const groups = Array.from(buckets.values());

  // Newest day first; the unknown bucket always sinks to the end.
  groups.sort((a, b) => {
    if (a.dayKey === UNKNOWN_DAY_KEY) {
      return 1;
    }
    if (b.dayKey === UNKNOWN_DAY_KEY) {
      return -1;
    }
    return a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0;
  });

  // Newest record first within each group.
  for (const group of groups) {
    group.records.sort((a, b) => occurredAtTime(b) - occurredAtTime(a));
  }

  return groups;
}
