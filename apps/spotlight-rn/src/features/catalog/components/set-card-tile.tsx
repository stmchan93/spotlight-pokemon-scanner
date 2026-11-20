import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';
import {
  QuantityStepper,
  Text,
  cardGrid,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { setCardNumberLabel } from '@/features/catalog/set-progress';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type SetCardTileProps = {
  card: CatalogSearchResult;
  /** Which column — Figma rounds only the tile's inner corners (6425:3339 / 6425:3350). */
  column: 'left' | 'right';
  /** A +/− for this card is in flight; the stepper ignores taps until it settles. */
  isPending?: boolean;
  onPress: (card: CatalogSearchResult) => void;
  onIncrement: (card: CatalogSearchResult) => void;
  onDecrement: (card: CatalogSearchResult) => void;
};

// Figma card art slot: 96 wide at the trading-card ratio (96×134).
const ART_WIDTH = 96;
const ART_ASPECT = 0.716;

/**
 * One card in the set page's completion grid (Figma 6425:3339): art, name,
 * "#001/120", its market price (when priced), and a − QTY + stepper. A card you don't own is FADED — art and
 * text at `cardGrid.unownedOpacity` — with no "missing" label; the stepper
 * stays at full strength so + reads as the way in.
 */
export const SetCardTile = memo(function SetCardTile({
  card,
  column,
  isPending = false,
  onPress,
  onIncrement,
  onDecrement,
}: SetCardTileProps) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);
  const quantity = card.ownedQuantity ?? 0;
  const isOwned = quantity > 0;
  const imageUrl = card.smallImageUrl ?? card.imageUrl;

  return (
    <View
      style={[
        styles.tile,
        column === 'left' ? styles.tileLeft : styles.tileRight,
        { backgroundColor: cardGrid.tileFill },
      ]}
      testID={`set-card-${card.cardId}`}
    >
      <Pressable
        accessibilityLabel={card.name}
        accessibilityRole="button"
        onPress={() => onPress(card)}
        style={({ pressed }) => [
          styles.identity,
          { opacity: (isOwned ? 1 : cardGrid.unownedOpacity) * (pressed ? 0.88 : 1) },
        ]}
        testID={`set-card-${card.cardId}-open`}
      >
        <View style={[styles.artFrame, { backgroundColor: theme.colors.gray100 }]}>
          {imageUrl && !hasImageError ? (
            <Image
              onError={() => setHasImageError(true)}
              resizeMode="cover"
              source={{ uri: imageUrl }}
              style={styles.art}
            />
          ) : null}
        </View>
        <View style={styles.details}>
          <Text
            numberOfLines={1}
            style={[styles.centered, theme.typography.titleXsmall, { color: theme.colors.gray900 }]}
          >
            {card.name}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.centered, theme.typography.caption, { color: theme.colors.gray600 }]}
          >
            {setCardNumberLabel(card.cardNumber)}
          </Text>
          {/* Market price under the number (USD; the endpoint serves USD only). Hidden when unpriced. */}
          {card.marketPrice != null ? (
            <Text
              numberOfLines={1}
              style={[styles.centered, theme.typography.priceCaption, { color: theme.colors.gray900 }]}
              testID={`set-card-${card.cardId}-price`}
            >
              {formatCurrency(card.marketPrice, 'USD')}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <QuantityStepper
        decrementLabel={`Remove one ${card.name}`}
        disabled={isPending}
        formatValue={(value) => `QTY: ${value}`}
        incrementLabel={`Add one ${card.name}`}
        onChange={(next) => (next > quantity ? onIncrement(card) : onDecrement(card))}
        testID={`set-card-${card.cardId}-stepper`}
        value={quantity}
        variant="tile"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  // RN Image can't take borderCurve; the frame clips the art.
  art: {
    height: '100%',
    width: '100%',
  },
  artFrame: {
    aspectRatio: ART_ASPECT,
    borderCurve: 'continuous',
    borderRadius: cardGrid.tileRadius,
    overflow: 'hidden',
    width: ART_WIDTH,
  },
  centered: {
    textAlign: 'center',
    width: '100%',
  },
  details: {
    alignItems: 'center',
    gap: 6,
    width: '100%',
  },
  identity: {
    alignItems: 'center',
    gap: 10,
    width: '100%',
  },
  tile: {
    alignItems: 'center',
    flex: 1,
    gap: 10,
    overflow: 'hidden',
    padding: spacing.xs,
  },
  tileLeft: {
    borderBottomRightRadius: cardGrid.tileRadius,
    borderCurve: 'continuous',
    borderTopRightRadius: cardGrid.tileRadius,
  },
  tileRight: {
    borderBottomLeftRadius: cardGrid.tileRadius,
    borderCurve: 'continuous',
    borderTopLeftRadius: cardGrid.tileRadius,
  },
});
