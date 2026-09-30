import {
  buildWatchKey,
  type CardDetailRecord,
  type CardFavoriteEntry,
  type CardFavoriteRecord,
  type CatalogSearchResult,
  type InventoryCardEntry,
} from '@spotlight/api-client';

/**
 * The Watchlist's rows, shared app-wide (one store per signed-in account, held
 * on AppServices) so a watch toggled ANYWHERE — card page, scanner tray,
 * Collection, the empty-state suggestions — shows on the Watchlist tab at once.
 *
 * WHY. The tab stays mounted (iOS native tabs mount it hidden at launch) and the
 * server read is slow when uncached (1.5–12.8s), so waiting for a refetch left a
 * just-watched card missing. Writers apply the server's add/remove answer here;
 * the new row renders with no price/sparkline until the background refetch
 * fills it, and `stale` makes the tab's next focus re-read.
 *
 * Deliberately NOT `dataVersion`: that signal also clears Insights and reloads
 * the portfolio, which a watch toggle has no business doing.
 */

/** What a caller knows about the card it just watched, for the placeholder row. */
export type WatchlistCardBasics = Pick<CardFavoriteEntry, 'cardId' | 'name'> &
  Partial<
    Pick<
      CardFavoriteEntry,
      | 'cardNumber'
      | 'setName'
      | 'imageUrl'
      | 'smallImageUrl'
      | 'largeImageUrl'
      | 'printingImageUrl'
      | 'printingImageSmallUrl'
      | 'marketPrice'
      | 'currencyCode'
      | 'isOwned'
      | 'rarityBucket'
      | 'game'
      | 'catalogSource'
    >
  >;

/** Placeholder-row basics from a loaded card page. */
export function watchlistCardBasicsFromDetail(detail: CardDetailRecord): WatchlistCardBasics {
  return {
    cardId: detail.cardId,
    name: detail.name,
    cardNumber: detail.cardNumber,
    setName: detail.setName,
    imageUrl: detail.imageUrl,
    largeImageUrl: detail.largeImageUrl ?? null,
    marketPrice: detail.marketPrice,
    currencyCode: detail.currencyCode,
    isOwned: detail.ownedEntries.length > 0,
    game: detail.game,
    catalogSource: detail.catalogSource,
  };
}

/** Placeholder-row basics from a search/scan candidate. */
export function watchlistCardBasicsFromSearchResult(result: CatalogSearchResult): WatchlistCardBasics {
  return {
    cardId: result.cardId,
    name: result.name,
    cardNumber: result.cardNumber,
    setName: result.setName,
    imageUrl: result.imageUrl,
    smallImageUrl: result.smallImageUrl ?? null,
    largeImageUrl: result.largeImageUrl ?? null,
    // A graded reference is not the raw price the watchlist shows.
    marketPrice: result.priceIsGradedReference ? null : result.marketPrice ?? null,
    currencyCode: result.currencyCode ?? 'USD',
    isOwned: (result.ownedQuantity ?? 0) > 0,
    rarityBucket: result.rarityBucket,
    game: result.game,
    catalogSource: result.catalogSource,
  };
}

/** Placeholder-row basics from an owned Collection copy. */
export function watchlistCardBasicsFromInventoryEntry(entry: InventoryCardEntry): WatchlistCardBasics {
  return {
    cardId: entry.cardId,
    name: entry.name,
    cardNumber: entry.cardNumber,
    setName: entry.setName,
    imageUrl: entry.imageUrl,
    smallImageUrl: entry.smallImageUrl ?? null,
    largeImageUrl: entry.largeImageUrl ?? null,
    ...(entry.printingImageUrl ? { printingImageUrl: entry.printingImageUrl } : {}),
    // The copy's price is its condition/grade's, not the watch's market price.
    marketPrice: null,
    currencyCode: entry.currencyCode,
    isOwned: true,
    rarityBucket: entry.rarityBucket,
    game: entry.game,
    catalogSource: entry.catalogSource,
  };
}

export type WatchlistSnapshot = {
  /** null = never loaded for this account. */
  entries: CardFavoriteEntry[] | null;
  /** A write landed since the last server read: the next focus must re-read. */
  stale: boolean;
};

type WatchWrite = { generation: number; record: CardFavoriteRecord; card: WatchlistCardBasics | null };

export type WatchlistReadToken = { generation: number };

export type WatchlistStore = {
  getSnapshot(): WatchlistSnapshot;
  subscribe(listener: () => void): () => void;
  /** Local edits by the Watchlist screen itself (its own optimistic removes, targets). */
  setEntries(update: (current: CardFavoriteEntry[]) => CardFavoriteEntry[]): void;
  /** Call before a server read; pass the token to `commitRead`. */
  beginRead(): WatchlistReadToken;
  /**
   * Land a server read. Writes that happened while it was in flight are
   * re-applied on top (the read may predate them) and keep the list stale.
   */
  commitRead(token: WatchlistReadToken, entries: CardFavoriteEntry[]): void;
  /** A watch add/remove the server confirmed, from anywhere in the app. */
  applyWatchWrite(record: CardFavoriteRecord, card?: WatchlistCardBasics | null): void;
  markStale(): void;
};

// Enough to cover any read in flight; older writes are already in a read.
const WRITE_LOG_LIMIT = 50;

function placeholderEntry(record: CardFavoriteRecord, card: WatchlistCardBasics): CardFavoriteEntry {
  const watchVariant = record.watchVariant ?? null;
  return {
    cardId: record.cardId,
    watchVariant,
    watchKey: buildWatchKey(record.cardId, watchVariant),
    name: card.name,
    cardNumber: card.cardNumber ?? '',
    setName: card.setName ?? '',
    imageUrl: card.imageUrl ?? card.smallImageUrl ?? card.largeImageUrl ?? '',
    smallImageUrl: card.smallImageUrl ?? null,
    largeImageUrl: card.largeImageUrl ?? null,
    ...(card.printingImageUrl ? { printingImageUrl: card.printingImageUrl } : {}),
    ...(card.printingImageSmallUrl ? { printingImageSmallUrl: card.printingImageSmallUrl } : {}),
    // A printing's price can differ from the card's main price, so only the
    // main-printing watch borrows the caller's number; the refetch fills the rest.
    marketPrice: watchVariant == null ? card.marketPrice ?? null : null,
    currencyCode: card.currencyCode ?? 'USD',
    favoritedAt: record.favoritedAt ?? new Date().toISOString(),
    isOwned: card.isOwned ?? false,
    rarityBucket: card.rarityBucket,
    game: card.game,
    catalogSource: card.catalogSource,
    sparkPoints: null,
    sinceWatchedPoints: null,
  };
}

function applyWrite(entries: CardFavoriteEntry[], write: WatchWrite): CardFavoriteEntry[] {
  const { record, card } = write;
  const watchKey = buildWatchKey(record.cardId, record.watchVariant ?? null);
  const existing = entries.some((entry) => entry.watchKey === watchKey);
  if (!record.isFavorite) {
    return existing ? entries.filter((entry) => entry.watchKey !== watchKey) : entries;
  }
  if (existing || !card) {
    return entries;
  }
  // Newest watch first, matching the server's favorited_at DESC order.
  return [placeholderEntry(record, card), ...entries];
}

export function createWatchlistStore(): WatchlistStore {
  let snapshot: WatchlistSnapshot = { entries: null, stale: false };
  let generation = 0;
  let writes: WatchWrite[] = [];
  const listeners = new Set<() => void>();

  const emit = (next: WatchlistSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEntries(update) {
      emit({ ...snapshot, entries: update(snapshot.entries ?? []) });
    },
    beginRead() {
      return { generation };
    },
    commitRead(token, entries) {
      const missed = writes.filter((write) => write.generation > token.generation);
      const merged = missed.reduce(applyWrite, entries);
      emit({ entries: merged, stale: missed.length > 0 });
    },
    applyWatchWrite(record, card = null) {
      generation += 1;
      const write: WatchWrite = { generation, record, card };
      writes = [...writes.slice(-(WRITE_LOG_LIMIT - 1)), write];
      emit({
        // Never loaded: nothing to patch, the first read will include it.
        entries: snapshot.entries ? applyWrite(snapshot.entries, write) : null,
        stale: true,
      });
    },
    markStale() {
      if (!snapshot.stale) {
        emit({ ...snapshot, stale: true });
      }
    },
  };
}
