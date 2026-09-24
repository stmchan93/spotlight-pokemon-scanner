import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type MetaExposure,
  type MetaGroup,
  type MetaLaneFilter,
  type MetaPulse,
} from '@spotlight/api-client';
import {
  PillButton,
  SegmentedControl,
  SkeletonBlock,
  StateCard,
  Text,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { MetaBarList } from '@/features/meta-feed/components/meta-bar-list';
import { MetaExposureCallout } from '@/features/meta-feed/components/meta-exposure-callout';
import { useMetaExposure } from '@/features/meta-feed/hooks/use-meta-feed';
import type { MetaGroupRouteTarget } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import {
  formatSignedCompactUsd,
  formatSignedPercent,
  maxGroupMagnitude,
  splitMetaGroups,
} from '@/features/meta-feed/screens/components/meta-format';
import { MetaPageHeader, useSignedColor } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useMetaPageData, type MetaPageStatus } from '@/features/meta-feed/screens/components/meta-page-data';

export const META_LANE_ITEMS = [
  { label: 'All', value: 'all' },
  { label: 'Raw', value: 'raw' },
  { label: 'Graded', value: 'graded' },
] as const satisfies readonly { label: string; value: MetaLaneFilter }[];

export const META_WINDOW_ITEMS = [
  { label: '7D', value: '7' },
  { label: '30D', value: '30' },
  { label: '90D', value: '90' },
] as const;

type WindowValue = (typeof META_WINDOW_ITEMS)[number]['value'];

function readLabel(windowDays: number): string {
  if (windowDays <= 7) return "This week's read";
  if (windowDays <= 30) return "This month's read";
  return "This quarter's read";
}

export function windowCaption(windowDays: number): string {
  return `past ${windowDays} days`;
}

export type MetaScreenProps = {
  initialGame?: CardGame;
  initialLane?: MetaLaneFilter;
  initialWindowDays?: number;
  onBack: () => void;
  /** Row taps; the route pushes `/meta/group/[groupKey]`. */
  onOpenGroup: (target: MetaGroupRouteTarget) => void;
};

/**
 * Meta page v4 (docs/meta-feed-mockup/v2/MetaV4.dc.html): this week's read,
 * the viewer's callout, then every rising and cooling group as bar rows, per
 * game, lane and window. Every filter change refetches — the payload is
 * computed server-side per (game, window, lane). Rows open the group page.
 */
export function MetaScreen({
  initialGame = DEFAULT_CARD_GAME,
  initialLane = 'all',
  initialWindowDays = 7,
  onBack,
  onOpenGroup,
}: MetaScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [game, setGame] = useState<CardGame>(initialGame);
  const [lane, setLane] = useState<MetaLaneFilter>(initialLane);
  const [windowDays, setWindowDays] = useState<number>(initialWindowDays);
  const [refreshing, setRefreshing] = useState(false);

  const { data: pulse, loading, refresh, status } = useMetaPageData({ game, lane, windowDays });
  const { data: exposure, refresh: refreshExposure } = useMetaExposure({ game, windowDays });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), refreshExposure()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshExposure]);

  const openGroup = useCallback(
    (group: MetaGroup) => onOpenGroup({ game, groupKey: group.groupKey, lane, windowDays }),
    [game, lane, onOpenGroup, windowDays],
  );

  const games = useMemo<CardGame[]>(() => {
    const available = pulse?.availableGames ?? [];
    return available.includes(game) ? available : [game, ...available];
  }, [game, pulse?.availableGames]);

  const disabledWindows = useMemo<WindowValue[]>(() => {
    const available = pulse?.availableWindows;
    if (!available || available.length === 0) {
      return [];
    }
    return META_WINDOW_ITEMS.map((item) => item.value).filter(
      (value) => !available.includes(Number(value)) && Number(value) !== windowDays,
    );
  }, [pulse?.availableWindows, windowDays]);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader
        onBack={onBack}
        subtitle="What's rising and cooling, by price"
        testID="meta-header"
        title="Meta"
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        testID="meta-scroll"
      >
        <ScrollView
          horizontal
          contentContainerStyle={styles.gameChips}
          showsHorizontalScrollIndicator={false}
          testID="meta-game-chips"
        >
          {games.map((candidate) => (
            <PillButton
              key={candidate}
              label={gameDisplayName(candidate)}
              onPress={() => setGame(candidate)}
              selected={candidate === game}
              style={styles.chip}
              testID={`meta-game-${candidate}`}
              tone="filter"
            />
          ))}
        </ScrollView>
        <View style={styles.segments}>
          <View style={styles.laneSegment}>
            <SegmentedControl
              items={META_LANE_ITEMS}
              onChange={setLane}
              testID="meta-lane"
              tone="inverted"
              value={lane}
            />
          </View>
          <View style={styles.windowSegment}>
            <SegmentedControl
              disabledValues={disabledWindows}
              items={META_WINDOW_ITEMS}
              onChange={(next) => setWindowDays(Number(next))}
              testID="meta-window"
              tone="inverted"
              value={String(windowDays) as WindowValue}
            />
          </View>
        </View>

        <MetaPageBody
          exposure={exposure}
          loading={loading}
          onOpenGroup={openGroup}
          onRetry={() => void refresh()}
          pulse={pulse}
          status={status}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

type MetaPageBodyProps = {
  exposure: MetaExposure | null;
  loading: boolean;
  onOpenGroup: (group: MetaGroup) => void;
  onRetry: () => void;
  pulse: MetaPulse | null;
  status: MetaPageStatus;
};

function MetaPageBody({ exposure, loading, onOpenGroup, onRetry, pulse, status }: MetaPageBodyProps) {
  const theme = useSpotlightTheme();
  const lists = useMemo(() => splitMetaGroups(pulse?.groups ?? []), [pulse]);
  if (!pulse) {
    if (status === 'loading') {
      return <MetaSkeleton />;
    }
    return (
      <View style={styles.stateWrap}>
        {status === 'disabled' ? (
          <StateCard
            message="The market read isn't switched on yet. Check back soon."
            testID="meta-disabled"
            title="Meta is coming soon"
            variant="muted"
          />
        ) : (
          <StateCard
            actionLabel="Try again"
            actionTestID="meta-retry"
            message="We couldn't load the market read. Check your connection and try again."
            onActionPress={onRetry}
            testID="meta-error"
            title="Meta isn't available right now"
          />
        )}
      </View>
    );
  }

  if (lists.risers.length + lists.coolers.length === 0) {
    return (
      <View style={styles.stateWrap}>
        <StateCard
          message="No group moved enough in this window. Try another window or game."
          testID="meta-empty"
          title="Nothing is moving yet"
          variant="muted"
        />
      </View>
    );
  }

  // One scale for both lists, so an up bar and a down bar compare honestly.
  const maxMagnitude = maxGroupMagnitude([...lists.risers, ...lists.coolers]);
  const viewerExposure = exposure && exposure.game === pulse.game ? exposure : null;

  return (
    <View style={loading ? styles.stale : null} testID="meta-content">
      <HeadlineCard pulse={pulse} />
      <View style={styles.lists}>
        <MetaExposureCallout exposure={viewerExposure} style={styles.callout} testID="meta-callout" />
        <MetaBarList
          direction="up"
          exposure={viewerExposure}
          groups={lists.risers}
          maxMagnitude={maxMagnitude}
          onOpenGroup={onOpenGroup}
          testID="meta-up"
        />
        <MetaBarList
          direction="down"
          exposure={viewerExposure}
          groups={lists.coolers}
          maxMagnitude={maxMagnitude}
          onOpenGroup={onOpenGroup}
          testID="meta-down"
        />
        <Text style={[theme.typography.captionMedium, styles.footnote]}>Tap a group to see the cards driving it.</Text>
      </View>
    </View>
  );
}

function HeadlineCard({ pulse }: { pulse: MetaPulse }) {
  const theme = useSpotlightTheme();
  const { summary } = pulse;

  return (
    <View
      style={[styles.headlineCard, { backgroundColor: theme.colors.purple50 }]}
      testID="meta-headline"
    >
      <Text style={[theme.typography.feedTag, styles.overline, { color: theme.colors.brandStrong }]}>
        {readLabel(pulse.windowDays)}
      </Text>
      <Text style={[theme.typography.feedTitle, styles.headlineTitle, { color: theme.colors.gray900 }]}>
        {pulse.headline.title}
      </Text>
      <View style={styles.statRow}>
        <StatTile
          caption={summary.gradedValueChangeUsd == null ? 'no graded history' : formatSignedCompactUsd(summary.gradedValueChangeUsd)}
          change={summary.gradedValueChangeUsd}
          label="Graded value"
          testID="meta-stat-graded"
          value={summary.gradedValueChangePercent == null ? '—' : formatSignedPercent(summary.gradedValueChangePercent)}
        />
        <StatTile
          caption={summary.rawValueChangeUsd == null ? 'no raw history' : formatSignedCompactUsd(summary.rawValueChangeUsd)}
          change={summary.rawValueChangeUsd}
          label="Raw value"
          testID="meta-stat-raw"
          value={summary.rawValueChangePercent == null ? '—' : formatSignedPercent(summary.rawValueChangePercent)}
        />
      </View>
    </View>
  );
}

function StatTile({
  caption,
  change,
  label,
  testID,
  value,
}: {
  caption: string;
  change: number | null;
  label: string;
  testID: string;
  value: string;
}) {
  const theme = useSpotlightTheme();
  const color = useSignedColor(change);
  return (
    <View
      accessibilityLabel={`${label}: ${value}, ${caption}`}
      accessible
      style={[styles.statTile, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <Text style={theme.typography.captionMedium}>{label}</Text>
      <Text numberOfLines={1} style={[theme.typography.feedTitle, { color }]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.captionMedium, { color }]}>
        {caption}
      </Text>
    </View>
  );
}

function MetaSkeleton() {
  return (
    <View style={styles.skeleton} testID="meta-loading">
      <SkeletonBlock height={220} radius={radii.lg} />
      <SkeletonBlock height={18} width="40%" />
      {Array.from({ length: 5 }).map((_, index) => (
        <SkeletonBlock key={index} height={44} radius={radii.sm} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  callout: {
    marginBottom: 6,
  },
  chip: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
  },
  footnote: {
    paddingVertical: spacing.xs,
  },
  gameChips: {
    gap: spacing.xxs,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  headlineCard: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    marginHorizontal: spacing.sm,
    padding: spacing.sm,
  },
  headlineTitle: {
    marginTop: 6,
  },
  laneSegment: {},
  lists: {
    paddingHorizontal: spacing.sm,
    paddingTop: 18,
  },
  overline: {
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  safeArea: {
    flex: 1,
  },
  segments: {
    gap: spacing.xxs,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  stale: {
    opacity: 0.6,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
    marginTop: 14,
  },
  statTile: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flex: 1,
    minWidth: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: 10,
  },
  windowSegment: {},
});
