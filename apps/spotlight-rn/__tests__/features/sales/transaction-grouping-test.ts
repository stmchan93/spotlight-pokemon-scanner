import type { CardTransactionRecord } from '@spotlight/api-client';

import {
  groupTransactionsByDay,
  listTransactionYears,
  sortTransactions,
} from '@/features/sales/transaction-grouping';

function makeRecord(
  overrides: Partial<CardTransactionRecord> & { id: string; occurredAt: string },
): CardTransactionRecord {
  return {
    kind: 'sold',
    amountCents: 1000,
    currencyCode: 'USD',
    note: null,
    occurredAtLabel: null,
    itemCount: 1,
    photoUrl: null,
    createdAt: null,
    ...overrides,
  };
}

describe('groupTransactionsByDay', () => {
  it('buckets records by calendar day and labels the header', () => {
    // Local-time (no trailing Z) so bucketing is timezone-independent under CI.
    const groups = groupTransactionsByDay([
      makeRecord({ id: 'a', occurredAt: '2026-05-24T09:00:00' }),
      makeRecord({ id: 'b', occurredAt: '2026-05-24T20:00:00' }),
      makeRecord({ id: 'c', occurredAt: '2026-05-23T12:00:00' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].dayKey).toBe('2026-05-24');
    expect(groups[0].dayNumber).toBe('24');
    expect(groups[0].monthLabel).toBe('MAY');
    expect(groups[0].records.map((r) => r.id)).toEqual(['b', 'a']);
    expect(groups[1].dayKey).toBe('2026-05-23');
  });

  it('orders day groups newest-first', () => {
    const groups = groupTransactionsByDay([
      makeRecord({ id: 'old', occurredAt: '2025-01-01T00:00:00.000Z' }),
      makeRecord({ id: 'new', occurredAt: '2026-06-01T00:00:00.000Z' }),
      makeRecord({ id: 'mid', occurredAt: '2026-01-15T00:00:00.000Z' }),
    ]);

    expect(groups.map((g) => g.records[0].id)).toEqual(['new', 'mid', 'old']);
  });

  it('orders records within a day newest-first', () => {
    const groups = groupTransactionsByDay([
      makeRecord({ id: 'morning', occurredAt: '2026-05-24T08:00:00' }),
      makeRecord({ id: 'night', occurredAt: '2026-05-24T23:00:00' }),
      makeRecord({ id: 'noon', occurredAt: '2026-05-24T12:00:00' }),
    ]);

    expect(groups[0].records.map((r) => r.id)).toEqual(['night', 'noon', 'morning']);
  });

  it('collapses invalid/missing dates into a single trailing unknown group', () => {
    const groups = groupTransactionsByDay([
      makeRecord({ id: 'valid', occurredAt: '2026-05-24T08:00:00' }),
      makeRecord({ id: 'bad1', occurredAt: 'not-a-date' }),
      makeRecord({ id: 'bad2', occurredAt: '' }),
    ]);

    expect(groups[0].dayKey).toBe('2026-05-24');
    const last = groups[groups.length - 1];
    expect(last.dayKey).toBe('unknown');
    expect(last.dayNumber).toBe('');
    expect(last.monthLabel).toBe('');
    expect(last.records.map((r) => r.id)).toEqual(['bad1', 'bad2']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeRecord({ id: 'a', occurredAt: '2026-05-24T08:00:00.000Z' }),
      makeRecord({ id: 'b', occurredAt: '2026-05-25T08:00:00.000Z' }),
    ];
    const snapshot = input.map((r) => r.id);
    groupTransactionsByDay(input);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('listTransactionYears', () => {
  it('returns unique years in descending order', () => {
    // Local-time fixtures (no trailing Z) so year extraction is
    // timezone-independent under CI — matches the groupTransactionsByDay tests.
    const years = listTransactionYears([
      makeRecord({ id: 'a', occurredAt: '2026-05-24T00:00:00' }),
      makeRecord({ id: 'b', occurredAt: '2024-01-01T00:00:00' }),
      makeRecord({ id: 'c', occurredAt: '2026-01-01T00:00:00' }),
      makeRecord({ id: 'd', occurredAt: '2025-12-31T00:00:00' }),
    ]);

    expect(years).toEqual([2026, 2025, 2024]);
  });

  it('ignores records with unparseable dates', () => {
    const years = listTransactionYears([
      makeRecord({ id: 'a', occurredAt: '2026-05-24T00:00:00.000Z' }),
      makeRecord({ id: 'bad', occurredAt: 'nope' }),
    ]);

    expect(years).toEqual([2026]);
  });

  it('returns an empty array when there are no valid dates', () => {
    expect(listTransactionYears([])).toEqual([]);
    expect(listTransactionYears([makeRecord({ id: 'bad', occurredAt: '' })])).toEqual([]);
  });
});

describe('sortTransactions', () => {
  it('sorts by price ascending with null prices last', () => {
    const sorted = sortTransactions(
      [
        makeRecord({ id: 'mid', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 2000 }),
        makeRecord({ id: 'null', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: null }),
        makeRecord({ id: 'low', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 500 }),
      ],
      'price',
      'asc',
    );

    expect(sorted.map((r) => r.id)).toEqual(['low', 'mid', 'null']);
  });

  it('sorts by price descending with null prices still last', () => {
    const sorted = sortTransactions(
      [
        makeRecord({ id: 'low', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 500 }),
        makeRecord({ id: 'null', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: null }),
        makeRecord({ id: 'high', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 9000 }),
      ],
      'price',
      'desc',
    );

    expect(sorted.map((r) => r.id)).toEqual(['high', 'low', 'null']);
  });

  it('sorts by date descending with bad dates last', () => {
    const sorted = sortTransactions(
      [
        makeRecord({ id: 'old', occurredAt: '2025-01-01T00:00:00.000Z' }),
        makeRecord({ id: 'bad', occurredAt: 'nope' }),
        makeRecord({ id: 'new', occurredAt: '2026-06-01T00:00:00.000Z' }),
      ],
      'date',
      'desc',
    );

    expect(sorted.map((r) => r.id)).toEqual(['new', 'old', 'bad']);
  });

  it('sorts by date ascending with bad dates still last', () => {
    const sorted = sortTransactions(
      [
        makeRecord({ id: 'new', occurredAt: '2026-06-01T00:00:00.000Z' }),
        makeRecord({ id: 'bad', occurredAt: 'nope' }),
        makeRecord({ id: 'old', occurredAt: '2025-01-01T00:00:00.000Z' }),
      ],
      'date',
      'asc',
    );

    expect(sorted.map((r) => r.id)).toEqual(['old', 'new', 'bad']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeRecord({ id: 'a', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 100 }),
      makeRecord({ id: 'b', occurredAt: '2026-05-24T00:00:00.000Z', amountCents: 200 }),
    ];
    const snapshot = input.map((r) => r.id);
    sortTransactions(input, 'price', 'desc');
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});
