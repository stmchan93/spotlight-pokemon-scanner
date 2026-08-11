import { Linking, StyleSheet, View } from 'react-native';

import { InventoryCardTile, borderWidths, useSpotlightTheme } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';

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
 * Collection "card view" grid (Figma node 3670:47296 "Card Container"): two
 * fixed columns of plain tiles. The grid is full-bleed — no horizontal page
 * gutter and no inter-cell gaps — so each row's gray400 0.5pt rules run edge to
 * edge across the whole app width. Tiles render "plain" (no per-card shell
 * border/fill); the row draws the dividers.
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
  // A lone entry shouldn't render as a full-bleed ruled row — that reads as a
  // wide rectangle with one card stranded in the corner. Box it into a single
  // column-width tile so the hairline border hugs just that one item.
  if (entries.length === 1) {
    return (
      <View style={styles.grid} testID={testID}>
        <CollectionGridSingleRow
          entry={entries[0]}
          onPressEntry={onPressEntry}
          onLongPressEntry={onLongPressEntry}
          delayLongPress={delayLongPress}
          selectedEntryId={selectedEntryId}
          editMode={editMode}
          selectedIds={selectedIds}
          testID={testID}
        />
      </View>
    );
  }

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
  testID?: string;
};

/**
 * One full-bleed ruled row of up to {@link COLLECTION_GRID_COLUMNS} tiles.
 *
 * Figma (3670:47297 / 3670:47310) hangs the rules off each Card: every card
 * draws a 0.5pt top stroke and the left column draws the centre stroke on its
 * right edge. So the row draws its hairline on TOP, not the bottom — which is
 * what stops adjacent rows drawing two hairlines on the same boundary.
 *
 * THE LAST ROW ALSO CLOSES THE GRID, and that is not a return of the per-row
 * bottom rule this replaced. Interior boundaries still get exactly one line
 * (the next row's top stroke); only the final edge, which has no next row to
 * draw it, gets one here.
 *
 * It is load-bearing rather than decorative because of the CENTRE divider: it
 * is drawn even where the last row's second cell is empty (see below), so with
 * an odd card count and no closing rule that vertical hairline ran down beside
 * blank space and terminated in mid-air. Reported from a wishlist with three
 * cards. The card component in Figma cannot specify this — a card knows its own
 * strokes, not whether it is the last one.
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
  testID = 'collection-masonry-grid',
}: CollectionGridRowProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.row,
        { borderTopColor: theme.colors.gray400 },
        isLastRow
          ? { borderBottomColor: theme.colors.gray400, borderBottomWidth: borderWidths.rule }
          : null,
      ]}
      testID={`${testID}-row-${rowIndex}`}
    >
      {Array.from({ length: COLLECTION_GRID_COLUMNS }).map((_, colIndex) => {
        const entry = rowEntries[colIndex];
        return (
          <View
            key={entry?.id ?? `row-${rowIndex}-col-${colIndex}`}
            style={[
              styles.cell,
              // Middle vertical divider between the two columns. Figma draws it
              // as the LEFT card's right stroke; as the right cell's left
              // stroke it lands on the same pixel column. NOT gated on the cell
              // having an entry: an odd card count leaves the last row's second
              // cell empty, and skipping the rule there dropped the grid's
              // centre line for that row only — a visible break in a line every
              // other row draws.
              colIndex === 1
                ? { borderLeftColor: theme.colors.gray400, borderLeftWidth: borderWidths.rule }
                : null,
            ]}
          >
            {entry ? (
              <CollectionTileSlot
                entry={entry}
                delayLongPress={delayLongPress}
                onLongPress={onLongPressEntry}
                onPress={onPressEntry}
                selectable={editMode}
                selected={editMode ? !!selectedIds?.has(entry.id) : selectedEntryId === entry.id}
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
  testID?: string;
};

/**
 * The lone-entry layout: box the single tile at one column's width with a full
 * hairline border so it reads as a contained square, not a stretched row.
 */
export function CollectionGridSingleRow({
  entry,
  onPressEntry,
  onLongPressEntry,
  delayLongPress,
  selectedEntryId,
  editMode = false,
  selectedIds,
  testID = 'collection-masonry-grid',
}: CollectionGridSingleRowProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.singleRow}>
      <View style={[styles.singleCell, { borderColor: theme.colors.gray400 }]}>
        <CollectionTileSlot
          entry={entry}
          delayLongPress={delayLongPress}
          onLongPress={onLongPressEntry}
          onPress={onPressEntry}
          selectable={editMode}
          selected={editMode ? !!selectedIds?.has(entry.id) : selectedEntryId === entry.id}
          testIDPrefix={`${testID}-tile`}
        />
      </View>
    </View>
  );
}

type CollectionTileSlotProps = {
  entry: InventoryCardEntry;
  onPress: (entry: InventoryCardEntry) => void;
  onLongPress?: (entry: InventoryCardEntry) => void;
  delayLongPress?: number;
  selectable?: boolean;
  selected?: boolean;
  testIDPrefix: string;
};

function CollectionTileSlot({
  entry,
  onPress,
  onLongPress,
  delayLongPress,
  selectable,
  selected,
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
      priceLabel={entry.hasMarketPrice ? formatOptionalCurrency(entry.marketPrice, entry.currencyCode) : null}
      // Numeric price feeds the tile's penny guard (sub-$1 → no trend line).
      marketPrice={entry.hasMarketPrice ? entry.marketPrice : null}
      // No trend percent under the price — the since-added/30d trend UI moved
      // off the Collection screen (headed for the PDP).
      trendChangePercent={null}
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
    // Full-bleed: no horizontal gutter and no row gap, so each row's rules
    // run all the way to the app edges and stack into a continuous ruled grid.
    paddingVertical: 16,
  },
  row: {
    alignItems: 'stretch',
    borderTopWidth: borderWidths.rule,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
  },
  singleRow: {
    flexDirection: 'row',
  },
  singleCell: {
    // Box the lone tile at one column's width with a full rule border so it
    // reads as a contained square, not a stretched full-width row.
    borderWidth: borderWidths.rule,
    width: '50%',
  },
});
