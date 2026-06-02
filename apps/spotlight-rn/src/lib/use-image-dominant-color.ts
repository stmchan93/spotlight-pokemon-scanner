import { useEffect, useState } from 'react';
import { getColors } from 'react-native-image-colors';
import type { ImageColorsResult } from 'react-native-image-colors';

/**
 * Neutral dark slate used while a card's color is still resolving and as the
 * failure fallback. It fades cleanly to white, so the hero never flashes a
 * jarring placeholder before the real card color lands.
 */
export const DOMINANT_COLOR_FALLBACK = '#3A3A3C';

export type DominantColorState = {
  /** Hex color derived from the card image (or the neutral fallback). */
  color: string;
  /** True once a real extracted color (not the fallback) is in `color`. */
  isReady: boolean;
};

// Module-level cache of the *picked* color per image URI. `getColors` keeps its
// own decode cache, but this lets the hook seed state synchronously on remount
// (e.g. re-featuring a card you already viewed) with no extraction flash.
const dominantColorByUri = new Map<string, string>();

function pickDominantColor(result: ImageColorsResult): string {
  switch (result.platform) {
    case 'ios':
      // `primary` is the card's prominent foreground color; `detail`/`background`
      // back it up when the primary read is empty.
      return result.primary || result.detail || result.background;
    case 'android':
      return result.vibrant || result.dominant || result.average;
    default:
      return result.vibrant || result.dominant;
  }
}

/**
 * Extract a stable dominant color from a card image for the wishlist hero
 * gradient. Returns the neutral fallback while loading and on failure so callers
 * can render unconditionally.
 */
export function useImageDominantColor(uri: string | null | undefined): DominantColorState {
  const [state, setState] = useState<DominantColorState>(() => {
    const cached = uri ? dominantColorByUri.get(uri) : undefined;
    return cached
      ? { color: cached, isReady: true }
      : { color: DOMINANT_COLOR_FALLBACK, isReady: false };
  });

  useEffect(() => {
    if (!uri) {
      setState({ color: DOMINANT_COLOR_FALLBACK, isReady: false });
      return;
    }

    const cached = dominantColorByUri.get(uri);
    if (cached) {
      setState({ color: cached, isReady: true });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const result = await getColors(uri, {
          fallback: DOMINANT_COLOR_FALLBACK,
          cache: true,
          key: uri,
          quality: 'low',
        });
        const color = pickDominantColor(result) || DOMINANT_COLOR_FALLBACK;
        dominantColorByUri.set(uri, color);
        if (!cancelled) {
          setState({ color, isReady: true });
        }
      } catch {
        if (!cancelled) {
          setState({ color: DOMINANT_COLOR_FALLBACK, isReady: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uri]);

  return state;
}
