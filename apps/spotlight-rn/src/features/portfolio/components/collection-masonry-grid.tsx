import { Linking, StyleSheet, View } from 'react-native';

import { InventoryCardTile } from '@spotlight/design-system';
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
 * Collection grid laid out as two fixed columns of self-contained cards
 * (Figma node 800-7656): each tile draws its own full border + rounded
 * corners around the entire card, and the cells are separated by gaps rather
 * than shared divider hairlines.
 */
export function CollectionMasonryGrid({
  entries,
  onPressEntry,
  onLongPressEntry,
  selectedEntryId,
  testID = 'collection-masonry-grid',
}: CollectionMasonryGridProps) {
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
            style={styles.row}
            testID={`${testID}-row-${rowIndex}`}
          >
            {Array.from({ length: COLUMNS }).map((_, colIndex) => {
              const entry = row[colIndex];
              return (
                <View
                  key={entry?.id ?? `row-${rowIndex}-col-${colIndex}`}
                  style={styles.cell}
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
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  row: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  cell: {
    flex: 1,
  },
});
