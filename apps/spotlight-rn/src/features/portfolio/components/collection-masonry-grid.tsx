import { Linking, StyleSheet, View } from 'react-native';

import { InventoryCardTile, cardGrid } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  COLLECTION_TREND_ACCESS,
  SINCE_ADDED_SUFFIX,
} from '@/features/portfolio/collection-trend-access';

type CollectionMasonryGridProps = {
  entries: InventoryCardEntry[];
  onPressEntry: (entry: InventoryCardEntry) => void;
  onLongPressEntry?: (entry: InventoryCardEntry) => void;
  /** Long-press delay in ms (press-and-hold to open the card actions menu). */
  delayLongPress?: number;
  selectedEntryId?: string | null;
  /** True while the Collection is in multi-select edit mode. */
  editMode?: boolean;
  /** Ids selected for bulk action while {@link editMode} is active. */
  selectedIds?: Set<string>;
  testID?: string;
};

export const COLLECTION_GRID_COLUMNS = 2;

function isLiveOnEbay(entry: InventoryCardEntry): boolean {
  return typeof entry.listingUrl === 'string' && entry.listingUrl.trim().length > 0;
}

/**
 * Split inventory into fixed-width rows of {@link COLLECTION_GRID_COLUMNS} for
 * the collection "card view". Each row is rendered independently so the screen
 * can virtualize the grid one ruled row at a time.
 */
export function chunkCollectionGridRows(entries: InventoryCardEntry[]): InventoryCardEntry[][] {
  const rows: InventoryCardEntry[][] = [];
  for (let index = 0; index < entries.length; index += COLLECTION_GRID_COLUMNS) {
    rows.push(entries.slice(index, index + COLLECTION_GRID_COLUMNS));
  }
  return rows;
}

/**
 * Collection "card view" grid (Figma 5722:21021): two fixed columns of white
 * tiles on the gray-50 page, separated by `cardGrid.gap` instead of hairlines.
 * Full-bleed — no horizontal page gutter.
 */
export function CollectionMasonryGrid({
  entries,
  onPressEntry,
  onLongPressEntry,
  delayLongPress,
  selectedEntryId,
  editMode = false,
  selectedIds,
  testID = 'collection-masonry-grid',
}: CollectionMasonryGridProps) {
  const rows = chunkCollectionGridRows(entries);

  return (
    <View style={styles.grid} testID={testID}>
      {rows.map((rowEntries, rowIndex) => (
        <CollectionGridRow
          key={rowEntries[0]?.id ?? `row-${rowIndex}`}
          delayLongPress={delayLongPress}
          isLastRow={rowIndex === rows.length - 1}
          onLongPressEntry={onLongPressEntry}
          onPressEntry={onPressEntry}
          rowEntries={rowEntries}
          rowIndex={rowIndex}
          selectedEntryId={selectedEntryId}
          editMode={editMode}
          selectedIds={selectedIds}
          testID={testID}
        />
      ))}
    </View>
  );
}

type CollectionGridRowProps = {
  rowEntries: InventoryCardEntry[];
  rowIndex: number;
  /**
   * Close the grid under this row. See the note on {@link CollectionGridRow} —
   * only the LAST row gets it, and it is not the per-row bottom rule that used
   * to double every interior line.
   */
  isLastRow?: boolean;
  onPressEntry: (entry: InventoryCardEntry) => void;
  onLongPressEntry?: (entry: InventoryCardEntry) => void;
  /** Long-press delay in ms (press-and-hold to open the card actions menu). */
  delayLongPress?: number;
  selectedEntryId?: string | null;
  editMode?: boolean;
  selectedIds?: Set<string>;
  /** False hides the owned-quantity count (a watchlist holds no copies). */
  showQuantity?: boolean;
  testID?: string;
};

/**
 * One row of up to {@link COLLECTION_GRID_COLUMNS} tiles. Each row paints its
 * own top gap in the grid background, and the last row also its bottom gap, so
 * rows stacked in a virtualized list read as one continuous grid.
 */
export function CollectionGridRow({
  rowEntries,
  rowIndex,
  isLastRow = false,
  onPressEntry,
  onLongPressEntry,
  delayLongPress,
  selectedEntryId,
  editMode = false,
  selectedIds,
  showQuantity = true,
  testID = 'collection-masonry-grid',
}: CollectionGridRowProps) {
  return (
    <View
      style={[styles.row, isLastRow ? styles.lastRow : null]}
      testID={`${testID}-row-${rowIndex}`}
    >
      {Array.from({ length: COLLECTION_GRID_COLUMNS }).map((_, colIndex) => {
        const entry = rowEntries[colIndex];
        return (
          <View
            key={entry?.id ?? `row-${rowIndex}-col-${colIndex}`}
            // An empty trailing cell stays background so the gap reads as page.
            style={[styles.cell, entry ? styles.filledCell : null]}
          >
            {entry ? (
              <CollectionTileSlot
                entry={entry}
                delayLongPress={delayLongPress}
                onLongPress={onLongPressEntry}
                onPress={onPressEntry}
                selectable={editMode}
                selected={editMode ? !!selectedIds?.has(entry.id) : selectedEntryId === entry.id}
                showQuantity={showQuantity}
                testIDPrefix={`${testID}-tile`}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

type CollectionGridSingleRowProps = {
  entry: InventoryCardEntry;
  onPressEntry: (entry: InventoryCardEntry) => void;
  onLongPressEntry?: (entry: InventoryCardEntry) => void;
  /** Long-press delay in ms (press-and-hold to open the card actions menu). */
  delayLongPress?: number;
  selectedEntryId?: string | null;
  editMode?: boolean;
  selectedIds?: Set<string>;
  /** False hides the owned-quantity count (a watchlist holds no copies). */
  showQuantity?: boolean;
  testID?: string;
};

/** The lone-entry layout: one tile at column width, not a stretched row. */
export function CollectionGridSingleRow({
  entry,
  ...rowProps
}: CollectionGridSingleRowProps) {
  return <CollectionGridRow {...rowProps} isLastRow rowEntries={[entry]} rowIndex={0} />;
}

type CollectionTileSlotProps = {
  entry: InventoryCardEntry;
  onPress: (entry: InventoryCardEntry) => void;
  onLongPress?: (entry: InventoryCardEntry) => void;
  delayLongPress?: number;
  selectable?: boolean;
  selected?: boolean;
  showQuantity?: boolean;
  testIDPrefix: string;
};

function CollectionTileSlot({
  entry,
  onPress,
  onLongPress,
  delayLongPress,
  selectable,
  selected,
  showQuantity = true,
  testIDPrefix,
}: CollectionTileSlotProps) {
  const tileKind = entry.kind === 'graded' ? 'slab' : 'raw';

  const liveOnEbay = isLiveOnEbay(entry);
  const handleOpenListing = liveOnEbay
    ? () => {
        if (!entry.listingUrl) return;
        Linking.openURL(entry.listingUrl).catch((error) => {
          console.warn('[CollectionMasonryGrid] failed to open listing URL', error);
        });
      }
    : undefined;

  return (
    <InventoryCardTile
      bordered={false}
      imageUrl={getCardImageUrl(entry, 'small')}
      name={entry.name}
      setName={entry.setName ?? ''}
      cardNumber={entry.cardNumber ?? null}
      kind={tileKind}
      // Collection tiles intentionally omit the print variant (e.g. "Holofoil" /
      // "Reverse Holofoil") — it clutters the label and the condition/grade line
      // already carries the meaningful distinction.
      variantName={null}
      conditionLabel={tileKind === 'raw' ? entry.conditionLabel ?? null : null}
      graderLabel={tileKind === 'slab' ? entry.slabContext?.grader ?? null : null}
      gradeLabel={tileKind === 'slab' ? entry.slabContext?.grade ?? null : null}
      quantity={entry.quantity}
      showQuantity={showQuantity}
      priceLabel={entry.hasMarketPrice ? formatOptionalCurrency(entry.marketPrice, entry.currencyCode) : null}
      // Numeric price feeds the tile's penny guard (sub-$1 → no trend line).
      marketPrice={entry.hasMarketPrice ? entry.marketPrice : null}
      // Arrow + "since added" percent under the price; no sparkline in card view.
      trendChangeAmount={COLLECTION_TREND_ACCESS === 'hidden' ? null : entry.sinceAddedChangeAmount ?? null}
      formatTrendAmount={(value) => formatOptionalCurrency(value, entry.currencyCode) ?? `$${value.toFixed(2)}`}
      trendSuffix={SINCE_ADDED_SUFFIX}
      isFavorite={entry.isFavorite === true}
      showFavorite={false}
      selectable={selectable}
      selected={selected}
      onPress={() => onPress(entry)}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
      delayLongPress={delayLongPress}
      liveOnEbay={liveOnEbay}
      onOpenListing={handleOpenListing}
      testID={`${testIDPrefix}-${entry.id}`}
    />
  );
}

const styles = StyleSheet.create({
  grid: {
    backgroundColor: cardGrid.background,
  },
  row: {
    alignItems: 'stretch',
    backgroundColor: cardGrid.background,
    flexDirection: 'row',
    gap: cardGrid.gap,
    paddingTop: cardGrid.gap,
  },
  lastRow: {
    paddingBottom: cardGrid.gap,
  },
  cell: {
    flex: 1,
  },
  filledCell: {
    backgroundColor: cardGrid.tileFill,
    borderCurve: 'continuous',
    borderRadius: cardGrid.tileRadius,
    overflow: 'hidden',
  },
});
