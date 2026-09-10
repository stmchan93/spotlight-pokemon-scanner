import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  gameDisplayName,
  type CardGame,
  type TopMoverItem,
  type TopMovers,
} from '@spotlight/api-client';
import {
  Text,
  TopTrendsRail,
  useSpotlightTheme,
  type TopMoverTileProps,
} from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/** The window the copy promises when no payload has landed yet. */
const DEFAULT_WINDOW_DAYS = 30;
/**
 * One slide per game. The carousel no longer moves on its own (user request
 * 2026-09-10 — 5s then 10s both felt like it was yanking the tile away); the
 * user swipes, and the pagination sits solid. The rail keeps the timer so a
 * caller can still opt in.
 */
export const TOP_TRENDS_AUTO_ADVANCE_MS = 0;

/**
 * Signed percent for the tile's change chip. One decimal in the normal range
 * (`+12.5%`) and none once the move is three digits (`+218%`) — the decimal
 * stops carrying information there and pushes the chip over its width.
 */
export function formatChangeLabel(changePercent: number): string {
  const sign = changePercent > 0 ? '+' : changePercent < 0 ? '-' : '';
  const magnitude = Math.abs(changePercent);
  const digits = magnitude >= 100 ? 0 : 1;
  return `${sign}${magnitude.toFixed(digits)}%`;
}

/**
 * "SV8 · Surging Sparks", with " · JP" appended for a Japanese printing so a
 * JP mover is never mistaken for its (usually pricier) English twin.
 */
export function formatMoverSubtitle(item: Pick<TopMoverItem, 'setCode' | 'setName' | 'language'>): string {
  const parts = [item.setCode, item.setName].filter(Boolean);
  if (item.language === 'Japanese') {
    parts.push('JP');
  }
  return parts.join(' · ');
}

export function toTopMoverTileProps(
  item: TopMoverItem,
  onPressCard: ((cardId: string) => void) | undefined,
  testID: string,
): TopMoverTileProps & { key: string } {
  return {
    key: `${item.game}:${item.cardId}`,
    imageUrl: item.imageUrl,
    name: item.name,
    subtitle: formatMoverSubtitle(item),
    changeLabel: formatChangeLabel(item.changePercent),
    changePercent: item.changePercent,
    priceLabel: formatCurrency(item.priceNow, item.currencyCode),
    fromLabel: `from ${formatCurrency(item.priceThen, item.currencyCode)}`,
    sparkPoints: item.sparkPoints,
    onPress: onPressCard ? () => onPressCard(item.cardId) : undefined,
    testID: `${testID}-tile-${item.cardId}`,
  };
}

export type TopTrendsSlide = { game: CardGame; item: TopMoverItem };

/**
 * One slide per game — that game's biggest gainer — ordered by the size of
 * the gain, so the first thing on screen is the biggest mover across the
 * whole catalog. Games with no eligible mover contribute no slide.
 */
export function topTrendsSlides(movers: TopMovers | null): TopTrendsSlide[] {
  if (!movers) {
    return [];
  }
  return movers.games
    .flatMap((entry) => (entry.items[0] ? [{ game: entry.game, item: entry.items[0] }] : []))
    .sort((a, b) => b.item.changePercent - a.item.changePercent);
}

export type TopTrendsBlockProps = {
  movers: TopMovers | null;
  loading: boolean;
  onPressCard?: (cardId: string) => void;
  /**
   * Draw the closing 4pt band. The feed hands the band to its first cell once
   * posts exist (Android shaves anything the list header draws on that seam),
   * so it turns this off there; everywhere else the block closes itself.
   */
  showBand?: boolean;
  /** Auto-advance period; 0 disables (tests, screenshots). */
  autoAdvanceIntervalMs?: number;
  testID?: string;
};

/**
 * Whether `TopTrendsBlock` will render anything for this input. Exposed so the
 * feed can lay out the seams around the block (which band draws, and where)
 * from the same rule the block itself uses, instead of guessing. Loading
 * never counts: the section appears only once there is a mover to show, so it
 * can't flash a placeholder and then vanish on an empty payload.
 */
export function hasTopTrendsContent(movers: TopMovers | null, _loading: boolean): boolean {
  return topTrendsSlides(movers).length > 0;
}

/**
 * Home "Top Trends" (Figma 4969:4101 "Title content"): a title row, a caption
 * naming the game on screen, and ONE carousel with a slide per game — each
 * game's top gainer, biggest first — that flips to the next game every 10s
 * and can be swiped by hand, looping end to start in both directions.
 *
 * Renders nothing when there is nothing to show — the feed treats a null block
 * as "no section", so the composer/post seam falls back to its usual form.
 */
export function TopTrendsBlock({
  movers,
  loading: _loading,
  onPressCard,
  showBand = true,
  autoAdvanceIntervalMs = TOP_TRENDS_AUTO_ADVANCE_MS,
  testID = 'top-trends',
}: TopTrendsBlockProps) {
  const theme = useSpotlightTheme();
  const slides = useMemo(() => topTrendsSlides(movers), [movers]);
  const [activeIndex, setActiveIndex] = useState(0);

  if (slides.length === 0) {
    return null;
  }

  const windowDays = movers?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const activeSlide = slides[Math.min(activeIndex, slides.length - 1)];

  return (
    <View
      style={[
        styles.section,
        {
          borderBottomColor: theme.colors.gray100,
          borderBottomWidth: showBand ? 4 : 0,
        },
      ]}
      testID={testID}
    >
      <View style={styles.titleRow}>
        <Text style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>
          Top Trends
        </Text>
        <Text
          style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
          testID={`${testID}-window`}
        >
          past {windowDays} days
        </Text>
      </View>
      <TopTrendsRail
        autoAdvanceIntervalMs={autoAdvanceIntervalMs}
        caption={gameDisplayName(activeSlide.game)}
        items={slides.map(({ item }) => toTopMoverTileProps(item, onPressCard, testID))}
        onActiveIndexChange={setActiveIndex}
        testID={`${testID}-rail`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Its own section between the composer and the first post: 16 above the
  // title, 16 between the rail and the closing band. The band is a BORDER,
  // not a sibling — same reason as the composer's (post-card.tsx).
  section: {
    alignSelf: 'stretch',
    paddingBottom: 16,
    paddingTop: 16,
    width: '100%',
  },
  // Title left, window caption right, on the feed's 16 page gutter (the list
  // itself is unpadded — the rail bleeds to the edge and insets its own tiles).
  titleRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 16,
  },
});
