import type { CardPriceTrendRow } from '@spotlight/api-client';

import {
  buildGradeLadder,
  buildRawPriceRows,
  formatLadderDelta,
  formatLadderMultiple,
  gradeFromRowKey,
  hasUsdPrice,
  rawBaselineRow,
  rawConditionKey,
  topGradeQuote,
} from '@/features/cards/grade-ladder';

const row = (key: string, currentPrice: number | null, currencyCode = 'USD'): CardPriceTrendRow => ({
  key,
  label: key,
  currentPrice,
  currencyCode,
  points: [],
  trendPct: null,
});

describe('gradeFromRowKey', () => {
  it('reads the grade from pipe and legacy space keys', () => {
    expect(gradeFromRowKey('PSA|9.5|Holofoil')).toBe('9.5');
    expect(gradeFromRowKey('PSA 10')).toBe('10');
    expect(gradeFromRowKey('PSA')).toBeNull();
  });
});

describe('rawBaselineRow', () => {
  it('prefers the Near Mint row, else the first row', () => {
    expect(rawBaselineRow([row('Holofoil|LP', 5), row('Holofoil|NM', 8)])?.key).toBe('Holofoil|NM');
    expect(rawBaselineRow([row('LP', 5), row('MP', 3)])?.key).toBe('LP');
    expect(rawBaselineRow([])).toBeNull();
  });
});

describe('buildGradeLadder', () => {
  it('sorts grades high → low numerically, not as strings', () => {
    const ladder = buildGradeLadder(row('NM', 10), [
      row('PSA|10|Holofoil', 300),
      row('PSA|8.5|Holofoil', 40),
      row('PSA|9|Holofoil', 60),
      row('PSA|1|Holofoil', 5),
    ]);
    expect(ladder.rungs.map((rung) => rung.grade)).toEqual(['10', '9', '8.5', '1']);
    expect(ladder.baseline).toEqual({ label: 'Raw · NM', price: 10 });
    expect(ladder.rungs[0]).toMatchObject({ deltaUsd: 290, multiple: 30, barRatio: 1 });
  });

  it('drops non-USD and unpriced rows, and a non-USD baseline', () => {
    const ladder = buildGradeLadder(row('NM', 1200, 'JPY'), [
      row('PSA|10|Holofoil', 50000, 'JPY'),
      row('PSA|9|Holofoil', null),
      row('PSA|8|Holofoil', 0),
      row('PSA|7|Holofoil', 20),
    ]);
    expect(ladder.baseline).toBeNull();
    expect(ladder.rungs.map((rung) => rung.grade)).toEqual(['7']);
  });

  it('leaves +$ and × empty without a baseline', () => {
    const ladder = buildGradeLadder(null, [row('PSA 10', 100)]);
    expect(ladder.baseline).toBeNull();
    expect(ladder.rungs[0]).toMatchObject({ deltaUsd: null, multiple: null, barRatio: 1 });
  });

  it('carries a negative delta when a grade sells under raw', () => {
    const ladder = buildGradeLadder(row('NM', 50), [row('PSA|3|Holofoil', 30)]);
    expect(ladder.rungs[0]?.deltaUsd).toBe(-20);
    expect(ladder.rungs[0]?.multiple).toBeCloseTo(0.6);
    expect(ladder.rungs[0]?.barRatio).toBeCloseTo(0.6);
  });
});

describe('formatLadderDelta', () => {
  it('signs and rounds by magnitude', () => {
    expect(formatLadderDelta(12.5)).toBe('+$12.50');
    expect(formatLadderDelta(-20)).toBe('−$20.00');
    expect(formatLadderDelta(0)).toBe('$0.00');
    expect(formatLadderDelta(1234.56)).toBe('+$1,235');
  });
});

describe('formatLadderMultiple', () => {
  it('keeps one decimal under 10×, rounds above', () => {
    expect(formatLadderMultiple(0.6)).toBe('0.6×');
    expect(formatLadderMultiple(2.25)).toBe('2.3×');
    expect(formatLadderMultiple(30.4)).toBe('30×');
  });
});

describe('buildRawPriceRows', () => {
  it('marks NM as base and gives lower conditions a negative delta; non-USD rows have no price', () => {
    const rows = buildRawPriceRows([
      row('normal|NM', 42),
      row('normal|LP', 36),
      row('normal|DMG', 12),
      row('normal|HP', 1900, 'JPY'),
    ]);
    expect(rows.map((item) => item.conditionKey)).toEqual(['NM', 'LP', 'DMG', 'HP']);
    expect(rows[0]).toMatchObject({ isBase: true, deltaUsd: null, price: 42 });
    expect(rows[1]).toMatchObject({ isBase: false, deltaUsd: -6 });
    expect(rows[2]).toMatchObject({ deltaUsd: -30 });
    expect(rows[3]).toMatchObject({ price: null, deltaUsd: null });
  });

  it('gives no deltas without a USD baseline', () => {
    const rows = buildRawPriceRows([row('NM', null), row('LP', 5)]);
    expect(rows[1]?.deltaUsd).toBeNull();
  });
});

describe('topGradeQuote', () => {
  it('picks the highest numeric USD-priced grade', () => {
    expect(topGradeQuote([
      row('PSA|9|Holofoil', 88),
      row('PSA|10|Holofoil', 310),
      row('PSA|Authentic|Holofoil', 5000),
      row('PSA|9.5|Holofoil', 1, 'JPY'),
    ])).toEqual({ grade: '10', price: 310 });
    expect(topGradeQuote([row('PSA 10', null)])).toBeNull();
  });
});

describe('hasUsdPrice / rawConditionKey', () => {
  it('reads USD prices and condition codes', () => {
    expect(hasUsdPrice([row('PSA 10', 5, 'JPY')])).toBe(false);
    expect(hasUsdPrice([row('PSA 10', 5)])).toBe(true);
    expect(rawConditionKey('Holofoil|LP')).toBe('LP');
    expect(rawConditionKey('NM')).toBe('NM');
  });
});
