import { StyleSheet, View } from 'react-native';

import type { InventoryCardEntry } from '@spotlight/api-client';
import {
  Button,
  SearchField,
  SectionHeader,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { InventoryEntryCard } from '@/features/inventory/components/inventory-entry-card';

type InventoryGridProps = {
  hasInventoryEntries: boolean;
  inventoryCount: number;
  isLoading?: boolean;
  inventoryExpanded: boolean;
  inventoryItems: InventoryCardEntry[];
  onOpenAddCard: () => void;
  onOpenEntry: (entry: InventoryCardEntry) => void;
  onOpenInventory: () => void;
  onOpenSellSelection: (entryId?: string) => void;
  onSearchChange: (value: string) => void;
  onToggleExpanded: () => void;
  searchQuery: string;
};

function chunkIntoRows(items: readonly InventoryCardEntry[], perRow: number) {
  const rows: InventoryCardEntry[][] = [];

  for (let index = 0; index < items.length; index += perRow) {
    rows.push(items.slice(index, index + perRow));
  }

  return rows;
}

function InventoryGridSkeleton() {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.grid} testID="portfolio-inventory-skeleton">
      {Array.from({ length: 2 }).map((_, rowIndex) => (
        <View key={rowIndex} style={styles.gridRow}>
          {Array.from({ length: 3 }).map((__, tileIndex) => (
            <View
              key={tileIndex}
              style={[
                styles.tileWrap,
                styles.skeletonTile,
                {
                  backgroundColor: theme.colors.canvasElevated,
                  borderColor: theme.colors.outlineSubtle,
                },
              ]}
            >
              <View style={[styles.skeletonImage, { backgroundColor: theme.colors.outlineSubtle }]} />
              <View style={[styles.skeletonTextWide, { backgroundColor: theme.colors.outlineSubtle }]} />
              <View style={[styles.skeletonTextNarrow, { backgroundColor: theme.colors.outlineSubtle }]} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function InventoryGrid({
  hasInventoryEntries,
  inventoryCount,
  isLoading = false,
  inventoryExpanded,
  inventoryItems,
  onOpenAddCard,
  onOpenEntry,
  onOpenInventory,
  onOpenSellSelection,
  onSearchChange,
  onToggleExpanded,
  searchQuery,
}: InventoryGridProps) {
  const rows = chunkIntoRows(inventoryItems.slice(0, 9), 3);
  const hasSearchQuery = searchQuery.trim().length > 0;
  const emptyStateTitle = hasInventoryEntries
    ? 'No cards match that search'
    : 'No cards in your collection yet';
  const emptyStateMessage = hasInventoryEntries
    ? 'Try a different name, set, or card number.'
    : 'Scan or add a card and it will appear here.';

  return (
    <View style={styles.section}>
      <SectionHeader
        actionLabel={hasInventoryEntries ? 'View All' : undefined}
        actionTestID="portfolio-see-more"
        countText={hasInventoryEntries ? `(${inventoryCount})` : undefined}
        expanded={inventoryExpanded}
        onActionPress={hasInventoryEntries ? onOpenInventory : undefined}
        onPress={onToggleExpanded}
        title="Inventory"
      />

      <View
        style={[
          styles.actionRow,
          !hasInventoryEntries ? styles.actionRowSingle : null,
        ]}
      >
        <Button
          label="Add Card"
          onPress={onOpenAddCard}
          style={styles.primaryAction}
          testID="portfolio-add-card"
          variant="primary"
        />

        {hasInventoryEntries ? (
          <View style={styles.trailingActions}>
            <Button
              label="Bulk Sell"
              onPress={() => onOpenSellSelection()}
              style={styles.secondaryAction}
              testID="portfolio-sell-entry"
              variant="secondary"
            />
          </View>
        ) : null}
      </View>

      {inventoryExpanded ? (
        <>
          <SearchField
            containerStyle={styles.searchField}
            onChangeText={onSearchChange}
            placeholder="Search collection cards"
            value={searchQuery}
          />

          {inventoryItems.length === 0 && isLoading ? (
            <InventoryGridSkeleton />
          ) : inventoryItems.length === 0 ? (
            <StateCard
              message={hasSearchQuery || hasInventoryEntries
                ? emptyStateMessage
                : 'Scan or add a card and it will appear here.'}
              style={styles.emptyStateCard}
              title={emptyStateTitle}
            />
          ) : (
            <View style={styles.grid}>
              {rows.map((row, rowIndex) => (
                <View key={`row-${rowIndex}`} style={styles.gridRow}>
                  {row.map((item) => (
                    <View key={item.id} style={styles.tileWrap}>
                      <InventoryEntryCard
                        entry={item}
                        onLongPress={() => onOpenSellSelection(item.id)}
                        onPress={() => onOpenEntry(item)}
                        showConditionLabel
                      />
                    </View>
                  ))}

                  {row.length < 3
                    ? Array.from({ length: 3 - row.length }).map((_, spacerIndex) => (
                        <View key={`spacer-${rowIndex}-${spacerIndex}`} style={styles.tileWrap} />
                      ))
                    : null}
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  actionRowSingle: {
    justifyContent: 'flex-start',
  },
  emptyStateCard: {
    marginTop: 18,
  },
  grid: {
    gap: 12,
    marginTop: 18,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 12,
  },
  primaryAction: {
    minWidth: 100,
  },
  searchField: {
    marginTop: 18,
  },
  section: {},
  secondaryAction: {
    minWidth: 78,
  },
  skeletonImage: {
    aspectRatio: 0.72,
    borderRadius: 10,
    width: '72%',
  },
  skeletonTextNarrow: {
    borderRadius: 999,
    height: 10,
    marginTop: 4,
    width: '58%',
  },
  skeletonTextWide: {
    borderRadius: 999,
    height: 12,
    marginTop: 12,
    width: '78%',
  },
  skeletonTile: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 182,
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  tileWrap: {
    flex: 1,
  },
  trailingActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
});
