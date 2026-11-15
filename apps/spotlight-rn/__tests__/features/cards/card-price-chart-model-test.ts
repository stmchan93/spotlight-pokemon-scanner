import type { CardConditionHistory, CardRecentSalesRecord } from '@spotlight/api-client';

import {
  buildPriceChartModel,
  chartWindow,
  conditionMatchKey,
  formatChartDate,
  historySeriesPoints,
  parseCalendarDayMs,
  priceChartReadout,
  resolveDefaultRowKey,
  rowIdentity,
  salesPoints,
  selectHistorySeries,
  variantMatchKey,
  type ChartPoint,
} from '@/features/cards/card-price-chart-model';

const DAY = 86_400_000;
const now = new Date(2026, 9, 31, 15).getTime();
const daysAgo = (days: number) => new Date(2026, 9, 31 - days, 12).getTime();
const isoDay = (days: number) => {
  const date = new Date(daysAgo(days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function series(key: string, variantKey: string | null, condition: string | null, values: (number | null)[]) {
  return {
    key,
    label: key,
    variantKey,
    condition,
    grader: null,
    grade: null,
    points: values.map((market, index) => ({
      date: isoDay(values.length - 1 - index),
      market,
      low: null,
      mid: null,
      high: null,
    })),
  };
}

describe('matching keys', () => {
  it('reduces printing labels and stored variant keys to one key', () => {
    expect(variantMatchKey('Reverse Holofoil')).toBe(variantMatchKey('reverseHolofoil'));
    expect(variantMatchKey('1st Edition Holofoil')).toBe(variantMatchKey('firstEditionHolofoil'));
    expect(variantMatchKey('Normal')).toBe('');
    expect(variantMatchKey(null)).toBe('');
  });

  it('reduces condition codes, short labels and labels to the short label', () => {
    expect(conditionMatchKey('near_mint')).toBe('NM');
    expect(conditionMatchKey('NM')).toBe('NM');
    expect(conditionMatchKey('Lightly Played')).toBe('LP');
  });
});

describe('rowIdentity', () => {
  it('parses raw keys in both shapes', () => {
    expect(rowIdentity('raw', 'NM', null)).toEqual({ mode: 'raw', condition: 'NM' });
    expect(rowIdentity('raw', 'holofoil|LP', null)).toEqual({ mode: 'raw', condition: 'LP' });
  });

  it('parses graded keys, falling back to the page printing when the key has none', () => {
    expect(rowIdentity('graded', 'PSA|10|holofoil', 'Normal')).toEqual({
      mode: 'graded', grader: 'PSA', grade: '10', variantName: 'holofoil',
    });
    expect(rowIdentity('graded', 'PSA 9', 'Normal')).toEqual({
      mode: 'graded', grader: 'PSA', grade: '9', variantName: 'Normal',
    });
  });
});

describe('selectHistorySeries', () => {
  const history: CardConditionHistory = {
    cardId: 'c',
    lane: 'raw',
    currencyCode: 'USD',
    series: [
      series('normal|NM', 'normal', 'NM', [1, 2]),
      series('reverseHolofoil|NM', 'reverseHolofoil', 'NM', [5, 6]),
      series('reverseHolofoil|LP', 'reverseHolofoil', 'LP', [3, 4]),
    ],
  };

  it('matches condition AND the selected printing', () => {
    expect(selectHistorySeries(history, { mode: 'raw', condition: 'NM' }, 'Reverse Holofoil')?.key)
      .toBe('reverseHolofoil|NM');
    expect(selectHistorySeries(history, { mode: 'raw', condition: 'NM' }, 'Normal')?.key).toBe('normal|NM');
  });

  it('uses the only printing when its key spelling differs', () => {
    const single: CardConditionHistory = { ...history, series: [series('holo|NM', 'holo', 'NM', [1])] };
    expect(selectHistorySeries(single, { mode: 'raw', condition: 'NM' }, 'Holofoil')?.key).toBe('holo|NM');
  });

  it("never shows another printing's series for a condition only it has", () => {
    expect(selectHistorySeries(history, { mode: 'raw', condition: 'LP' }, 'Normal')).toBeNull();
  });

  it('refuses to guess between several printings', () => {
    expect(selectHistorySeries(history, { mode: 'raw', condition: 'NM' }, 'Holofoil')).toBeNull();
  });

  it('falls back to a variant-less graded series', () => {
    const graded: CardConditionHistory = {
      cardId: 'c',
      lane: 'graded',
      currencyCode: 'USD',
      series: [
        { ...series('PSA|10|', null, null, [100]), grader: 'PSA', grade: '10' },
        { ...series('PSA|10|holofoil', 'holofoil', null, [200]), grader: 'PSA', grade: '10' },
        { ...series('PSA|9|', null, null, [50]), grader: 'PSA', grade: '9' },
      ],
    };
    const pick = (variantName: string | null) => selectHistorySeries(
      graded,
      { mode: 'graded', grader: 'PSA', grade: '10', variantName },
      variantName,
    )?.key;
    expect(pick('Holofoil')).toBe('PSA|10|holofoil');
    expect(pick('Reverse Holofoil')).toBe('PSA|10|');
  });
});

describe('points', () => {
  it('drops null market values and sorts by day', () => {
    const points = historySeriesPoints(series('k', null, 'NM', [1, null, 3]));
    expect(points.map((point) => point.v)).toEqual([1, 3]);
  });

  it('keeps only dated, priced USD sales, oldest first', () => {
    const record: CardRecentSalesRecord = {
      source: 'ebay',
      status: 'available',
      canRefresh: false,
      saleCount: 4,
      sales: [
        { id: 'a', title: 'a', soldAt: '2026-10-20T10:00:00Z', priceAmount: 120, currencyCode: 'USD' },
        { id: 'b', title: 'b', soldAt: '2026/10/01', priceAmount: 100, currencyCode: 'USD' },
        { id: 'c', title: 'c', soldAt: '2026-10-05', priceAmount: 90, currencyCode: 'AUD' },
        { id: 'd', title: 'd', soldAt: null, priceAmount: 80, currencyCode: 'USD' },
        { id: 'e', title: 'e', soldAt: '2026-10-06', priceAmount: null, currencyCode: 'USD' },
      ],
    };
    expect(salesPoints(record).map((point) => point.v)).toEqual([100, 120]);
    expect(salesPoints({ ...record, status: 'unavailable' })).toEqual([]);
  });

  it('parses date-only and timestamped values to the same calendar day', () => {
    expect(parseCalendarDayMs('2026-10-12')).toBe(parseCalendarDayMs('2026-10-12T23:00:00Z'));
    expect(parseCalendarDayMs('nope')).toBeNull();
  });
});

describe('chartWindow', () => {
  it('slices to the range and keeps today even before noon', () => {
    const points: ChartPoint[] = [40, 20, 6, 0].map((days) => ({ t: daysAgo(days), v: days }));
    const morning = new Date(2026, 9, 31, 8).getTime();
    const sliced = chartWindow(points, '1M', morning);
    expect(sliced.points.map((point) => point.v)).toEqual([20, 6, 0]);
    expect(sliced.endMs - sliced.startMs).toBe(30 * DAY);
    expect(chartWindow(points, '1W', morning).points.map((point) => point.v)).toEqual([6, 0]);
  });
});

describe('buildPriceChartModel', () => {
  const line = (values: number[]) => values.map((v, index) => ({ t: daysAgo(values.length - 1 - index), v }));

  it('themes up by last vs first and labels the delta', () => {
    const model = buildPriceChartModel({
      allPoints: line([100, 90, 150]), variant: 'line', range: '1M', nowMs: now, currencyCode: 'USD',
    })!;
    expect(model.tone).toBe('up');
    expect(model.restValue).toBe(150);
    expect(model.restDelta).toEqual({ label: '$50.00 (50.00%)', direction: 'up' });
    expect(model.restSuffix).toBe('Past month');
    expect(model.asOfText).toBe(`Prices as of ${formatChartDate(daysAgo(0), now)} · TCGplayer market`);
  });

  it('never charts yen', () => {
    expect(buildPriceChartModel({
      allPoints: line([6000, 7000]), variant: 'line', range: '1M', nowMs: now, currencyCode: 'JPY',
    })).toBeNull();
  });

  it('a line that stopped updating reads "No recent prices" on every range, 1Y included', () => {
    // Apr..Jul points, nothing since: the staging Lightly Played case.
    const stale = [{ t: daysAgo(200), v: 40 }, { t: daysAgo(150), v: 44 }, { t: daysAgo(105), v: 42 }];
    for (const range of ['1W', '1M', '3M', '1Y'] as const) {
      const model = buildPriceChartModel({ allPoints: stale, variant: 'line', range, nowMs: now, currencyCode: 'USD' })!;
      expect(model.insufficient).toBe(true);
      expect(model.points).toEqual([]);
      expect(model.emptyMessage).toBe('No recent prices for this condition.');
      expect(model.restSuffix).toBe(`Last updated ${formatChartDate(daysAgo(105), now)}`);
    }
  });

  it('themes down', () => {
    const model = buildPriceChartModel({
      allPoints: line([200, 150]), variant: 'line', range: '1W', nowMs: now, currencyCode: 'USD',
    })!;
    expect(model.tone).toBe('down');
    expect(model.restDelta?.label).toBe('$50.00 (25.00%)');
  });

  it('counts sales in the suffix', () => {
    const model = buildPriceChartModel({
      allPoints: line([100, 110, 120, 130]), variant: 'sales', range: '1M', nowMs: now, currencyCode: 'USD',
    })!;
    expect(model.restSuffix).toBe('Past month · 4 sales');
    expect(model.asOfText).toMatch(/^Last sale .* · eBay · each dot is one sale$/);
  });

  it('goes grey with fewer than 3 graded sales and shows the latest sale ever', () => {
    const points = [{ t: daysAgo(200), v: 500 }, { t: daysAgo(10), v: 400 }, { t: daysAgo(3), v: 450 }];
    const model = buildPriceChartModel({
      allPoints: points, variant: 'sales', range: '1M', nowMs: now, currencyCode: 'USD',
    })!;
    expect(model.tone).toBe('neutral');
    expect(model.insufficient).toBe(true);
    expect(model.emptyMessage).toBe('2 sales in this range. Not enough to call a trend.');
    expect(model.restValue).toBe(450);
    expect(model.restDelta).toBeNull();
    expect(model.restSuffix).toBe(`Last sold ${formatChartDate(daysAgo(3), now)} · try a longer range`);

    const empty = buildPriceChartModel({
      allPoints: [{ t: daysAgo(300), v: 500 }], variant: 'sales', range: '1Y', nowMs: now, currencyCode: 'USD',
    })!;
    expect(empty.emptyMessage).toBe('1 sale in this range. Not enough to call a trend.');
    expect(empty.restSuffix).not.toContain('longer range');
  });

  it('returns null without any data', () => {
    expect(buildPriceChartModel({
      allPoints: [], variant: 'line', range: '1M', nowMs: now, currencyCode: 'USD',
    })).toBeNull();
  });
});

describe('priceChartReadout', () => {
  const model = buildPriceChartModel({
    allPoints: [{ t: daysAgo(9), v: 100 }, { t: daysAgo(5), v: 80 }, { t: daysAgo(1), v: 120 }],
    variant: 'sales',
    range: '1M',
    nowMs: now,
    currencyCode: 'USD',
  })!;

  it('rests on the summary', () => {
    expect(priceChartReadout(model, null, now)).toEqual({
      value: 120,
      delta: { label: '$20.00 (20.00%)', direction: 'up' },
      suffix: 'Past month · 3 sales',
    });
  });

  it('reads the scrubbed point against the window start', () => {
    expect(priceChartReadout(model, 1, now)).toEqual({
      value: 80,
      delta: { label: '$20.00 (20.00%)', direction: 'down' },
      suffix: `Sold ${formatChartDate(daysAgo(5), now)}`,
    });
  });
});

describe('formatChartDate', () => {
  it('adds the year only outside the current year', () => {
    expect(formatChartDate(new Date(2026, 9, 12).getTime(), now)).toBe('Oct 12');
    expect(formatChartDate(new Date(2024, 9, 12).getTime(), now)).toBe('Oct 12, 2024');
  });
});

describe('resolveDefaultRowKey', () => {
  const row = (key: string) => ({ key, label: key, currentPrice: 1, currencyCode: 'USD', points: [] });

  it('prefers the owned condition, then NM, then the first row', () => {
    const rows = [row('holofoil|LP'), row('holofoil|NM'), row('holofoil|MP')];
    expect(resolveDefaultRowKey(rows, 'raw', { condition: 'moderately_played' })).toBe('holofoil|MP');
    expect(resolveDefaultRowKey(rows, 'raw', { condition: null })).toBe('holofoil|NM');
    expect(resolveDefaultRowKey([row('LP')], 'raw', { condition: 'damaged' })).toBe('LP');
  });

  it('prefers the seeded grade, else the top row', () => {
    const rows = [row('PSA|10|holofoil'), row('PSA|9|holofoil')];
    expect(resolveDefaultRowKey(rows, 'graded', { grade: '9' })).toBe('PSA|9|holofoil');
    expect(resolveDefaultRowKey(rows, 'graded', { grade: '7' })).toBe('PSA|10|holofoil');
    expect(resolveDefaultRowKey([], 'graded', {})).toBeNull();
  });
});
