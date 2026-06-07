import { Linking, StyleSheet, View } from 'react-native';

import { InventoryCardTile, useSpotlightTheme } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';
import { formatCurrency, formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';

type CollectionMasonryGridProps = {
  entries: InventoryCardEntry[];
  onPressEntry: (entry: InventoryCardEntry) => void;
  onLongPressEntry?: (entry: InventoryCardEntry) => void;
  selectedEntryId?: string | null;
  testID?: string;
};

const COLUMNS = 2;

function isLiveOnEbay(entry: InventoryCardEntry): boolean {
  return typeof entry.listingUrl === 'string' && entry.listingUrl.trim().length > 0;
}

/**
 * Collection "card view" grid (Figma node 800-7368): two fixed columns of
 * plain tiles. The grid is full-bleed — no horizontal page gutter and no
 * inter-cell gaps — so each row's gray100 top/bottom hairlines run edge to
 * edge across the whole app width. Tiles render "plain" (no per-card shell
 * border/fill); the row draws the dividers.
 */
export function CollectionMasonryGrid({
  entries,
  onPressEntry,
  onLongPressEntry,
  selectedEntryId,
  testID = 'collection-masonry-grid',
}: CollectionMasonryGridProps) {
  const theme = useSpotlightTheme();

  // A lone entry shouldn't render as a full-bleed ruled row — that reads as a
  // wide rectangle with one card stranded in the corner. Box it into a single
  // column-width tile so the hairline border hugs just that one item.
  const soleEntry = entries.length === 1 ? entries[0] : null;
  if (soleEntry) {
    return (
      <View style={styles.grid} testID={testID}>
        <View style={styles.singleRow}>
          <View style={[styles.singleCell, { borderColor: theme.colors.gray100 }]}>
            <CollectionTileSlot
              entry={soleEntry}
              onPress={onPressEntry}
              onLongPress={onLongPressEntry}
              selected={selectedEntryId === soleEntry.id}
              testIDPrefix={`${testID}-tile`}
            />
          </View>
        </View>
      </View>
    );
  }

  const rows: InventoryCardEntry[][] = [];
  for (let index = 0; index < entries.length; index += COLUMNS) {
    rows.push(entries.slice(index, index + COLUMNS));
  }

  return (
    <View style={styles.grid} testID={testID}>
      {rows.map((row, rowIndex) => {
        return (
          <View
            key={row[0]?.id ?? `row-${rowIndex}`}
            style={[
              styles.row,
              { borderBottomColor: theme.colors.gray100 },
              // Single hairlines: only the first row draws a top border; every
              // row draws its bottom border, so adjacent rows share one 1px
              // line instead of stacking two.
              rowIndex === 0
                ? { borderTopColor: theme.colors.gray100, borderTopWidth: 1 }
                : null,
            ]}
            testID={`${testID}-row-${rowIndex}`}
          >
            {Array.from({ length: COLUMNS }).map((_, colIndex) => {
              const entry = row[colIndex];
              return (
                <View
                  key={entry?.id ?? `row-${rowIndex}-col-${colIndex}`}
                  style={[
                    styles.cell,
                    // Middle vertical divider between the two columns.
                    colIndex === 1 && entry
                      ? { borderLeftColor: theme.colors.gray100, borderLeftWidth: 1 }
                      : null,
                  ]}
                >
                  {entry ? (
                    <CollectionTileSlot
                      entry={entry}
                      onPress={onPressEntry}
                      onLongPress={onLongPressEntry}
                      selected={selectedEntryId === entry.id}
                      testIDPrefix={`${testID}-tile`}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

type CollectionTileSlotProps = {
  entry: InventoryCardEntry;
  onPress: (entry: InventoryCardEntry) => void;
  onLongPress?: (entry: InventoryCardEntry) => void;
  selected?: boolean;
  testIDPrefix: string;
};

function CollectionTileSlot({
  entry,
  onPress,
  onLongPress,
  selected,
  testIDPrefix,
}: CollectionTileSlotProps) {
  const tileKind = entry.kind === 'graded' ? 'slab' : 'raw';
  const dayDelta = entry.dayChangeAmount ?? null;
  const hasDelta = dayDelta != null && dayDelta !== 0;
  const dayChangeLabel = hasDelta
    ? formatCurrency(Math.abs(dayDelta), entry.currencyCode)
    : null;
  const dayChangeDirection = hasDelta ? (dayDelta > 0 ? 'up' : 'down') : null;

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
      conditionLabel={tileKind === 'raw' ? entry.conditionLabel ?? null : null}
      graderLabel={tileKind === 'slab' ? entry.slabContext?.grader ?? null : null}
      gradeLabel={tileKind === 'slab' ? entry.slabContext?.grade ?? null : null}
      quantity={entry.quantity}
      priceLabel={entry.hasMarketPrice ? formatOptionalCurrency(entry.marketPrice, entry.currencyCode) : null}
      dayChangeLabel={dayChangeLabel}
      dayChangeDirection={dayChangeDirection}
      isFavorite={entry.isFavorite === true}
      showFavorite={false}
      selected={selected}
      onPress={() => onPress(entry)}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
      liveOnEbay={liveOnEbay}
      onOpenListing={handleOpenListing}
      testID={`${testIDPrefix}-${entry.id}`}
    />
  );
}

const styles = StyleSheet.create({
  grid: {
    // Full-bleed: no horizontal gutter and no row gap, so each row's hairlines
    // run all the way to the app edges and stack into a continuous ruled grid.
    paddingVertical: 16,
  },
  row: {
    alignItems: 'stretch',
    borderBottomWidth: 1,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
  },
  singleRow: {
    flexDirection: 'row',
  },
  singleCell: {
    // Box the lone tile at one column's width with a full hairline border so
    // it reads as a contained square, not a stretched full-width row.
    borderWidth: 1,
    width: '50%',
  },
});
