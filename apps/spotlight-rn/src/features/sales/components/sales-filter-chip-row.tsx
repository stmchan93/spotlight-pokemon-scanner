import { ScrollView, StyleSheet, View } from 'react-native';

import { PillButton } from '@spotlight/design-system';

export type SalesFilterKey = 'all' | 'az' | 'date' | 'pokemon' | 'ungraded' | 'graded';

export const SALES_FILTER_ORDER: SalesFilterKey[] = [
  'all',
  'az',
  'date',
  'pokemon',
  'ungraded',
  'graded',
];

const FILTER_LABELS: Record<SalesFilterKey, string> = {
  all: 'All',
  az: 'A-Z',
  date: 'Date',
  pokemon: 'Pokémon',
  ungraded: 'Ungraded',
  graded: 'Graded',
};

type SalesFilterChipRowProps = {
  activeFilter: SalesFilterKey;
  onFilterChange: (next: SalesFilterKey) => void;
  testID?: string;
};

export function SalesFilterChipRow({
  activeFilter,
  onFilterChange,
  testID = 'sales-filter-chip-row',
}: SalesFilterChipRowProps) {
  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={testID}
    >
      <View style={styles.chipRow}>
        {SALES_FILTER_ORDER.map((key) => (
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
