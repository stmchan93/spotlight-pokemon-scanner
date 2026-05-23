import { Linking } from 'react-native';
import { StyleSheet, View } from 'react-native';

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

const PLAIN_TILE_HEIGHT = 244;
const LIVE_ON_EBAY_TILE_HEIGHT = 282;

function isLiveOnEbay(entry: InventoryCardEntry): boolean {
  return typeof entry.listingUrl === 'string' && entry.listingUrl.trim().length > 0;
}

export function CollectionMasonryGrid({
  entries,
  onPressEntry,
  onLongPressEntry,
  selectedEntryId,
  testID = 'collection-masonry-grid',
}: CollectionMasonryGridProps) {
  const left: InventoryCardEntry[] = [];
  const right: InventoryCardEntry[] = [];
  let leftHeight = 0;
  let rightHeight = 0;

  for (const entry of entries) {
    const tileHeight = isLiveOnEbay(entry) ? LIVE_ON_EBAY_TILE_HEIGHT : PLAIN_TILE_HEIGHT;
    if (leftHeight <= rightHeight) {
      left.push(entry);
      leftHeight += tileHeight;
    } else {
      right.push(entry);
      rightHeight += tileHeight;
    }
  }

  return (
    <View style={styles.grid} testID={testID}>
      <View style={styles.column} testID={`${testID}-col-left`}>
        {left.map((entry) => (
          <CollectionTileSlot
            key={entry.id}
            entry={entry}
            onPress={onPressEntry}
            onLongPress={onLongPressEntry}
            selected={selectedEntryId === entry.id}
            testIDPrefix={`${testID}-tile`}
          />
        ))}
      </View>
      <View style={styles.column} testID={`${testID}-col-right`}>
        {right.map((entry) => (
          <CollectionTileSlot
            key={entry.id}
            entry={entry}
            onPress={onPressEntry}
            onLongPress={onLongPressEntry}
            selected={selectedEntryId === entry.id}
            testIDPrefix={`${testID}-tile`}
          />
        ))}
      </View>
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
    <View style={styles.tileWrap}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  column: {
    flex: 1,
    gap: 12,
  },
  tileWrap: {
    width: '100%',
  },
});
