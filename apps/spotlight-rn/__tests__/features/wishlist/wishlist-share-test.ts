import type { CardFavoriteEntry } from '@spotlight/api-client';

import {
  WISHLIST_SHARE_MAX_LINES,
  buildWishlistShareMessage,
} from '@/features/wishlist/wishlist-share';

function entry(overrides: Partial<CardFavoriteEntry> & Pick<CardFavoriteEntry, 'name'>) {
  return {
    cardId: overrides.name,
    cardNumber: '#001/100',
    setName: 'Base Set',
    imageUrl: null,
    smallImageUrl: null,
    largeImageUrl: null,
    marketPrice: 1,
    currencyCode: 'USD',
    favoritedAt: '2026-05-01T00:00:00.000Z',
    isOwned: false,
    ...overrides,
  } as CardFavoriteEntry;
}

describe('buildWishlistShareMessage', () => {
  it('reads as a hunt list someone can scan', () => {
    const message = buildWishlistShareMessage([
      entry({ name: 'Charizard', cardNumber: '#004/102', setName: 'Base Set' }),
      entry({ name: 'Gengar ex', cardNumber: '#088/091', setName: 'Paldean Fates' }),
    ]);

    expect(message).toBe(
      "Cards I'm looking for:\n" +
        'Charizard · #004/102 · Base Set\n' +
        'Gengar ex · #088/091 · Paldean Fates',
    );
  });

  it('says "card" when there is only one', () => {
    const message = buildWishlistShareMessage([entry({ name: 'Charizard' })]);

    expect(message?.startsWith("Card I'm looking for:")).toBe(true);
  });

  it('returns null for an empty list rather than a header with nothing under it', () => {
    // The caller stays silent on this. Opening the OS share sheet with "here is
    // my wishlist" and no cards is worse than the button appearing inert.
    expect(buildWishlistShareMessage([])).toBeNull();
  });

  it('drops cards with no usable text instead of emitting blank lines', () => {
    const message = buildWishlistShareMessage([
      entry({ name: '   ', cardNumber: '  ', setName: '  ' }),
      entry({ name: 'Pidgey' }),
    ]);

    expect(message).toBe("Card I'm looking for:\nPidgey · #001/100 · Base Set");
  });

  it('caps long lists and SAYS it capped them', () => {
    const many = Array.from({ length: WISHLIST_SHARE_MAX_LINES + 7 }, (_, index) =>
      entry({ name: `Card ${index}` }),
    );

    const message = buildWishlistShareMessage(many) ?? '';
    const lines = message.split('\n');

    // Header + the cap + the "and N more" line.
    expect(lines).toHaveLength(WISHLIST_SHARE_MAX_LINES + 2);
    // Truncating silently would read as the whole list — which is the one thing
    // a hunt list must not do, because the reader acts on it.
    expect(message.endsWith('…and 7 more')).toBe(true);
  });

  it('omits missing fields without leaving dangling separators', () => {
    const message = buildWishlistShareMessage([
      entry({ name: 'Promo Pikachu', cardNumber: '', setName: 'SWSH Promo' }),
    ]);

    expect(message).toBe("Card I'm looking for:\nPromo Pikachu · SWSH Promo");
  });
});
