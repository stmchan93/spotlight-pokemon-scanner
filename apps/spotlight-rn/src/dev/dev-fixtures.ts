import { Image } from 'react-native';

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

/** djb2 — stable across runs/platforms, so a URL always maps to the same asset. */
function stableHash(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function devImageUriForUrl(url: string): string {
  const asset = placeholderCards[stableHash(url) % placeholderCards.length];
  return Image.resolveAssetSource(asset).uri;
}
