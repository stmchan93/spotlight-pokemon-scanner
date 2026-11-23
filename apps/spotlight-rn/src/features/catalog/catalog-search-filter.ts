import { useCallback, useState } from 'react';

import {
  RARITY_BUCKET_LABELS,
  RARITY_FILTER_BUCKETS,
  type RarityFilterBucket,
} from '@spotlight/api-client';

/**
 * The card search's one filter: Sealed OR a rarity bucket, never both (sealed
 * product has no rarity). Shared by the all-games results page's chip row and
 * Search's filter sheet, so the two cannot drift apart.
 */
export const SEALED_FILTER = 'sealed';
export type CatalogSearchFilter = RarityFilterBucket | typeof SEALED_FILTER;

export type CatalogSearchFilterOption = {
  value: CatalogSearchFilter;
  label: string;
  testIDSuffix: string;
};

/** Sealed first, then the rarity buckets in their shared chip order. */
export const CATALOG_SEARCH_FILTER_OPTIONS: readonly CatalogSearchFilterOption[] = [
  { label: 'Sealed', testIDSuffix: 'sealed-chip', value: SEALED_FILTER },
  ...RARITY_FILTER_BUCKETS.map((bucket) => ({
    label: RARITY_BUCKET_LABELS[bucket],
    testIDSuffix: `rarity-chip-${bucket}`,
    value: bucket,
  })),
];

/** What `useCatalogCardSearch` takes for a filter. */
export function catalogSearchFilterParams(filter: CatalogSearchFilter | null): {
  rarityBucket: RarityFilterBucket | null;
  sealed: boolean;
} {
  return {
    rarityBucket: filter && filter !== SEALED_FILTER ? filter : null,
    sealed: filter === SEALED_FILTER,
  };
}

/** The label a filter shows, e.g. for the filter button's accessibility value. */
export function catalogSearchFilterLabel(filter: CatalogSearchFilter | null): string | null {
  return CATALOG_SEARCH_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? null;
}

export type CatalogSearchFilterState = {
  activeFilter: CatalogSearchFilter | null;
  setActiveFilter: (filter: CatalogSearchFilter | null) => void;
  /** Tap a chip: selects it, or clears it when it is already the active one. */
  toggleFilter: (filter: CatalogSearchFilter) => void;
  sealedActive: boolean;
  activeRarity: RarityFilterBucket | null;
};

/** Single-select filter state; a filter alone is a valid search (browse with no text). */
export function useCatalogSearchFilter(): CatalogSearchFilterState {
  const [activeFilter, setActiveFilter] = useState<CatalogSearchFilter | null>(null);
  const toggleFilter = useCallback(
    (filter: CatalogSearchFilter) => setActiveFilter((current) => (current === filter ? null : filter)),
    [],
  );
  const { rarityBucket, sealed } = catalogSearchFilterParams(activeFilter);
  return {
    activeFilter,
    activeRarity: rarityBucket,
    sealedActive: sealed,
    setActiveFilter,
    toggleFilter,
  };
}
