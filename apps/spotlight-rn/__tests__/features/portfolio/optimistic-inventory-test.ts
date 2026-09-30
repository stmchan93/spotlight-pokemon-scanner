import type { InventoryCardEntry, PortfolioDashboard } from '@spotlight/api-client';

import {
  prependDashboardInventoryEntry,
  prependInventoryEntry,
  reflectInventoryCacheIntoDashboard,
  removeDashboardInventoryEntries,
  shiftDashboardLatestValue,
} from '@/features/portfolio/optimistic-inventory';

function entry(overrides: Partial<InventoryCardEntry> & Pick<InventoryCardEntry, 'id'>): InventoryCardEntry {
  return {
    cardId: `card-${overrides.id}`,
    name: `Card ${overrides.id}`,
    cardNumber: '#001',
    setName: 'Set',
    imageUrl: 'https://example.com/card.png',
    marketPrice: 10,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-06-01T00:00:00.000Z',
    kind: 'raw',
    ...overrides,
  };
}

function dashboard(items: InventoryCardEntry[], currentValue = 0): PortfolioDashboard {
  return {
    summary: { currentValue, changeAmount: 0, changePercent: 0, asOfLabel: 'Today' },
    inventoryCount: items.length,
    inventoryItems: items,
    recentSales: [],
    ranges: {
      '1W': { portfolio: [], sales: [] },
      '1M': { portfolio: [], sales: [] },
      '3M': { portfolio: [], sales: [] },
      YTD: { portfolio: [], sales: [] },
      '1Y': { portfolio: [], sales: [] },
      ALL: { portfolio: [], sales: [] },
    },
  };
}

describe('prependInventoryEntry', () => {
  it('prepends a brand-new entry to the front', () => {
    const result = prependInventoryEntry([entry({ id: 'a' })], entry({ id: 'b' }));
    expect(result.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('replaces an existing entry in place (dedupe by id)', () => {
    const result = prependInventoryEntry(
      [entry({ id: 'a' }), entry({ id: 'b', quantity: 1 })],
      entry({ id: 'b', quantity: 4 }),
    );
    expect(result.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.find((e) => e.id === 'b')?.quantity).toBe(4);
  });
});

describe('prependDashboardInventoryEntry', () => {
  it('prepends and bumps count + value for a new entry', () => {
    const next = prependDashboardInventoryEntry(
      dashboard([entry({ id: 'a', marketPrice: 5, quantity: 1 })], 5),
      entry({ id: 'b', marketPrice: 25, quantity: 2 }),
    );
    expect(next.inventoryItems.map((e) => e.id)).toEqual(['b', 'a']);
    expect(next.inventoryCount).toBe(2);
    expect(next.summary.currentValue).toBe(55); // 5 + 25*2
  });

  it('does not double-count when the id already exists', () => {
    const next = prependDashboardInventoryEntry(
      dashboard([entry({ id: 'b', marketPrice: 25, quantity: 1 })], 25),
      entry({ id: 'b', marketPrice: 25, quantity: 1 }),
    );
    expect(next.inventoryCount).toBe(1);
    expect(next.summary.currentValue).toBe(25);
  });

  it('ignores value for entries without a market price', () => {
    const next = prependDashboardInventoryEntry(
      dashboard([], 0),
      entry({ id: 'b', hasMarketPrice: false, marketPrice: 0 }),
    );
    expect(next.summary.currentValue).toBe(0);
    expect(next.inventoryCount).toBe(1);
  });
});

describe('reflectInventoryCacheIntoDashboard', () => {
  it('returns the SAME reference when the cache introduces no new ids', () => {
    const base = dashboard([entry({ id: 'a' }), entry({ id: 'b' })], 20);
    const result = reflectInventoryCacheIntoDashboard(base, [entry({ id: 'a' }), entry({ id: 'b' })]);
    expect(result).toBe(base);
  });

  it('prepends cache-only entries and bumps the totals', () => {
    const base = dashboard([entry({ id: 'a' })], 10);
    const result = reflectInventoryCacheIntoDashboard(base, [
      entry({ id: 'new', marketPrice: 30, quantity: 1 }),
      entry({ id: 'a' }),
    ]);
    expect(result).not.toBe(base);
    expect(result.inventoryItems.map((e) => e.id)).toEqual(['new', 'a']);
    expect(result.inventoryCount).toBe(2);
    expect(result.summary.currentValue).toBe(40);
  });

  it('drops dashboard entries missing from the cache (optimistic delete)', () => {
    const base = dashboard([
      entry({ id: 'a', marketPrice: 10, quantity: 1 }),
      entry({ id: 'gone', marketPrice: 25, quantity: 1 }),
    ], 35);
    const result = reflectInventoryCacheIntoDashboard(base, [entry({ id: 'a' })]);
    expect(result.inventoryItems.map((e) => e.id)).toEqual(['a']);
    expect(result.inventoryCount).toBe(1);
    expect(result.summary.currentValue).toBe(10);
  });

  it('replaces same-id entries whose display data changed (optimistic edit)', () => {
    const base = dashboard([entry({ id: 'a', quantity: 1, marketPrice: 10, variantName: 'Normal' })], 10);
    const result = reflectInventoryCacheIntoDashboard(base, [
      entry({ id: 'a', quantity: 2, marketPrice: 10, variantName: 'Holofoil' }),
    ]);
    expect(result).not.toBe(base);
    expect(result.inventoryItems[0]?.variantName).toBe('Holofoil');
    expect(result.inventoryItems[0]?.quantity).toBe(2);
    // Value delta: 1×10 → 2×10.
    expect(result.summary.currentValue).toBe(20);
    expect(result.inventoryCount).toBe(1);
  });

  it('handles an identity-changing edit (old id dropped, new id prepended)', () => {
    const base = dashboard([entry({ id: 'old', marketPrice: 10, quantity: 1 })], 10);
    const result = reflectInventoryCacheIntoDashboard(base, [
      entry({ id: 'new-id', marketPrice: 12, quantity: 1 }),
    ]);
    expect(result.inventoryItems.map((e) => e.id)).toEqual(['new-id']);
    expect(result.inventoryCount).toBe(1);
    expect(result.summary.currentValue).toBe(12);
  });
});

// Staging, 2026-09-29: deleting a sealed box dropped the balance but the chart's
// last dot (and its scrub tooltip) still counted the box.
describe('optimistic mutations move the chart latest point with the headline', () => {
  function charted(items: InventoryCardEntry[], values: number[]): PortfolioDashboard {
    const base = dashboard(items, values[values.length - 1]);
    const portfolio = values.map((value, index) => ({
      isoDate: `2026-09-2${index + 3}`,
      shortLabel: `${index}`,
      value,
    }));
    const summary = {
      currentValue: values[values.length - 1],
      startValue: values[0],
      changeAmount: values[values.length - 1] - values[0],
      changePercent: null,
    };
    return {
      ...base,
      summary: { ...base.summary, changeAmount: summary.changeAmount },
      ranges: { ...base.ranges, '1W': { portfolio, sales: [], summary }, '1M': { portfolio, sales: [], summary } },
    };
  }

  const box = entry({ id: 'box', cardId: 'tcgp-sealed-709029', marketPrice: 2300, quantity: 1 });
  const card = entry({ id: 'card', marketPrice: 100, quantity: 1 });

  it('delete: headline, last point and range summary all drop by the removed value', () => {
    const next = removeDashboardInventoryEntries(charted([box, card], [100, 2400, 2400]), ['box']);
    expect(next.summary.currentValue).toBe(100);
    for (const range of ['1W', '1M'] as const) {
      const points = next.ranges[range].portfolio;
      expect(points[points.length - 1].value).toBe(100);
      // History before today is untouched.
      expect(points.slice(0, -1).map((point) => point.value)).toEqual([100, 2400]);
      expect(next.ranges[range].summary?.currentValue).toBe(100);
      expect(next.ranges[range].summary?.changeAmount).toBe(0);
    }
    expect(next.summary.changeAmount).toBe(0);
  });

  it('delete via the inventory cache (the Collection screen path) moves the last point too', () => {
    const next = reflectInventoryCacheIntoDashboard(charted([box, card], [100, 2400]), [card]);
    const points = next.ranges['1W'].portfolio;
    expect(next.summary.currentValue).toBe(100);
    expect(points[points.length - 1].value).toBe(100);
  });

  it('add and quantity edits move the last point by the same amount as the headline', () => {
    const added = prependDashboardInventoryEntry(charted([card], [100, 100]), box);
    expect(added.ranges['1W'].portfolio[1].value).toBe(2400);
    expect(added.summary.currentValue).toBe(2400);

    const edited = reflectInventoryCacheIntoDashboard(added, [{ ...box, quantity: 2 }, card]);
    expect(edited.ranges['1W'].portfolio[1].value).toBe(4700);
    expect(edited.summary.currentValue).toBe(4700);
  });

  it('leaves empty ranges alone and never goes negative', () => {
    const next = shiftDashboardLatestValue(charted([card], [100, 100]), -500);
    expect(next.ranges['1W'].portfolio[1].value).toBe(0);
    expect(next.ranges['3M'].portfolio).toEqual([]);
    expect(next.summary.currentValue).toBe(0);
  });
});
