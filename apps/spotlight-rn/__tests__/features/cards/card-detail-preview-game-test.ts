import type {
  CardFavoriteEntry,
  CatalogSearchResult,
  InventoryCardEntry,
} from '@spotlight/api-client';

import {
  cardDetailPreviewFromCatalogResult,
  cardDetailPreviewFromFavorite,
  cardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';

/**
 * The preview is what the card page paints from BEFORE its detail request
 * lands. If it loses the game, the grading lanes render as Pokémon's for a beat
 * and then swap — a visible flicker of controls that don't apply to the card.
 *
 * Every route into the PDP goes through one of these three factories (the
 * scanner reuses the catalog one for its candidates).
 */
describe('card detail preview carries the game', () => {
  it('carries it from a catalog / scan-candidate row', () => {
    const result = {
      id: 'row-1',
      cardId: 'op16-001',
      name: 'Monkey D. Luffy',
      cardNumber: 'OP16-001',
      setName: 'OP16',
      imageUrl: 'https://example.test/luffy.png',
      game: 'onepiece',
    } as CatalogSearchResult;

    expect(cardDetailPreviewFromCatalogResult(result).game).toBe('onepiece');
  });

  it('carries it from a collection entry', () => {
    const entry = {
      id: 'entry-1',
      cardId: 'op16-001',
      name: 'Monkey D. Luffy',
      cardNumber: 'OP16-001',
      setName: 'OP16',
      imageUrl: 'https://example.test/luffy.png',
      marketPrice: 12,
      hasMarketPrice: true,
      currencyCode: 'USD',
      quantity: 1,
      addedAt: '2026-08-13T18:00:00Z',
      kind: 'raw',
      game: 'onepiece',
    } as InventoryCardEntry;

    expect(cardDetailPreviewFromInventoryEntry(entry).game).toBe('onepiece');
  });

  it('carries it from a wishlist entry', () => {
    const favorite = {
      cardId: 'op16-001',
      name: 'Monkey D. Luffy',
      cardNumber: 'OP16-001',
      setName: 'OP16',
      imageUrl: 'https://example.test/luffy.png',
      marketPrice: 12,
      currencyCode: 'USD',
      favoritedAt: '2026-08-13T18:00:00Z',
      isOwned: false,
      game: 'onepiece',
    } as CardFavoriteEntry;

    expect(cardDetailPreviewFromFavorite(favorite).game).toBe('onepiece');
  });

  it('leaves the game undefined when the row has none', () => {
    // Undefined is the honest answer for a pre-multi-game payload; the
    // capability helpers are what turn it into Pokémon.
    const result = {
      id: 'row-1',
      cardId: 'base1-4',
      name: 'Charizard',
      cardNumber: '4/102',
      setName: 'Base',
      imageUrl: 'https://example.test/charizard.png',
    } as CatalogSearchResult;

    expect(cardDetailPreviewFromCatalogResult(result).game).toBeUndefined();
  });
});
