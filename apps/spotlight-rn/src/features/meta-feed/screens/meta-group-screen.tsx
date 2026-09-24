import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_CARD_GAME,
  type CardGame,
  type MetaCard,
  type MetaExposure,
  type MetaGroupDetail,
  type MetaLaneFilter,
} from '@spotlight/api-client';
import {
  PriceSparkline,
  SkeletonBlock,
  StateCard,
  Text,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { META_DIRECTION_LABEL } from '@/features/meta-feed/components/meta-bar-list';
import { useMetaExposure } from '@/features/meta-feed/hooks/use-meta-feed';
import { MetaCardRow } from '@/features/meta-feed/screens/components/meta-card-row';
import {
  formatCount,
  formatSignedCompactUsd,
  formatSignedPercent,
  gradeLabel,
} from '@/features/meta-feed/screens/components/meta-format';
import { MetaPageHeader, useSignedColor } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useMetaGroupPageData } from '@/features/meta-feed/screens/components/meta-page-data';

/** Owned cards shown before "See all N ›". */
export const GROUP_OWNED_PREVIEW = 2;
const CHART_HEIGHT = 70;
const OWNED_LABEL = 'In your collection';

/**
 * Identity of a priced card line: the same card raw and as a PSA 10 are
 * different holdings, so "In your collection" matches on grade too.
 */
export function metaCardKey(card: Pick<MetaCard, 'cardId' | 'lane' | 'grader' | 'grade'>): string {
  return [card.cardId, card.lane, card.grader ?? '', card.grade ?? ''].join('|');
}

/** "Ho-oh · PSA 10". */
export function metaCardTitle(card: MetaCard): string {
  const grade = gradeLabel(card.grader, card.grade);
  return grade ? `${card.name} · ${grade}` : card.name;
}

/** "Skyridge · pop 41". */
export function metaCardMeta(card: MetaCard): string | null {
  const parts = [card.setName, card.population != null ? `pop ${formatCount(card.population)}` : null];
  return parts.filter(Boolean).join(' · ') || null;
}

export type MetaGroupScreenProps = {
  groupKey: string;
  game?: CardGame;
  windowDays?: number;
  lane?: MetaLaneFilter;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
};

/**
 * Group page (docs/meta-feed-mockup/v2/GroupV6.dc.html): one rising or cooling
 * group — its move and chart, the viewer's cards in it, and the cards driving
 * it. Opened from any Meta pulse / Meta page bar row.
 */
export function MetaGroupScreen({
  groupKey,
  game = DEFAULT_CARD_GAME,
  windowDays = 7,
  lane,
  onBack,
  onOpenCard,
}: MetaGroupScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const { data: detail, refresh, status } = useMetaGroupPageData({ game, groupKey, lane, windowDays });
  const { data: exposure, refresh: refreshExposure } = useMetaExposure({ game, windowDays });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), refreshExposure()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshExposure]);

  let body;
  if (detail) {
    body = <GroupBody detail={detail} exposure={exposure} onOpenCard={onOpenCard} />;
  } else if (status === 'loading') {
    body = (
      <View style={styles.skeleton} testID="meta-group-loading">
        <SkeletonBlock height={18} width="50%" />
        <SkeletonBlock height={30} width="80%" />
        <SkeletonBlock height={CHART_HEIGHT + 48} radius={radii.md} />
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonBlock key={index} height={67} radius={radii.sm} />
        ))}
      </View>
    );
  } else {
    body = (
      <View style={styles.stateWrap}>
        {status === 'disabled' ? (
          <StateCard
            message="This group isn't tracked right now. Check the Meta page for this week's groups."
            testID="meta-group-disabled"
            title="Group not available"
            variant="muted"
          />
        ) : (
          <StateCard
            actionLabel="Try again"
            actionTestID="meta-group-retry"
            message="We couldn't load this group. Check your connection and try again."
            onActionPress={() => void refresh()}
            testID="meta-group-error"
            title="Couldn't load this group"
          />
        )}
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader onBack={onBack} testID="meta-group-header" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        testID="meta-group-scroll"
      >
        {body}
      </ScrollView>
    </SafeAreaView>
  );
}

function GroupBody({
  detail,
  exposure,
  onOpenCard,
}: {
  detail: MetaGroupDetail;
  exposure: MetaExposure | null;
  onOpenCard: (cardId: string) => void;
}) {
  const theme = useSpotlightTheme();
  const { group } = detail;
  const rising = group.medianChangePercent >= 0;
  const color = useSignedColor(group.medianChangePercent);
  const [chartWidth, setChartWidth] = useState(0);
  const owned = exposure && exposure.game === detail.game ? exposure.groups[group.groupKey] ?? null : null;
  const ownedKeys = new Set((owned?.ownedCards ?? []).map(metaCardKey));

  return (
    <View testID="meta-group-content">
      <View style={[styles.hero, { borderBottomColor: theme.colors.gray100 }]} testID="meta-group-hero">
        <Text style={[theme.typography.feedEyebrow, { color }]} testID="meta-group-direction">
          {`${META_DIRECTION_LABEL[rising ? 'up' : 'down']} · PAST ${detail.windowDays} DAYS`}
        </Text>
        <Text
          accessibilityRole="header"
          style={[theme.typography.feedPageTitle, styles.title, { color: theme.colors.gray900 }]}
        >
          {group.label}
        </Text>
        {group.description ? (
          <Text style={[theme.typography.captionMedium, styles.description]}>{group.description}</Text>
        ) : null}
        <View style={styles.moveRow}>
          <Text style={[theme.typography.feedDeltaLarge, { color }]} testID="meta-group-change">
            {formatSignedPercent(group.medianChangePercent)}
          </Text>
          <Text style={[theme.typography.headline, { color }]} testID="meta-group-value">
            {formatSignedCompactUsd(group.valueChangeUsd)}
          </Text>
        </View>
        <View
          onLayout={(event) => setChartWidth(Math.floor(event.nativeEvent.layout.width))}
          style={styles.chart}
          testID="meta-group-chart"
        >
          {chartWidth > 0 ? (
            <PriceSparkline
              height={CHART_HEIGHT}
              points={group.sparkPoints}
              trendPct={group.medianChangePercent}
              width={chartWidth}
            />
          ) : null}
        </View>
      </View>

      {owned && owned.ownedCards.length > 0 ? (
        <OwnedSection
          onOpenCard={onOpenCard}
          ownedCards={owned.ownedCards}
          ownedCount={owned.ownedCount}
          valueChangeUsd={owned.valueChangeUsd}
          windowDays={detail.windowDays}
        />
      ) : null}

      <View style={styles.section} testID="meta-group-movers">
        <Text accessibilityRole="header" style={[theme.typography.feedSectionTitle, { color: theme.colors.gray900 }]}>
          Biggest movers
        </Text>
        {group.topCards.length > 0 ? (
          <>
            {group.topCards.map((card) => (
              <MetaCardRow
                changePercent={card.changePercent}
                currencyCode={card.currencyCode}
                imageUrl={card.imageUrl}
                key={metaCardKey(card)}
                meta={metaCardMeta(card)}
                name={metaCardTitle(card)}
                onPress={() => onOpenCard(card.cardId)}
                ownedLabel={ownedKeys.has(metaCardKey(card)) ? OWNED_LABEL : null}
                price={card.priceNow}
                testID={`meta-group-mover-${card.cardId}`}
              />
            ))}
            <Text style={[theme.typography.captionMedium, styles.footnote]}>Tap any card to open its card page.</Text>
          </>
        ) : (
          <Text style={[theme.typography.captionMedium, styles.footnote]} testID="meta-group-movers-empty">
            No single card is driving this group yet.
          </Text>
        )}
      </View>
    </View>
  );
}

function OwnedSection({
  onOpenCard,
  ownedCards,
  ownedCount,
  valueChangeUsd,
  windowDays,
}: {
  onOpenCard: (cardId: string) => void;
  ownedCards: MetaCard[];
  ownedCount: number;
  valueChangeUsd: number;
  windowDays: number;
}) {
  const theme = useSpotlightTheme();
  const valueColor = useSignedColor(valueChangeUsd);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ownedCards : ownedCards.slice(0, GROUP_OWNED_PREVIEW);
  const period = windowDays <= 7 ? 'this week' : `past ${windowDays} days`;

  return (
    <View
      style={[styles.section, { borderBottomColor: theme.colors.gray100, borderBottomWidth: spacing.xxxs }]}
      testID="meta-group-owned"
    >
      <Text accessibilityRole="header" style={[theme.typography.feedSectionTitle, { color: theme.colors.gray900 }]}>
        Your cards in this group
      </Text>
      <Text style={[theme.typography.captionMedium, styles.description]} testID="meta-group-owned-summary">
        {`${formatCount(ownedCount)} ${ownedCount === 1 ? 'card' : 'cards'} · `}
        <Text style={[theme.typography.feedTag, { color: valueColor }]}>{formatSignedCompactUsd(valueChangeUsd)}</Text>
        {` ${period}`}
      </Text>
      {shown.map((card, index) => (
        <MetaCardRow
          changePercent={card.changePercent}
          currencyCode={card.currencyCode}
          imageUrl={card.imageUrl}
          key={metaCardKey(card)}
          meta={metaCardMeta(card)}
          name={metaCardTitle(card)}
          onPress={() => onOpenCard(card.cardId)}
          ownedLabel={OWNED_LABEL}
          price={card.priceNow}
          showDivider={index < shown.length - 1 || !expanded}
          testID={`meta-group-owned-${card.cardId}`}
        />
      ))}
      {!expanded && ownedCards.length > GROUP_OWNED_PREVIEW ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={spacing.xxs}
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.seeAll, { opacity: pressed ? 0.7 : 1 }]}
          testID="meta-group-owned-see-all"
        >
          <Text style={[theme.typography.captionStrong, { color: theme.colors.brandStrong }]}>
            {`See all ${formatCount(ownedCards.length)} ›`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: {
    height: CHART_HEIGHT,
    marginTop: 6,
  },
  description: {
    marginTop: 2,
  },
  footnote: {
    paddingVertical: spacing.xs,
  },
  hero: {
    borderBottomWidth: spacing.xxxs,
    paddingBottom: 14,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxs,
  },
  moveRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 10,
    marginTop: spacing.xs,
  },
  safeArea: {
    flex: 1,
  },
  section: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  seeAll: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxs,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
  },
  title: {
    marginTop: spacing.xxxs,
  },
});
