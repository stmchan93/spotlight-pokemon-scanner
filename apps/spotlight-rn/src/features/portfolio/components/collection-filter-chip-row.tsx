import { ScrollView, StyleSheet, View } from 'react-native';

import { PillButton } from '@spotlight/design-system';

export type CollectionFilterKey =
  | 'all'
  | 'az'
  | 'price'
  | 'favorites'
  | 'ungraded'
  | 'graded';

export const COLLECTION_FILTER_ORDER: CollectionFilterKey[] = [
  'all',
  'az',
  'price',
  'favorites',
  'ungraded',
  'graded',
];

const FILTER_LABELS: Record<CollectionFilterKey, string> = {
  all: 'All',
  az: 'A-Z',
  price: '$-$$$',
  favorites: 'Favorites',
  ungraded: 'Ungraded',
  graded: 'Graded',
};

type CollectionFilterChipRowProps = {
  activeFilter: CollectionFilterKey;
  onFilterChange: (next: CollectionFilterKey) => void;
  testID?: string;
};

export function CollectionFilterChipRow({
  activeFilter,
  onFilterChange,
  testID = 'collection-filter-chip-row',
}: CollectionFilterChipRowProps) {
  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={testID}
    >
      <View style={styles.chipRow}>
        {COLLECTION_FILTER_ORDER.map((key) => (
          <PillButton
            key={key}
            label={FILTER_LABELS[key]}
            onPress={() => onFilterChange(key)}
            selected={activeFilter === key}
            testID={`${testID}-${key}`}
            tone="filter"
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
});
