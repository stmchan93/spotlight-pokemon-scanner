import { ScrollView, StyleSheet, View } from 'react-native';
import { DataTransferBoth, Heart } from 'iconoir-react-native';

import { PillButton, useSpotlightTheme } from '@spotlight/design-system';

// Insights chip row (Figma 2206-20251): All / Likes / Price / A-Z / Ungraded /
// Graded. Mirrors the Collection chip semantics ('favorites' stays the internal
// key for the user-facing "Likes") but with the Insights ordering, the "Price"
// label, and the heart / sort-arrows chip icons from the design.
export type InsightsFilterKey =
  | 'all'
  | 'favorites'
  | 'price'
  | 'az'
  | 'ungraded'
  | 'graded';

export const INSIGHTS_FILTER_ORDER: InsightsFilterKey[] = [
  'all',
  'favorites',
  'price',
  'az',
  'ungraded',
  'graded',
];

const FILTER_LABELS: Record<InsightsFilterKey, string> = {
  all: 'All',
  favorites: 'Likes',
  price: 'Price',
  az: 'A-Z',
  ungraded: 'Ungraded',
  graded: 'Graded',
};

type InsightsFilterChipRowProps = {
  activeFilter: InsightsFilterKey;
  onFilterChange: (next: InsightsFilterKey) => void;
  testID?: string;
};

export function InsightsFilterChipRow({
  activeFilter,
  onFilterChange,
  testID = 'insights-filter-chip-row',
}: InsightsFilterChipRowProps) {
  const theme = useSpotlightTheme();

  const chipIcon = (key: InsightsFilterKey, selected: boolean) => {
    const color = selected ? theme.colors.gray0 : theme.colors.gray900;
    if (key === 'favorites') {
      return <Heart color={color} height={16} width={16} />;
    }
    if (key === 'price') {
      return <DataTransferBoth color={color} height={16} width={16} />;
    }
    return undefined;
  };

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={testID}
    >
      <View style={styles.chipRow}>
        {INSIGHTS_FILTER_ORDER.map((key) => (
          <PillButton
            key={key}
            label={FILTER_LABELS[key]}
            leading={chipIcon(key, activeFilter === key)}
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
