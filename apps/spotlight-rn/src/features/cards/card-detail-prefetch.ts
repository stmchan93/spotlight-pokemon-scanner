import type {
  CardDetailRecord,
  CardPriceTrendList as CardPriceTrendListRecord,
  SpotlightRepository,
} from '@spotlight/api-client';

import type { CardDetailPreview } from '@/features/cards/card-detail-preview-session';
import { imageCachePolicy } from '@/components/cached-image';
import { prefetchImageUrls } from '@/lib/card-images';

/**
 * Short-TTL in-memory read-through cache + navigation prefetch for the card
 * detail page (PDP). Mirrors the LRU/Map style of `card-detail-preview-session`.
 *
 * Two independent caches keyed differently:
 *   - detail:  keyed by `cardId`
 *   - trend:   keyed by `cardId|mode|variant|grader` (the "lane key")
 *
 * Entries store a promise so concurrent readers (a navigation prefetch + the
 * screen mount) share one in-flight request, then collapse to a resolved value.
 * Entries expire after `cacheTtlMs` so a revisit re-fetches fresh pricing.
 *
 * Caching is best-effort: rejected promises are dropped from the cache so the
 * next read retries the network rather than caching a failure.
 */

const cacheTtlMs = 60_000;
const maxDetailEntries = 50;
const maxTrendEntries = 80;

export type CardDetailLane = {
  mode: 'raw' | 'graded';
  variant: string | null;
  grader: string | null;
};

type CacheEntry<T> = {
  createdAt: number;
  promise: Promise<T>;
};

const detailCache = new Map<string, CacheEntry<CardDetailRecord | null>>();
const trendCache = new Map<string, CacheEntry<CardPriceTrendListRecord | null>>();

/**
 * The default price lane for a card, computed from preview/owned data BEFORE
 * full detail loads. Mirrors the screen's grader/variant seeding effects:
 *   - owned slab → graded lane on its grader (or PSA fallback)
 *   - otherwise  → raw lane on the owned raw variant (or 'Normal', a safe default
 *     the backend resolves even when the catalog lacks a literal 'Normal').
 */
export function defaultLaneFromPreview(preview?: CardDetailPreview | null): CardDetailLane {
  const ownedEntry = preview?.ownedEntry ?? null;
  const slabContext = ownedEntry?.slabContext ?? null;

  if (slabContext?.grader) {
    return { grader: slabContext.grader, mode: 'graded', variant: null };
  }

  const ownedVariant = ownedEntry?.kind === 'raw' ? ownedEntry.variantName?.trim() : null;
  return { grader: null, mode: 'raw', variant: ownedVariant || 'Normal' };
}

export function laneKey(cardId: string, lane: CardDetailLane): string {
  return [cardId, lane.mode, lane.variant ?? '', lane.grader ?? ''].join('|');
}

function isFresh(entry: CacheEntry<unknown> | undefined): entry is CacheEntry<unknown> {
  return entry != null && Date.now() - entry.createdAt < cacheTtlMs;
}

function evictExpired<T>(cache: Map<string, CacheEntry<T>>, maxEntries: number) {
  for (const [key, entry] of cache) {
    if (!isFresh(entry)) {
      cache.delete(key);
    }
  }
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function storeEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  maxEntries: number,
  key: string,
  promise: Promise<T>,
) {
  const entry: CacheEntry<T> = { createdAt: Date.now(), promise };
  cache.delete(key);
  cache.set(key, entry);
  evictExpired(cache, maxEntries);

  // Drop a rejected entry so the next read retries instead of caching a failure.
  promise.catch(() => {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
  });

  return promise;
}

/**
 * Read-through: returns a cached/in-flight `getCardDetail` promise for the card,
 * or fires one and caches it. Used by both the screen and the nav prefetch so a
 * tile tap that prefetched is reused instantly on the PDP.
 */
export function getCardDetailCached(
  repository: SpotlightRepository,
  cardId: string,
): Promise<CardDetailRecord | null> {
  const existing = detailCache.get(cardId);
  if (isFresh(existing)) {
    return existing.promise;
  }
  return storeEntry(
    detailCache,
    maxDetailEntries,
    cardId,
    // Skip the heavy full-collection fetch on the detail critical path so the
    // card image + variants paint as soon as card + market-history resolve. The
    // PDP sources owned context from the already-loaded inventory cache instead.
    repository.getCardDetail({ cardId }, { includeOwnedEntries: false }),
  );
}

/**
 * Read-through for a specific price lane. The lane key includes mode/variant/
 * grader so each lens caches independently.
 */
export function getCardPriceTrendsCached(
  repository: SpotlightRepository,
  cardId: string,
  lane: CardDetailLane,
): Promise<CardPriceTrendListRecord | null> {
  const key = laneKey(cardId, lane);
  const existing = trendCache.get(key);
  if (isFresh(existing)) {
    return existing.promise;
  }
  return storeEntry(
    trendCache,
    maxTrendEntries,
    key,
    repository.getCardPriceTrends({
      cardId,
      mode: lane.mode,
      variant: lane.mode === 'raw' ? lane.variant : null,
      grader: lane.mode === 'raw' ? null : lane.grader,
    }),
  );
}

/** True when a fresh detail entry is already cached (so the screen can skip its loading flash). */
export function hasFreshCardDetail(cardId: string): boolean {
  return isFresh(detailCache.get(cardId));
}

/**
 * Best-effort navigation prefetch: kicks off the detail + default-lane trend
 * fetch and warms the caches. Fire-and-forget — call it at the tile-tap site so
 * the requests are in flight before the PDP mounts. Errors are swallowed.
 */
export function prefetchCardDetail(
  repository: SpotlightRepository,
  cardId: string,
  lane?: CardDetailLane,
  imageUrl?: string | null,
): void {
  if (!cardId) {
    return;
  }
  void getCardDetailCached(repository, cardId).catch(() => undefined);
  void getCardPriceTrendsCached(
    repository,
    cardId,
    lane ?? { grader: null, mode: 'raw', variant: 'Normal' },
  ).catch(() => undefined);
  // Warm the hero image into the same disk cache the PDP hero reads from, so the
  // card art is already downloading (often resolved) before the page mounts.
  if (imageUrl) {
    void prefetchImageUrls([imageUrl], imageCachePolicy.hero).catch(() => undefined);
  }
}

/**
 * Drop everything for one card (both caches), e.g. after a pull-to-refresh or a
 * mutation that changes its pricing/ownership. Cheap linear scan over the small
 * trend map.
 */
export function invalidateCardDetailCache(cardId: string): void {
  detailCache.delete(cardId);
  for (const key of trendCache.keys()) {
    if (key === cardId || key.startsWith(`${cardId}|`)) {
      trendCache.delete(key);
    }
  }
}

/** Clear both caches entirely (test cleanup / global data-version bumps). */
export function clearCardDetailCache(): void {
  detailCache.clear();
  trendCache.clear();
}
