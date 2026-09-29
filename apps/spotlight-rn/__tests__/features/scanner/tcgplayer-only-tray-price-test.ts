import type { CatalogSearchResult } from '@spotlight/api-client';

import {
  buildOptimisticInventoryEntry,
  resolveCaptureTrayPrice,
  summarizeTrayPrices,
} from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';

/**
 * A TCGplayer-only card has no graded price. A SLAB scan of one must show "—"
 * (and stay out of the tray total) rather than the raw price the candidate
 * carries; a raw scan prices normally.
 */

const tcgplayerOnly = {
  id: 'tcgplayer-600001',
  cardId: 'tcgplayer-600001',
  name: 'Pikachu (Staff Prerelease)',
  cardNumber: '',
  setName: 'Prerelease Promos',
  imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/600001_in_1000x1000.jpg',
  currencyCode: 'USD',
  marketPrice: 42,
  catalogSource: 'tcgplayer',
} satisfies CatalogSearchResult;

function capture(mode: RecentCapture['mode']): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [tcgplayerOnly],
    mode,
    slabContext: mode === 'slabs' ? { grader: 'PSA', grade: '10', certNumber: null, variantName: null } : null,
  } as unknown as RecentCapture;
}

describe('tray price for a TCGplayer-only card', () => {
  it('shows "—" for a slab scan and leaves it out of the total', () => {
    const slabPrice = resolveCaptureTrayPrice(capture('slabs'), { marketPrice: 42 });
    expect(slabPrice.amount).toBeNull();

    const rawPrice = resolveCaptureTrayPrice(capture('raw'), null);
    expect(rawPrice.amount).toBe(42);

    expect(summarizeTrayPrices([slabPrice, rawPrice]).total).toBe(42);
  });

  it('adds a slab of it to the collection unpriced, and a raw copy priced', () => {
    const slab = buildOptimisticInventoryEntry(
      tcgplayerOnly,
      '2026-09-28T18:00:00Z',
      { mode: 'slabs', slabContext: { grader: 'PSA', grade: '10', certNumber: null, variantName: null } },
      'entry-slab',
    );
    expect(slab.hasMarketPrice).toBe(false);
    expect(slab.marketPrice).toBe(0);

    const raw = buildOptimisticInventoryEntry(
      tcgplayerOnly,
      '2026-09-28T18:00:00Z',
      { mode: 'raw', slabContext: null },
      'entry-raw',
    );
    expect(raw.hasMarketPrice).toBe(true);
    expect(raw.marketPrice).toBe(42);
  });
});
