import type { InventoryCardEntry } from '@spotlight/api-client';

import { applyCollectionFilter } from '@/features/portfolio/screens/portfolio-screen';

function entry(over: Partial<InventoryCardEntry>): InventoryCardEntry {
  return {
    id: 'x',
    cardId: 'c',
    name: 'Card',
    cardNumber: '1',
    setName: 'Set',
    imageUrl: '',
    marketPrice: 0,
    hasMarketPrice: false,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
    kind: 'raw',
    ...over,
  } as InventoryCardEntry;
}

describe('applyCollectionFilter', () => {
  it('All sorts by most-recently-added first', () => {
    const items = [
      entry({ id: 'old', addedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'new', addedAt: '2026-03-01T00:00:00.000Z' }),
      entry({ id: 'mid', addedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(applyCollectionFilter(items, 'all').map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('All does not mutate the source array', () => {
    const items = [
      entry({ id: '1', addedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: '2', addedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const before = items.map((e) => e.id);
    applyCollectionFilter(items, 'all');
    expect(items.map((e) => e.id)).toEqual(before);
  });

  it('Favorites keeps only favorites, most-recently-favorited first', () => {
    const items = [
      entry({ id: 'favEarlier', isFavorite: true, favoritedAt: '2026-01-05T00:00:00.000Z', addedAt: '2026-03-01T00:00:00.000Z' }),
      entry({ id: 'notFav', isFavorite: false, addedAt: '2026-04-01T00:00:00.000Z' }),
      entry({ id: 'favLater', isFavorite: true, favoritedAt: '2026-02-10T00:00:00.000Z', addedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const result = applyCollectionFilter(items, 'favorites');
    // favLater was favorited after favEarlier → it comes first; non-favorite excluded.
    expect(result.map((e) => e.id)).toEqual(['favLater', 'favEarlier']);
    expect(result.every((e) => e.isFavorite === true)).toBe(true);
  });

  it('Favorites falls back to addedAt when favoritedAt is missing', () => {
    const items = [
      entry({ id: 'a', isFavorite: true, addedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'b', isFavorite: true, addedAt: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(applyCollectionFilter(items, 'favorites').map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('a rarity chip keeps only entries whose served bucket matches', () => {
    const items = [
      entry({ id: 'sirCard', rarityBucket: 'sir' }),
      entry({ id: 'illusCard', rarityBucket: 'illustration' }),
      entry({ id: 'plainCard', rarityBucket: 'standard' }),
    ];
    expect(applyCollectionFilter(items, 'sir').map((e) => e.id)).toEqual(['sirCard']);
    expect(applyCollectionFilter(items, 'illustration').map((e) => e.id)).toEqual(['illusCard']);
  });

  it('entries missing rarityBucket (old cached payloads) never match a rarity chip', () => {
    const items = [
      entry({ id: 'noBucket' }),
      entry({ id: 'shinyCard', rarityBucket: 'shiny' }),
    ];
    expect(applyCollectionFilter(items, 'shiny').map((e) => e.id)).toEqual(['shinyCard']);
    expect(applyCollectionFilter(items, 'ultra')).toEqual([]);
  });
});
