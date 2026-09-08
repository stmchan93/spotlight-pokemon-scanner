import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  CARD_GAMES,
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
  testID?: string;
};

type RailSpec = {
  game: CardGame;
  items: TopMoverItem[];
};

/**
 * Whether `TopTrendsBlock` will render anything for this input. Exposed so the
 * feed can lay out the seams around the block (which band draws, and where)
 * from the same rule the block itself uses, instead of guessing.
 */
export function hasTopTrendsContent(movers: TopMovers | null, loading: boolean): boolean {
  if (!movers) {
    return loading;
  }
  return movers.games.some((entry) => entry.items.length > 0);
}

/**
 * Home "Top Trends" (Figma 4969:4101 "Title content"): a title row, then one
 * horizontal rail of movers per game, in `CARD_GAMES` order. Games with no
 * movers are skipped rather than shown empty; while the FIRST read is in
 * flight (no cached payload) every game gets a loading rail so the section
 * holds its height instead of popping in.
 *
 * Renders nothing when there is nothing to show — the feed treats a null block
 * as "no section", so the composer/post seam falls back to its usual form.
 */
export function TopTrendsBlock({
  movers,
  loading,
  onPressCard,
  showBand = true,
  testID = 'top-trends',
}: TopTrendsBlockProps) {
  const theme = useSpotlightTheme();

  const rails = useMemo<RailSpec[]>(() => {
    if (!movers) {
      return loading ? CARD_GAMES.map((game) => ({ game, items: [] })) : [];
    }
    const byGame = new Map(movers.games.map((entry) => [entry.game, entry.items]));
    return CARD_GAMES.flatMap((game) => {
      const items = byGame.get(game) ?? [];
      return items.length > 0 ? [{ game, items }] : [];
    });
  }, [loading, movers]);

  if (rails.length === 0) {
    return null;
  }

  const windowDays = movers?.windowDays ?? DEFAULT_WINDOW_DAYS;

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
      <View style={styles.rails}>
        {rails.map(({ game, items }) => (
          <TopTrendsRail
            caption={gameDisplayName(game)}
            items={items.map((item) => toTopMoverTileProps(item, onPressCard, testID))}
            key={game}
            loading={!movers && loading}
            testID={`${testID}-rail-${game}`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Its own section between the composer and the first post: 16 above the
  // title, 16 between the last rail and the closing band. The band is a
  // BORDER, not a sibling — same reason as the composer's (post-card.tsx).
  section: {
    alignSelf: 'stretch',
    paddingBottom: 16,
    paddingTop: 16,
    width: '100%',
  },
  rails: {
    gap: 16,
  },
  // Title left, window caption right, on the feed's 16 page gutter (the list
  // itself is unpadded — rails bleed to the edge and inset their own tiles).
  titleRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
});
