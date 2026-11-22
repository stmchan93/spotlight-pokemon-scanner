import type { CatalogSearchResult, RawPricingMatrixVariant } from '@spotlight/api-client';

import { applyScanRowGradingPick } from '@/features/scanner/scan-row-grading';
import { resolveCaptureTrayPrice } from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import { loadTrayVariantMatrices } from '@/features/scanner/tray-variant-loader';

/**
 * Base Set Charizard base1-4 (2026-11-21): the matrix listed an NM-only
 * "Holofoil" ahead of "Unlimited Holofoil"'s full ladder. Picking LP looked
 * LP up on the NM-only printing, got nothing, and the row kept the NM price
 * under an LP label.
 */

const condition = (code: string, market: number | null) => ({
  code, label: code, market, low: null, mid: null, high: null,
});

const charizard: RawPricingMatrixVariant[] = [
  { variant: 'Holofoil', variantKey: 'holofoil', conditions: [condition('NM', 1001.05)] },
  {
    variant: 'Unlimited Holofoil',
    variantKey: 'unlimitedHolofoil',
    conditions: [
      condition('NM', 1001.05), condition('LP', 523.87), condition('MP', 358.99),
      condition('HP', 266.83), condition('DM', 203.34),
    ],
  },
  { variant: 'Metal', variantKey: 'metal', conditions: [condition('NM', 290.27), condition('LP', 218.75)] },
];

const rawCapture = { mode: 'raw' as const, slabContext: null };

const candidate = {
  id: 'base1-4',
  cardId: 'base1-4',
  name: 'Charizard',
  cardNumber: '4/102',
  setName: 'Base',
  imageUrl: '',
  currencyCode: 'USD',
  marketPrice: 1001.05,
} satisfies CatalogSearchResult;

const trayCapture = {
  activeCandidateIndex: 0,
  candidates: [candidate],
  mode: 'raw',
  slabContext: null,
} as unknown as RecentCapture;

describe('tray condition pick on a card with an NM-only first printing', () => {
  it('picking LP moves to the best printing that prices LP', () => {
    const lp = applyScanRowGradingPick(rawCapture, null, charizard, 'detail', 'LP');
    expect(lp).toEqual(expect.objectContaining({
      variantKey: 'unlimitedHolofoil',
      variantLabel: 'Unlimited Holofoil',
      conditionCode: 'lightly_played',
      marketPrice: 523.87,
    }));
    expect(resolveCaptureTrayPrice(trayCapture, lp).amount).toBe(523.87);
    // Back to NM stays on the printing the row now names.
    const nm = applyScanRowGradingPick(rawCapture, lp, charizard, 'detail', 'NM');
    expect(nm).toEqual(expect.objectContaining({ variantKey: 'unlimitedHolofoil', marketPrice: 1001.05 }));
  });

  it('keeps the row\'s own printing when it prices the condition', () => {
    const onMetal = applyScanRowGradingPick(
      rawCapture,
      { variantKey: 'metal', variantLabel: 'Metal', conditionCode: 'near_mint', conditionShortLabel: 'NM', marketPrice: 290.27 },
      charizard,
      'detail',
      'LP',
    );
    expect(onMetal).toEqual(expect.objectContaining({ variantKey: 'metal', marketPrice: 218.75 }));
  });

  it('no printing has the condition: the row shows "—", never the NM price', () => {
    const nmOnly = [charizard[0]];
    const hp = applyScanRowGradingPick(rawCapture, null, nmOnly, 'detail', 'HP');
    expect(hp).toEqual(expect.objectContaining({ variantKey: 'holofoil', conditionCode: 'heavily_played', marketPrice: null }));
    expect(resolveCaptureTrayPrice(trayCapture, hp).amount).toBeNull();
    // No matrix yet either.
    const noMatrix = applyScanRowGradingPick(rawCapture, null, [], 'detail', 'LP');
    expect(resolveCaptureTrayPrice(trayCapture, noMatrix).amount).toBeNull();
    // An untouched / NM row still falls back to the candidate's price.
    expect(resolveCaptureTrayPrice(trayCapture, null).amount).toBe(1001.05);
    expect(resolveCaptureTrayPrice(trayCapture, { marketPrice: null, conditionCode: 'near_mint' }).amount)
      .toBe(1001.05);
  });
});

describe('tray pricing-matrix loader', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  it('a re-run mid-fetch does not strand the card with no printings', async () => {
    const cache = new Map<string, RawPricingMatrixVariant[]>();
    const loaded: string[] = [];
    const first = deferred<{ variants: RawPricingMatrixVariant[] }>();
    const fetchMatrix = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ variants: charizard });

    const cancel = loadTrayVariantMatrices(['base1-4'], cache, fetchMatrix, (id) => loaded.push(id));
    expect(cache.get('base1-4')).toEqual([]);
    // A new card lands in the tray: the effect cleans up and re-runs.
    cancel();
    expect(cache.has('base1-4')).toBe(false);
    loadTrayVariantMatrices(['base1-4', 'base4-4'], cache, fetchMatrix, (id) => loaded.push(id));
    first.resolve({ variants: charizard });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMatrix).toHaveBeenCalledTimes(3);
    expect(cache.get('base1-4')).toBe(charizard);
    expect(loaded.sort()).toEqual(['base1-4', 'base4-4']);
  });

  it('a stale cancelled read never overwrites or clears the newer run', async () => {
    const cache = new Map<string, RawPricingMatrixVariant[]>();
    const first = deferred<{ variants: RawPricingMatrixVariant[] }>();
    const fetchMatrix = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ variants: charizard });
    const cancel = loadTrayVariantMatrices(['base1-4'], cache, fetchMatrix, () => {});
    cancel();
    loadTrayVariantMatrices(['base1-4'], cache, fetchMatrix, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    first.resolve({ variants: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cache.get('base1-4')).toBe(charizard);
  });

  it('a loaded card is not refetched and a failed read can retry', async () => {
    const cache = new Map<string, RawPricingMatrixVariant[]>([['base1-4', charizard]]);
    const fetchMatrix = jest.fn().mockRejectedValue(new Error('offline'));
    loadTrayVariantMatrices(['base1-4', 'base4-4'], cache, fetchMatrix, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMatrix).toHaveBeenCalledTimes(1);
    expect(cache.has('base4-4')).toBe(false);
  });
});
