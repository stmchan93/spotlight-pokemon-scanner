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
 * Collection grid laid out as a flat ruled grid (Figma node 813-16133): two
 * fixed columns split into aligned rows, separated by gray100 hairlines — a
 * vertical divider between the columns (each right cell's left border) and a
 * horizontal divider between rows. Tiles render "plain" (no per-card border or
 * rounding); the grid draws all the dividers.
 */
export function CollectionMasonryGrid({
  entries,
  onPressEntry,
  onLongPressEntry,
  selectedEntryId,
  testID = 'collection-masonry-grid',
}: CollectionMasonryGridProps) {
  const theme = useSpotlightTheme();

  const rows: InventoryCardEntry[][] = [];
  for (let index = 0; index < entries.length; index += COLUMNS) {
    rows.push(entries.slice(index, index + COLUMNS));
  }

  return (
    <View style={styles.grid} testID={testID}>
      {rows.map((row, rowIndex) => {
        const isLastRow = rowIndex === rows.length - 1;
        return (
          <View
            key={row[0]?.id ?? `row-${rowIndex}`}
            style={[
              styles.row,
              isLastRow
                ? null
                : { borderBottomColor: theme.colors.gray100, borderBottomWidth: 1 },
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
                    colIndex === 0
                      ? null
                      : { borderLeftColor: theme.colors.gray100, borderLeftWidth: 1 },
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
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  row: {
    alignItems: 'stretch',
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
  },
});
