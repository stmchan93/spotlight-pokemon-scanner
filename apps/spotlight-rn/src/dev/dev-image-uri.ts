/**
 * Pure half of the dev image rewrite (`dev-fixtures.ts` supplies the bundled
 * asset URIs). Kept asset-free so it is unit-testable: jest's `@/` alias is
 * src-only and cannot reach the placeholder PNGs.
 */

/** djb2 — stable across runs/platforms, so a URL always maps to the same asset. */
export function stableHash(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * A handful of placeholders stand in for every remote image, so two different
 * source URLs routinely resolve to the same PNG. Components that key list rows
 * by image URL (e.g. the browse grid's set-logo mosaic) then see duplicate
 * keys. Tagging the URI with the source URL's hash keeps it unique per source
 * while still pointing at the same bundled asset — Metro ignores unknown query
 * params on `/assets/` requests.
 */
export function devImageUriFor(url: string, placeholderUris: readonly string[]): string {
  const hash = stableHash(url);
  const base = placeholderUris[hash % placeholderUris.length];
  return `${base}${base.includes('?') ? '&' : '?'}dev=${hash.toString(36)}`;
}
