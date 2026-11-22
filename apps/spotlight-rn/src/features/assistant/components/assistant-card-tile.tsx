import { Pressable, StyleSheet, View } from 'react-native';

import type { AssistantCardRef } from '@spotlight/api-client';
import { PriceSparkline, Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { AssistantCardArt } from '@/features/assistant/components/assistant-card-art';
import { assistantRangeCaption } from '@/features/assistant/components/assistant-price-chart';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// The card image is 86x120 at a 4pt radius (Figma 6528:16786); the tile is the image's width.
// A slab fits the same 120pt height in its case, centered.
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
  /** Choice tiles: long-press opens the card page (tap picks it). */
  onLongPress?: (cardId: string) => void;
  /** Caption under a tap-to-pick tile, e.g. "Tap to pick". */
  pickHint?: string;
  testID?: string;
};

export function AssistantCardTile({ card, onPress, onLongPress, pickHint, testID }: AssistantCardTileProps) {
  const theme = useSpotlightTheme();
  const owned = card.quantityOwned ?? 0;
  return (
    <Pressable
      accessibilityLabel={`${card.name}, ${assistantCardMeta(card)}`}
      accessibilityHint={pickHint ? `${pickHint}. Long press to open the card.` : undefined}
      accessibilityRole="button"
      delayLongPress={350}
      onLongPress={onLongPress ? () => onLongPress(card.cardId) : undefined}
      onPress={() => onPress(card.cardId)}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.86 : 1 }]}
      testID={testID}
    >
      <View style={styles.art}>
        <AssistantCardArt
          grade={card.grade}
          grader={card.grader}
          height={ART_HEIGHT}
          imageUrl={card.imageSmallUrl}
          name={card.name}
          number={card.number}
          radius={ART_RADIUS}
          setName={card.setName}
          slabSize="md"
          testID={testID}
          width={TILE_WIDTH}
        />
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
      {pickHint ? (
        <Text
          numberOfLines={1}
          style={[theme.typography.cardMeta, { color: theme.colors.purple500 }]}
          testID={testID ? `${testID}-pick-hint` : undefined}
        >
          {pickHint}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: spacing.xxxs,
    width: TILE_WIDTH,
  },
  art: {
    marginBottom: spacing.xxxs,
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
