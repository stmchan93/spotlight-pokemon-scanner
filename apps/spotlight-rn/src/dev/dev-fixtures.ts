import { Image } from 'react-native';

import { devImageUriFor } from '@/dev/dev-image-uri';

/**
 * Deterministic placeholder art for dev screen routes (`spotlight://dev/*`).
 *
 * Mock repository data points at images.pokemontcg.io — a network dependency
 * that makes screenshots race image decode on a cold cache. The dev repository
 * rewrites every image URL to one of these bundled PNGs instead (served by
 * Metro locally, so first paint is instant and identical run-to-run).
 *
 * Regenerate the PNGs with:
 *   uv run --with pillow python tools/design-sync/generate_dev_placeholders.py
 */
const placeholderCards = [
  require('@/assets/dev/card-placeholder-1.png'),
  require('@/assets/dev/card-placeholder-2.png'),
  require('@/assets/dev/card-placeholder-3.png'),
  require('@/assets/dev/card-placeholder-4.png'),
  require('@/assets/dev/card-placeholder-5.png'),
] as const;

let placeholderUris: readonly string[] | null = null;

export function devImageUriForUrl(url: string): string {
  placeholderUris ??= placeholderCards.map((asset) => Image.resolveAssetSource(asset).uri);
  return devImageUriFor(url, placeholderUris);
}
