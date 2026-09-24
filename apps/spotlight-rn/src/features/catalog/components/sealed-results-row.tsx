import { FlatList, StyleSheet, View } from 'react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { SectionHeader } from '@spotlight/design-system';

import { SearchResultTile } from '@/features/catalog/components/catalog-results-grid';

/**
 * Sealed matches for a typed query, as one horizontal row above the card grid.
 * Kept OUT of the grid so a name search ("umbreon") still leads with cards.
 */

const TILE_WIDTH = 148;

export type SealedResultsRowProps = {
  results: CatalogSearchResult[];
  onOpenResult: (result: CatalogSearchResult) => void;
  openingResultId?: string | null;
  onSeeAll: () => void;
};

export function SealedResultsRow({
  results,
  onOpenResult,
  openingResultId = null,
  onSeeAll,
}: SealedResultsRowProps) {
  return (
    <View style={styles.section} testID="catalog-sealed-section">
      <SectionHeader
        actionLabel="See all"
        actionTestID="catalog-sealed-see-all"
        onActionPress={onSeeAll}
        title="Sealed products"
      />
      <FlatList
        contentContainerStyle={styles.rowContent}
        data={results}
        horizontal
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <SearchResultTile
            artAspect="square"
            onPress={() => {
              if (openingResultId === item.id) {
                return;
              }
              onOpenResult(item);
            }}
            result={item}
            style={styles.tile}
            testIDPrefix="catalog-sealed-row"
          />
        )}
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        testID="catalog-sealed-row"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    // Bleeds past the results list's 16pt gutter so tiles scroll edge to edge.
    marginHorizontal: -16,
  },
  rowContent: {
    gap: 12,
    paddingHorizontal: 16,
  },
  section: {
    gap: 12,
    // With the list's 12pt row gap, 24 between the row and the first cards.
    paddingBottom: 12,
  },
  tile: {
    width: TILE_WIDTH,
  },
});
