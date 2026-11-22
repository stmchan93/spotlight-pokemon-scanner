import {
  DEFAULT_VENDOR_SETTINGS,
  parseVendorBoughtLog,
  parseVendorSettings,
  type VendorSettings,
} from '@spotlight/api-client';

import {
  buildVendorPurchaseLine,
  captureVendorQuote,
  selectTrayVendorTotals,
} from '@/features/scanner/scan-vendor-offer';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import {
  formatSignedUsd,
  summarizeVendorOffers,
  vendorModeSummary,
  vendorOfferForMarket,
  vendorTierFor,
} from '@/features/vendor/vendor-pricing';

const tiered: VendorSettings = { ...DEFAULT_VENDOR_SETTINGS, tiers: { ...DEFAULT_VENDOR_SETTINGS.tiers } };
const flat: VendorSettings = { ...tiered, buyPercent: 65, tiersEnabled: false };

function capture(id: string, marketPrice: number | null, extra: Partial<RecentCapture> = {}): RecentCapture {
  return {
    id,
    activeCandidateIndex: 0,
    candidates: [{
      id: `${id}-c`,
      cardId: `card-${id}`,
      name: `Card ${id}`,
      cardNumber: '1/100',
      setName: 'Set',
      imageUrl: null,
      marketPrice,
      currencyCode: 'USD',
    }],
    isLoadingCandidates: false,
    isAddingToInventory: false,
    recentlyAdded: false,
    mode: 'raw',
    slabContext: null,
    ...extra,
  } as unknown as RecentCapture;
}

describe('vendor offer math', () => {
  it('uses the plan defaults: bulk <$5 40%, $5-$50 60%, $50+ 70%, slabs 70%, sell 100%', () => {
    expect(DEFAULT_VENDOR_SETTINGS).toEqual({
      buyPercent: 70,
      sellPercent: 100,
      tiersEnabled: true,
      tiers: { bulk: 40, under50: 60, over50: 70, slab: 70 },
      bulkMaxUsd: 5,
    });
    expect(vendorOfferForMarket(4.99, false, tiered, 'buy')).toEqual({ offerUsd: 2, percent: 40, tier: 'bulk' });
    expect(vendorOfferForMarket(5, false, tiered, 'buy')).toEqual({ offerUsd: 3, percent: 60, tier: 'under50' });
    expect(vendorOfferForMarket(50, false, tiered, 'buy')).toEqual({ offerUsd: 35, percent: 70, tier: 'over50' });
    expect(vendorOfferForMarket(1.5, true, tiered, 'buy')).toEqual({ offerUsd: 1.05, percent: 70, tier: 'slab' });
  });

  it('rounds to cents half-up like the backend (287.93 × 70% = 201.55)', () => {
    expect(vendorOfferForMarket(287.93, false, tiered, 'buy')?.offerUsd).toBe(201.55);
    expect(vendorOfferForMarket(0.05, false, tiered, 'buy')?.offerUsd).toBe(0.02);
  });

  it('uses the flat rate with tiers off, and the sell % in sell mode', () => {
    expect(vendorTierFor(500, true, flat)).toBe('flat');
    expect(vendorOfferForMarket(10, true, flat, 'buy')).toEqual({ offerUsd: 6.5, percent: 65, tier: 'flat' });
    expect(vendorOfferForMarket(10, false, { ...tiered, sellPercent: 115 }, 'sell'))
      .toEqual({ offerUsd: 11.5, percent: 115, tier: 'sell' });
  });

  it('has no offer without a market price', () => {
    expect(vendorOfferForMarket(null, false, tiered, 'buy')).toBeNull();
    expect(vendorOfferForMarket(Number.NaN, false, tiered, 'buy')).toBeNull();
  });

  it('totals only priced rows', () => {
    const rows = [10, 60, null].map((market) => ({
      marketUsd: market,
      offer: vendorOfferForMarket(market, false, tiered, 'buy'),
    }));
    expect(summarizeVendorOffers(rows)).toEqual({ marketTotal: 70, offerTotal: 48, pricedCount: 2 });
  });

  it('labels a mode for the confirm sheet', () => {
    expect(vendorModeSummary(tiered, 'buy')).toBe('BUY 40–70%');
    expect(vendorModeSummary(flat, 'buy')).toBe('BUY 65%');
    expect(vendorModeSummary(tiered, 'sell')).toBe('SELL 100%');
    expect(formatSignedUsd(12.4)).toBe('+$12.40');
    expect(formatSignedUsd(-3)).toBe('−$3.00');
  });
});

describe('tray vendor offers', () => {
  it('toggles the tray total between buy and sell', () => {
    const state = {
      items: [capture('a', 60), capture('b', 10), capture('c', null)],
      priceSelections: new Map(),
    } as any;
    expect(selectTrayVendorTotals(state, tiered, 'buy')).toEqual({ marketTotal: 70, offerTotal: 48, pricedCount: 2 });
    expect(selectTrayVendorTotals(state, tiered, 'sell')).toEqual({ marketTotal: 70, offerTotal: 70, pricedCount: 2 });
  });

  it('never quotes a non-USD row', () => {
    const yen = capture('y', 4000);
    (yen.candidates[0] as any).currencyCode = 'JPY';
    expect(captureVendorQuote(yen, null, tiered, 'buy')).toEqual({ marketUsd: null, offer: null });
  });

  it('builds the Bought line the way ADD files the row (raw + slab)', () => {
    expect(buildVendorPurchaseLine(capture('a', 60), null, tiered, 'Holofoil')).toEqual({
      cardId: 'card-a',
      quantity: 1,
      marketUsd: 60,
      offerUsd: 42,
      buyPercent: 70,
      tier: 'over50',
      variantName: 'Holofoil',
      condition: 'near_mint',
      grader: null,
      grade: null,
      certNumber: null,
    });
    const slab = capture('s', 100, {
      mode: 'slabs',
      slabContext: { grader: 'PSA', grade: '10', certNumber: '123', variantName: null } as any,
    });
    expect(buildVendorPurchaseLine(slab, null, tiered, null)).toEqual(expect.objectContaining({
      condition: null,
      grader: 'PSA',
      grade: '10',
      offerUsd: 70,
      tier: 'slab',
    }));
    expect(buildVendorPurchaseLine(capture('n', null), null, tiered, null)).toBeNull();
  });
});

describe('vendor wire parsers', () => {
  it('parses settings with defaults for missing fields', () => {
    expect(parseVendorSettings({ settings: { buyPercent: 55, tiers: { bulk: 30 } } })).toEqual({
      ...DEFAULT_VENDOR_SETTINGS,
      buyPercent: 55,
      tiers: { ...DEFAULT_VENDOR_SETTINGS.tiers, bulk: 30 },
    });
    expect(parseVendorSettings(null)).toBeNull();
  });

  it('drops malformed Bought rows', () => {
    const log = parseVendorBoughtLog({
      entries: [{ cardId: 'x', paidUsd: 5, boughtAt: '2026-11-21T18:00:00Z' }, { paidUsd: 1 }, 'junk'],
      summary: { count: 1, paidUsd: 5 },
    });
    expect(log?.entries).toHaveLength(1);
    expect(log?.summary.paidUsd).toBe(5);
  });
});
