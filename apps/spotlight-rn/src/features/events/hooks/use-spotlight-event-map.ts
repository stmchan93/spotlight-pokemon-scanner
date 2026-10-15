import type { SpotlightEventMap } from '@spotlight/api-client';

import { useMetaFeedRead } from '@/features/meta-feed/hooks/use-meta-feed-read';

// Re-synced from Figma when vendors change; a show-day edit should land within minutes.
export const SPOTLIGHT_EVENT_MAP_STALE_AFTER_MS = 5 * 60_000;

export type UseSpotlightEventMapResult = {
  map: SpotlightEventMap | null;
  loading: boolean;
};

/** Never fetches without a URL, so events without a map cost nothing. */
export function useSpotlightEventMap(floorMapUrl: string | null): UseSpotlightEventMapResult {
  const read = useMetaFeedRead<SpotlightEventMap>(
    `spotlightEventMap:${floorMapUrl ?? ''}`,
    (repository) => repository.fetchSpotlightEventMap(floorMapUrl ?? ''),
    SPOTLIGHT_EVENT_MAP_STALE_AFTER_MS,
    floorMapUrl != null,
  );
  return { map: read.data, loading: read.loading };
}
