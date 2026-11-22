import type { RawPricingMatrixVariant } from '@spotlight/api-client';

/**
 * One pricing-matrix read per tray card, recorded in `cache` (the screen's
 * variantsRef). Each fetch is marked with a placeholder before the await so a
 * re-render mid-flight cannot double-fetch. The returned cleanup removes this
 * run's placeholders that are still pending: an effect re-run (a new card
 * scanned) cancels the in-flight reads, and a placeholder left behind would
 * make the next run skip the card, stranding it with no printings for the
 * session.
 */
export function loadTrayVariantMatrices(
  cardIds: readonly string[],
  cache: Map<string, RawPricingMatrixVariant[]>,
  fetchMatrix: (cardId: string) => Promise<{ variants: RawPricingMatrixVariant[] }>,
  onLoaded: (cardId: string, variants: RawPricingMatrixVariant[]) => void,
): () => void {
  let cancelled = false;
  const pending = new Map<string, RawPricingMatrixVariant[]>();
  cardIds.forEach((cardId) => {
    if (cache.has(cardId)) {
      return;
    }
    const placeholder: RawPricingMatrixVariant[] = [];
    pending.set(cardId, placeholder);
    cache.set(cardId, placeholder);
    void fetchMatrix(cardId)
      .then((matrix) => {
        if (cancelled) {
          return;
        }
        pending.delete(cardId);
        if (matrix.variants.length === 0) {
          return;
        }
        cache.set(cardId, matrix.variants);
        onLoaded(cardId, matrix.variants);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        pending.delete(cardId);
        // Best-effort: the row keeps its RAW tag and the price sheet still works.
        if (cache.get(cardId) === placeholder) {
          cache.delete(cardId);
        }
      });
  });
  return () => {
    cancelled = true;
    pending.forEach((placeholder, cardId) => {
      if (cache.get(cardId) === placeholder) {
        cache.delete(cardId);
      }
    });
  };
}
