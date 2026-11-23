import { PillButton } from '@spotlight/design-system';

import {
  CATALOG_SEARCH_FILTER_OPTIONS,
  type CatalogSearchFilter,
  type CatalogSearchFilterOption,
} from '@/features/catalog/catalog-search-filter';

type CatalogSearchFilterChipsProps = {
  activeFilter: CatalogSearchFilter | null;
  onToggle: (filter: CatalogSearchFilter) => void;
  /** Chip testIDs are `${testIDPrefix}-sealed-chip` / `${testIDPrefix}-rarity-chip-sir`. */
  testIDPrefix: string;
  /** A subset (e.g. the sheet's rarity group); every option when absent. */
  options?: readonly CatalogSearchFilterOption[];
};

/**
 * Sealed + rarity chips (PillButton tone="filter", the Collection filter row's
 * pattern). The caller lays them out — a scrolling row or a wrapping sheet.
 */
export function CatalogSearchFilterChips({
  activeFilter,
  onToggle,
  testIDPrefix,
  options = CATALOG_SEARCH_FILTER_OPTIONS,
}: CatalogSearchFilterChipsProps) {
  return (
    <>
      {options.map((option) => (
        <PillButton
          key={option.value}
          label={option.label}
          labelRole="caption"
          onPress={() => onToggle(option.value)}
          selected={activeFilter === option.value}
          testID={`${testIDPrefix}-${option.testIDSuffix}`}
          tone="filter"
          uppercase
        />
      ))}
    </>
  );
}
