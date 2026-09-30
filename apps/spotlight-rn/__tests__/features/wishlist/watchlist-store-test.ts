import type { CardFavoriteEntry } from '@spotlight/api-client';

import { createWatchlistStore } from '@/features/wishlist/watchlist-store';

function entry(cardId: string, watchVariant: string | null = null): CardFavoriteEntry {
  return {
    cardId,
    watchVariant,
    watchKey: `${cardId}|${watchVariant ?? ''}`,
    name: cardId,
    cardNumber: '1',
    setName: 'Set',
    imageUrl: '',
    marketPrice: 5,
    currencyCode: 'USD',
    favoritedAt: '2026-09-01T00:00:00.000Z',
    isOwned: false,
  };
}

const basics = (cardId: string) => ({ cardId, name: `Name ${cardId}`, marketPrice: 12 });

describe('watchlist store', () => {
  it('prepends a placeholder row on add, with no price history yet', () => {
    const store = createWatchlistStore();
    store.commitRead(store.beginRead(), [entry('a')]);

    store.applyWatchWrite({ cardId: 'b', isFavorite: true, favoritedAt: '2026-09-29T00:00:00.000Z' }, basics('b'));

    const { entries, stale } = store.getSnapshot();
    expect(entries?.map((row) => row.watchKey)).toEqual(['b|', 'a|']);
    expect(entries?.[0]).toMatchObject({ name: 'Name b', marketPrice: 12, sparkPoints: null, sinceWatchedPoints: null });
    expect(stale).toBe(true);
  });

  it('leaves a printing watch unpriced until the refetch, and never duplicates a row', () => {
    const store = createWatchlistStore();
    store.commitRead(store.beginRead(), [entry('a')]);

    store.applyWatchWrite({ cardId: 'a', isFavorite: true, watchVariant: 'Reverse Holofoil' }, basics('a'));
    store.applyWatchWrite({ cardId: 'a', isFavorite: true, watchVariant: 'Reverse Holofoil' }, basics('a'));

    const rows = store.getSnapshot().entries ?? [];
    expect(rows.map((row) => row.watchKey)).toEqual(['a|Reverse Holofoil', 'a|']);
    expect(rows[0].marketPrice).toBeNull();
  });

  it('removes only the unwatched printing', () => {
    const store = createWatchlistStore();
    store.commitRead(store.beginRead(), [entry('a'), entry('a', 'Holofoil')]);

    store.applyWatchWrite({ cardId: 'a', isFavorite: false, watchVariant: 'Holofoil' });

    expect(store.getSnapshot().entries?.map((row) => row.watchKey)).toEqual(['a|']);
  });

  it('marks stale without inventing rows when the list was never loaded', () => {
    const store = createWatchlistStore();
    store.applyWatchWrite({ cardId: 'b', isFavorite: true }, basics('b'));
    expect(store.getSnapshot()).toEqual({ entries: null, stale: true });
  });

  it('re-applies writes that landed while a read was in flight, and stays stale', () => {
    const store = createWatchlistStore();
    store.commitRead(store.beginRead(), [entry('a'), entry('gone')]);

    const token = store.beginRead();
    store.applyWatchWrite({ cardId: 'b', isFavorite: true }, basics('b'));
    store.applyWatchWrite({ cardId: 'gone', isFavorite: false });
    // The read started before both writes, so it still has 'gone' and lacks 'b'.
    store.commitRead(token, [entry('a'), entry('gone')]);

    expect(store.getSnapshot().entries?.map((row) => row.watchKey)).toEqual(['b|', 'a|']);
    expect(store.getSnapshot().stale).toBe(true);

    // A read that started after them is the truth and clears the flag.
    store.commitRead(store.beginRead(), [entry('b'), entry('a')]);
    expect(store.getSnapshot().stale).toBe(false);
  });

  it('notifies subscribers', () => {
    const store = createWatchlistStore();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    store.markStale();
    store.markStale();
    unsubscribe();
    store.markStale();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
