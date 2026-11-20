import { StyleSheet, View } from 'react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { SectionHeader, spacing } from '@spotlight/design-system';

import { SearchResultTile, chunkResultRows } from '@/features/catalog/components/catalog-results-grid';

export type SealedResultsSectionProps = {
  results: CatalogSearchResult[];
  onOpenResult: (result: CatalogSearchResult) => void;
  openingResultId?: string | null;
  testID?: string;
};

const SEALED_LABEL = 'SEALED';

/**
 * Sealed matches as a two-up section under a small-caps SEALED heading. The
 * Search landing puts it AFTER every card result: a name search leads with
 * cards, and sealed is there for whoever scrolls past them.
 */
export function SealedResultsSection({
  results,
  onOpenResult,
  openingResultId = null,
  testID = 'sealed-results-section',
}: SealedResultsSectionProps) {
  if (results.length === 0) {
    return null;
  }
  return (
    <View style={styles.section} testID={testID}>
      <SectionHeader size="compact" testID={`${testID}-heading`} title={SEALED_LABEL} uppercase />
      {chunkResultRows(results).map((row) => (
        <View key={row[0].id} style={styles.row}>
          {row.map((result) => (
            <SearchResultTile
              artAspect="square"
              key={result.id}
              onPress={() => {
                if (openingResultId === result.id) {
                  return;
                }
                onOpenResult(result);
              }}
              result={result}
              testIDPrefix={`${testID}-tile`}
            />
          ))}
          {row.length < 2 ? <View style={styles.cell} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
  },
  // Same 12 row/column gap as the card grid above it.
  row: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  section: {
    gap: spacing.xs,
    paddingTop: spacing.lg,
  },
});
