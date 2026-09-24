import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { HotCard, HotCards } from '@spotlight/api-client';
import {
  AppText,
  DeltaPill,
  RankBadge,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';
import { formatCompactCurrency } from '@/features/portfolio/components/portfolio-formatting';

/** "4.2× usual checks"; a flat ratio falls back to the head count. */
export function hotCardAttentionLabel(card: Pick<HotCard, 'baselineRatio' | 'distinctUsers'>): string {
  if (card.baselineRatio >= 1.1) {
    return `${card.baselineRatio.toFixed(1)}× usual checks`;
  }
  return `${card.distinctUsers} collectors checking`;
}

/** "Aquapolis · 149". */
export function hotCardSubtitle(card: Pick<HotCard, 'setName' | 'number'>): string {
  return [card.setName, card.number].filter(Boolean).join(' · ');
}

/**
 * Same rule the block renders by. An ineligible payload (not enough traffic
 * yet) counts as empty, so the block stays hidden until the app is busy.
 */
export function hasHotCardsContent(hot: HotCards | null): boolean {
  return hot != null && hot.eligible && hot.items.length > 0;
}

export type HotCardsBlockProps = {
  hot: HotCards | null;
  onPressCard?: (cardId: string) => void;
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Hot on Ekalight": the cards collectors are checking and
 * scanning most right now, as a ranked horizontal rail.
 */
export function HotCardsBlock({
  hot,
  onPressCard,
  showBand = true,
  testID = 'hot-cards',
}: HotCardsBlockProps) {
  const theme = useSpotlightTheme();
  if (!hot || !hasHotCardsContent(hot)) {
    return null;
  }

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <View style={styles.gutter}>
        <MetaBlockHeader
          caption={`most checked · ${hot.windowHours}h`}
          testID={`${testID}-header`}
          title="Hot on Ekalight"
        />
      </View>
      <AppText color="gray600" style={styles.subtitle} variant="captionMedium">
        What collectors are scanning and looking up right now
      </AppText>
      <ScrollView
        contentContainerStyle={styles.rail}
        horizontal
        showsHorizontalScrollIndicator={false}
        testID={`${testID}-rail`}
      >
        {hot.items.map((card, index) => (
          <HotCardTile
            card={card}
            key={card.cardId}
            onPress={onPressCard ? () => onPressCard(card.cardId) : undefined}
            rank={index + 1}
            testID={`${testID}-tile-${card.cardId}`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function HotCardTile({
  card,
  rank,
  onPress,
  testID,
}: {
  card: HotCard;
  rank: number;
  onPress?: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityLabel={`${rank}. ${card.name}, ${hotCardAttentionLabel(card)}`}
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      <View
        style={[
          styles.art,
          {
            backgroundColor: theme.colors.gray200,
            borderCurve: 'continuous',
            borderRadius: theme.layout.heroArtRadius,
          },
        ]}
      >
        {card.imageUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: card.imageUrl }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <RankBadge rank={rank} style={styles.rank} testID={`${testID}-rank`} />
      </View>
      <AppText color="gray900" ellipsizeMode="tail" numberOfLines={1} variant="bodyMedium">
        {card.name}
      </AppText>
      <AppText color="gray700" numberOfLines={1} variant="cardMeta">
        {hotCardSubtitle(card)}
      </AppText>
      {card.priceNow != null ? (
        <View style={styles.priceRow}>
          <AppText color="gray900" variant="priceCaption">
            {formatCompactCurrency(card.priceNow, card.currencyCode)}
          </AppText>
          {card.changePercent7d != null ? (
            <DeltaPill
              changePercent={card.changePercent7d}
              label={formatSignedPercent(card.changePercent7d)}
              testID={`${testID}-change`}
            />
          ) : null}
        </View>
      ) : null}
      <AppText color="brandStrong" numberOfLines={1} testID={`${testID}-attention`} variant="cardMetaStrong">
        {hotCardAttentionLabel(card)}
      </AppText>
    </Pressable>
  );
}

const TILE_WIDTH = 112;

const styles = StyleSheet.create({
  section: {
    alignSelf: 'stretch',
    paddingVertical: 16,
    width: '100%',
  },
  gutter: {
    paddingHorizontal: 16,
  },
  subtitle: {
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  // The list is unpadded; the rail bleeds to the edge and insets its tiles.
  rail: {
    gap: 12,
    paddingHorizontal: 16,
  },
  tile: {
    gap: 6,
    width: TILE_WIDTH,
  },
  art: {
    height: 156,
    overflow: 'hidden',
    width: TILE_WIDTH,
  },
  rank: {
    left: 6,
    position: 'absolute',
    top: 6,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
});
