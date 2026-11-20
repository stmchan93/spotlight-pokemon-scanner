import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AssistantCardRef } from '@spotlight/api-client';
import { AppText, PriceSparkline, Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { assistantRangeCaption } from '@/features/assistant/components/assistant-price-chart';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// The card image is 86x120 at a 4pt radius (Figma 6528:16786); the tile is the image's width.
const TILE_WIDTH = 86;
const ART_HEIGHT = 120;
const ART_RADIUS = 4;
const SPARKLINE_HEIGHT = 22;
const SPARKLINE_WIDTH = TILE_WIDTH;

/** "Celebi" + "XY Black Star Promos · XY111" + price + owned qty. USD only; null price = "No price". */
export function assistantCardMeta(card: AssistantCardRef): string {
  const slab = card.grader ? ` · ${[card.grader, card.grade].filter(Boolean).join(' ')}` : '';
  return [card.setName, card.number].filter(Boolean).join(' · ') + slab;
}

type AssistantCardTileProps = {
  card: AssistantCardRef;
  onPress: (cardId: string) => void;
  testID?: string;
};

export function AssistantCardTile({ card, onPress, testID }: AssistantCardTileProps) {
  const theme = useSpotlightTheme();
  const owned = card.quantityOwned ?? 0;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [card.imageSmallUrl]);
  const showImage = Boolean(card.imageSmallUrl) && !imageFailed;
  return (
    <Pressable
      accessibilityLabel={`${card.name}, ${assistantCardMeta(card)}`}
      accessibilityRole="button"
      onPress={() => onPress(card.cardId)}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.86 : 1 }]}
      testID={testID}
    >
      <View style={[styles.art, { backgroundColor: showImage ? theme.colors.gray100 : theme.colors.field }]}>
        {showImage ? (
          <CachedImage
            contentFit="contain"
            onError={() => setImageFailed(true)}
            style={styles.fill}
            testID={testID ? `${testID}-image` : undefined}
            uri={card.imageSmallUrl}
          />
        ) : (
          // Same "CARD" placeholder as the inventory tile and list rows.
          <AppText color="textSecondary" testID={testID ? `${testID}-placeholder` : undefined} variant="micro">
            CARD
          </AppText>
        )}
      </View>
      {/* Name + price stay under the art: replies don't list prices in text, the tiles carry them. */}
      <Text numberOfLines={2} style={[theme.typography.captionMedium, { color: theme.colors.gray900 }]}>
        {card.name}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]}>
        {assistantCardMeta(card)}
      </Text>
      {card.sparkline ? (
        // Why a "near lows"/"new highs" card was surfaced: its recent move, period labelled.
        <View style={styles.sparkline} testID={testID ? `${testID}-sparkline` : undefined}>
          <PriceSparkline
            height={SPARKLINE_HEIGHT}
            points={card.sparkline.points}
            trendPct={card.sparkline.changePct}
            width={SPARKLINE_WIDTH}
          />
          <Text
            numberOfLines={1}
            style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]}
            testID={testID ? `${testID}-sparkline-period` : undefined}
          >
            {assistantRangeCaption(card.sparkline.range)}
          </Text>
        </View>
      ) : null}
      <View style={styles.footer}>
        <Text style={theme.typography.labelStrong} testID={testID ? `${testID}-price` : undefined}>
          {card.priceUsd != null ? formatCurrency(card.priceUsd, 'USD') : 'No price'}
        </Text>
        {owned > 0 ? (
          <Text style={[theme.typography.cardMeta, { color: theme.colors.purple500 }]}>
            {`Own ×${owned}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: spacing.xxxs,
    width: TILE_WIDTH,
  },
  art: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: ART_RADIUS,
    height: ART_HEIGHT,
    justifyContent: 'center',
    marginBottom: spacing.xxxs,
    overflow: 'hidden',
    width: '100%',
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  sparkline: {
    gap: spacing.xxxs,
  },
  footer: {
    alignItems: 'center',
    columnGap: spacing.xxxs,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
});
