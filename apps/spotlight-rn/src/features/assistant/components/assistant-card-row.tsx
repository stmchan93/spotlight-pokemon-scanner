import { Pressable, StyleSheet, View } from 'react-native';

import type { AssistantCardRef } from '@spotlight/api-client';
import { PriceSparkline, radii, spacing, Text, TrendTriangle, useSpotlightTheme } from '@spotlight/design-system';

import { AssistantCardArt } from '@/features/assistant/components/assistant-card-art';
import { assistantCardMeta } from '@/features/assistant/components/assistant-card-tile';
import { assistantRangeCaption } from '@/features/assistant/components/assistant-price-chart';
import { formatCurrency, formatPercent } from '@/features/portfolio/components/portfolio-formatting';

// Same thumb ratio as the tile art (86x120) and the same sparkline size as the PDP price-trend rows.
const THUMB_WIDTH = 40;
const THUMB_HEIGHT = 56;
const THUMB_RADIUS = 4;
const SPARKLINE_WIDTH = 62;
const SPARKLINE_HEIGHT = 22;
const DELTA_TRIANGLE_SIZE = 6;

type AssistantCardRowsProps = {
  cards: AssistantCardRef[];
  onOpenCard: (cardId: string) => void;
  testID?: string;
};

/**
 * A multi-card price answer: one compact row per card (art, name, set · number,
 * price, change, small sparkline), all drawn the same way. Single-card answers
 * keep the big chart card instead.
 */
export function AssistantCardRows({ cards, onOpenCard, testID }: AssistantCardRowsProps) {
  const theme = useSpotlightTheme();
  return (
    <View
      style={[styles.list, { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 }]}
      testID={testID}
    >
      {cards.map((card, index) => (
        <View key={`${card.cardId}-${index}`}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} /> : null}
          <AssistantCardRow card={card} onPress={onOpenCard} testID={`assistant-card-${card.cardId}`} />
        </View>
      ))}
    </View>
  );
}

type AssistantCardRowProps = {
  card: AssistantCardRef;
  onPress: (cardId: string) => void;
  testID?: string;
};

export function AssistantCardRow({ card, onPress, testID }: AssistantCardRowProps) {
  const theme = useSpotlightTheme();
  const meta = assistantCardMeta(card);
  const sparkline = card.sparkline ?? null;
  const change = sparkline?.changePct ?? null;
  const direction = change == null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const changeColor = direction === 'up'
    ? theme.colors.green400
    : direction === 'down'
      ? theme.colors.red400
      : theme.colors.gray600;

  return (
    <Pressable
      accessibilityHint="Opens the card page"
      accessibilityLabel={`${card.name}, ${meta}`}
      accessibilityRole="button"
      onPress={() => onPress(card.cardId)}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      <AssistantCardArt
        grade={card.grade}
        grader={card.grader}
        height={THUMB_HEIGHT}
        imageUrl={card.imageSmallUrl}
        name={card.name}
        number={card.number}
        radius={THUMB_RADIUS}
        setName={card.setName}
        slabSize="sm"
        testID={testID}
        width={THUMB_WIDTH}
      />
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]}>
          {card.name}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
            {meta}
          </Text>
        ) : null}
        {sparkline ? (
          <Text
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.gray600 }]}
            testID={testID ? `${testID}-period` : undefined}
          >
            {assistantRangeCaption(sparkline.range)}
          </Text>
        ) : null}
      </View>
      {sparkline ? (
        <PriceSparkline
          height={SPARKLINE_HEIGHT}
          points={sparkline.points}
          testID={testID ? `${testID}-sparkline` : undefined}
          trendPct={change}
          width={SPARKLINE_WIDTH}
        />
      ) : null}
      <View style={styles.figures}>
        <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]} testID={testID ? `${testID}-price` : undefined}>
          {card.priceUsd != null ? formatCurrency(card.priceUsd, 'USD') : 'No price'}
        </Text>
        {change != null ? (
          <View style={styles.delta} testID={testID ? `${testID}-change` : undefined}>
            {direction !== 'flat' ? (
              <TrendTriangle color={changeColor} direction={direction} size={DELTA_TRIANGLE_SIZE} />
            ) : null}
            <Text style={[theme.typography.captionMedium, { color: changeColor }]}>{formatPercent(change)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
    paddingHorizontal: spacing.xs,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingVertical: spacing.xxs,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  figures: {
    alignItems: 'flex-end',
  },
  delta: {
    alignItems: 'center',
    columnGap: spacing.xxxs,
    flexDirection: 'row',
  },
});
