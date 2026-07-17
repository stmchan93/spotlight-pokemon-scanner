import { ScrollView, StyleSheet, View } from 'react-native';

import {
  RARITY_BUCKET_LABELS,
  RARITY_FILTER_BUCKETS,
  type RarityFilterBucket,
} from '@spotlight/api-client';
import { PillButton } from '@spotlight/design-system';

export type CollectionFilterKey =
  | 'all'
  | 'az'
  | 'price'
  | 'favorites'
  | 'ungraded'
  | 'graded'
  | RarityFilterBucket;

export const COLLECTION_FILTER_ORDER: CollectionFilterKey[] = [
  'all',
  'az',
  'price',
  'favorites',
  'ungraded',
  'graded',
  ...RARITY_FILTER_BUCKETS,
];

const FILTER_LABELS: Record<CollectionFilterKey, string> = {
  all: 'All',
  az: 'A-Z',
  price: '$-$$$',
  favorites: 'Likes',
  ungraded: 'Ungraded',
  graded: 'Graded',
  // Rarity chip labels live in the api-client (single client home).
  ...RARITY_BUCKET_LABELS,
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
