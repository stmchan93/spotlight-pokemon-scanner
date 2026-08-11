import type { CardFavoriteEntry } from '@spotlight/api-client';

import { buildWishlistShareMessage } from '@/features/wishlist/wishlist-share';

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

/**
 * The text that accompanies a shared wishlist — now a single line naming whose
 * list it is, not an enumeration of the cards.
 *
 * WHY THE CARD LIST WENT AWAY. It duplicated what the accompanying link already
 * showed, and it pushed the link so far down the bubble that it was easy to
 * miss even when it rendered. When the sender's id is known the share now
 * travels as a reference and the recipient gets a preview card (social_24);
 * this text is the fallback for an identity-less session, and the form that
 * still works against a project behind on that migration.
 */
describe('buildWishlistShareMessage', () => {
  const cards = [
    entry({ name: 'Charizard', cardNumber: '#004/102', setName: 'Base Set' }),
    entry({ name: 'Gengar ex', cardNumber: '#088/091', setName: 'Paldean Fates' }),
  ];

  it('names whose wishlist it is, and nothing else', () => {
    expect(buildWishlistShareMessage(cards, { displayName: 'Ash Ketchum' })).toBe(
      "Check out Ash Ketchum's wishlist",
    );
  });

  it('does not enumerate the cards — the link is the payload', () => {
    const message = buildWishlistShareMessage(cards, { displayName: 'Ash Ketchum' }) ?? '';
    expect(message).not.toContain('Charizard');
    expect(message).not.toContain('Gengar ex');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('falls back to the handle when there is no display name', () => {
    expect(buildWishlistShareMessage(cards, { handle: 'ash' })).toBe("Check out @ash's wishlist");
    expect(buildWishlistShareMessage(cards, { handle: '@ash' })).toBe("Check out @ash's wishlist");
  });

  it('still sends something when there is no identity at all', () => {
    // Unlike a profile share, a nameless wishlist is still worth sending: the
    // link resolves and names its owner on arrival.
    expect(buildWishlistShareMessage(cards)).toBe('Check out this wishlist');
  });

  /*
    The empty guard survives the rewrite for the same reason it existed: an
    invitation pointing at an empty page is worse than a button that appears to
    do nothing.
  */
  it('returns null for an empty list', () => {
    expect(buildWishlistShareMessage([], { displayName: 'Ash Ketchum' })).toBeNull();
  });

  it('returns null when every entry is blank, not just when the array is', () => {
    const blank = [entry({ name: '   ', cardNumber: '  ', setName: '' })];
    expect(buildWishlistShareMessage(blank, { displayName: 'Ash Ketchum' })).toBeNull();
  });
});
