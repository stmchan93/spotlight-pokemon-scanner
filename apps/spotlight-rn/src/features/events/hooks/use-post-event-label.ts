import { useEffect } from 'react';

import type { SpotlightEventMap, SpotlightEventsFeed } from '@spotlight/api-client';

import { vendorTableLabel } from '@/features/events/event-floor-map-model';
import { useAppServices } from '@/providers/app-providers';

// Same cache keys `useSpotlightEvents` / `useSpotlightEventMap` write.
const EVENTS_KEY = 'spotlightEvents';
const mapKey = (url: string) => `spotlightEventMap:${url}`;

// One read per key for the whole app, however many cards ask: a feed of 20
// show-tagged posts must not become 20 reads.
const inFlight = new Set<string>();
// A failed read holds its key this long, so a list of cards can't retry-storm.
const RETRY_AFTER_MS = 60_000;

function readOnce<T>(key: string, read: () => Promise<T>, write: (value: T) => void): void {
  if (inFlight.has(key)) {
    return;
  }
  inFlight.add(key);
  void read().then(
    (value) => {
      write(value);
      inFlight.delete(key);
    },
    () => {
      setTimeout(() => inFlight.delete(key), RETRY_AFTER_MS);
    },
  );
}

export function resetPostEventLabelReadsForTests(): void {
  inFlight.clear();
}

export type PostEventLabel = {
  /** The show's short title, or null until the events list is known. */
  showTitle: string | null;
  /** "Table C1-C2" for a booth post once the floor map is known; else null. */
  table: string | null;
  vendorName: string | null;
};

/**
 * Display names for a post's show tag, read from the shared events/map cache.
 * Cold cache: one deduped background read fills it, and every card re-renders.
 */
export function usePostEventLabel(eventId: string, boothVendorId: string | null): PostEventLabel {
  const { metaFeedCache, setMetaFeedCacheEntry, spotlightRepository } = useAppServices();
  const feed = metaFeedCache[EVENTS_KEY] as SpotlightEventsFeed | null | undefined;
  const event = feed?.items.find((item) => item.id === eventId) ?? null;
  const mapUrl = boothVendorId ? (event?.floorMapUrl ?? null) : null;
  const map = mapUrl ? (metaFeedCache[mapKey(mapUrl)] as SpotlightEventMap | null | undefined) : undefined;

  useEffect(() => {
    if (feed !== undefined) {
      return;
    }
    readOnce(EVENTS_KEY, () => spotlightRepository.fetchSpotlightEvents(), (next) => setMetaFeedCacheEntry(EVENTS_KEY, next));
  }, [feed, setMetaFeedCacheEntry, spotlightRepository]);

  useEffect(() => {
    if (!mapUrl || map !== undefined) {
      return;
    }
    const key = mapKey(mapUrl);
    readOnce(key, () => spotlightRepository.fetchSpotlightEventMap(mapUrl), (next) => setMetaFeedCacheEntry(key, next));
  }, [map, mapUrl, setMetaFeedCacheEntry, spotlightRepository]);

  const vendor = boothVendorId ? (map?.vendors.find((item) => item.id === boothVendorId) ?? null) : null;
  return {
    showTitle: event?.shortTitle ?? null,
    table: vendor ? vendorTableLabel(vendor.location) : null,
    vendorName: vendor?.name ?? null,
  };
}
