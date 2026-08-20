import type { InventoryCardEntry } from '@spotlight/api-client';

import {
  gameFilterKey,
  gameFromFilterKey,
} from '@/features/portfolio/components/collection-filter-chip-row';
import { applyCollectionFilter, collectionGames } from '@/features/portfolio/screens/portfolio-screen';

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

/**
 * A mixed collection needs a way to see one game at a time. A Pokémon-only
 * collection — which is almost all of them — must not pay for that with an
 * extra chip, so the row is driven by what the user actually owns.
 */
describe('collection game filter', () => {
  it('reports the games present, in a stable order', () => {
    const items = [
      entry({ id: 'a', game: 'onepiece' }),
      entry({ id: 'b', game: 'pokemon' }),
      entry({ id: 'c', game: 'onepiece' }),
    ];
    // CARD_GAMES order, not first-seen order, so the chips don't reshuffle as
    // cards are added.
    expect(collectionGames(items)).toEqual(['pokemon', 'onepiece']);
  });

  it('counts an entry with no game as Pokémon, so an old collection stays single-game', () => {
    // Entries cached before multi-game carry no `game`. Bucketing those
    // separately would show a two-chip row to someone who owns only Pokémon.
    const items = [entry({ id: 'a' }), entry({ id: 'b', game: 'pokemon' })];
    expect(collectionGames(items)).toEqual(['pokemon']);
  });

  it('filters the collection down to one game', () => {
    const items = [
      entry({ id: 'luffy', game: 'onepiece' }),
      entry({ id: 'pikachu', game: 'pokemon' }),
      entry({ id: 'legacy' }),
    ];

    expect(applyCollectionFilter(items, gameFilterKey('onepiece')).map((e) => e.id)).toEqual([
      'luffy',
    ]);
    // The undefined-game entry lands in Pokémon, matching collectionGames.
    expect(applyCollectionFilter(items, gameFilterKey('pokemon')).map((e) => e.id)).toEqual([
      'pikachu',
      'legacy',
    ]);
  });

  it('reads a game back out of its filter key, and ignores keys that are not games', () => {
    expect(gameFromFilterKey(gameFilterKey('lorcana'))).toBe('lorcana');
    expect(gameFromFilterKey('favorites')).toBeNull();
    // Namespaced so a rarity bucket can never be mistaken for a game.
    expect(gameFromFilterKey('shiny')).toBeNull();
  });

  it('leaves the list alone for a game key this build does not know', () => {
    // A persisted filter from a newer build must not silently empty the
    // collection; it falls through to the default (return everything) branch.
    const items = [entry({ id: 'a', game: 'pokemon' })];
    expect(applyCollectionFilter(items, 'game:magic' as never).map((e) => e.id)).toEqual(['a']);
  });
});
