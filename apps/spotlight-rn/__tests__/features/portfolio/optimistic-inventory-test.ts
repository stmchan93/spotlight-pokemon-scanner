import type { InventoryCardEntry, PortfolioDashboard } from '@spotlight/api-client';

import {
  prependDashboardInventoryEntry,
  prependInventoryEntry,
  reflectInventoryCacheIntoDashboard,
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
