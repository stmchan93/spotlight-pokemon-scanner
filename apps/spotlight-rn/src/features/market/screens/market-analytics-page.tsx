import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type MarketWindow,
  type MarketSetMove,
} from '@spotlight/api-client';
import { spacing, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import {
  AnimatedScrollView,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import type { AssistantPageExtra } from '@/features/assistant/page-context/assistant-page-context';
import { InsightsGameSheet } from '@/features/insights/components/insights-game-sheet';
import {
  capitalize,
  GamePickerButton,
  MarketAnalyticsSkeleton,
  MarketPulseSection,
  MarketSectionTitle,
  WINDOW_OPTIONS,
  SectionBand,
  SetMoverRail,
  WindowToggle,
} from '@/features/market/components/market-analytics-sections';
import { UpcomingSetCard } from '@/features/market/screens/market-watch-page';
import { useMarketAnalytics } from '@/features/market/use-market-analytics';
import { useCalendar } from '@/features/meta-feed/hooks/use-meta-feed';
import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';

type MarketAnalyticsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  /**
   * Written with what the tab shows (game, window, zoomed set) so the host
   * screen can hand it to the floating Ekalight bubble while this tab is active.
   */
  assistantContextRef?: MutableRefObject<AssistantPageExtra | null>;
  initialGame?: CardGame;
  testID?: string;
};

/**
 * Home → MARKET ANALYTICS: game + window, the market index chart, Set movers,
 * then Upcoming sets. Heatmap, Bargain board, Breaking out, Grading
 * opportunities and You-vs-market were cut (owner, 2026-11-23); bargains and
 * breakouts may come back in a new visual.
 */
export function MarketAnalyticsPage({
  page,
  scrollRef,
  assistantContextRef,
  initialGame = DEFAULT_CARD_GAME,
  testID = 'market-analytics-page',
}: MarketAnalyticsPageProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useMetaFeedNavigation();
  const [game, setGame] = useState<CardGame>(initialGame);
  const [window, setWindow] = useState<MarketWindow>('30d');
  const [gameSheetOpen, setGameSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const analytics = useMarketAnalytics(game, window);
  const calendar = useCalendar({ game });
  const { refresh: refreshCalendar } = calendar;
  const data = analytics.data;

  useEffect(() => {
    if (!assistantContextRef) {
      return;
    }
    const windowLabel = WINDOW_OPTIONS.find((item) => item.value === window)?.label ?? window;
    assistantContextRef.current = {
      kind: 'insights',
      label: `Market analytics · ${gameDisplayName(game)} · ${windowLabel}`,
      game,
      params: { tab: 'market', window, set_id: null, collection: null },
    };
  }, [assistantContextRef, game, window]);
  useEffect(() => () => {
    if (assistantContextRef) {
      assistantContextRef.current = null;
    }
  }, [assistantContextRef]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([analytics.refresh(), refreshCalendar()]).finally(() => setRefreshing(false));
  }, [analytics, refreshCalendar]);

  const openSet = useCallback((set: MarketSetMove) => {
    router.push({
      pathname: '/catalog/expansion/[expansionId]',
      // `set_id` is unique only within a game, so the game travels with it.
      params: { expansionId: set.setId, game: set.game, name: set.name },
    });
  }, [router]);

  const releases = (calendar.data?.items ?? []).filter((event) => event.kind === 'release');
  const gameName = gameDisplayName(game);
  // No data yet (first read pending) counts as loading, not empty.
  const loading = data == null && !analytics.failed;
  const thin = data != null
    && data.pulse.sparkline.length === 0
    && data.pulse.index == null
    && data.setsRising.length === 0
    && data.setsFalling.length === 0;

  const upcoming = releases.length > 0 ? (
    <>
      <SectionBand />
      <View style={styles.section} testID={`${testID}-upcoming`}>
        <MarketSectionTitle title="Upcoming sets" />
        <PageSwipeGuard>
          <ScrollView contentContainerStyle={styles.upcomingRail} horizontal showsHorizontalScrollIndicator={false}>
            {releases.map((event) => (
              <UpcomingSetCard
                event={event}
                key={event.id}
                onPress={() => navigation.openCalendarEvent(event)}
                testID={`${testID}-upcoming-${event.id}`}
              />
            ))}
          </ScrollView>
        </PageSwipeGuard>
      </View>
    </>
  ) : null;

  return (
    <AnimatedScrollView
      contentContainerStyle={[page.contentContainerStyle, { paddingBottom: insets.bottom + spacing.lg }]}
      contentInsetAdjustmentBehavior="automatic"
      onScroll={page.onScroll}
      ref={scrollRef as never}
      refreshControl={
        <RefreshControl
          onRefresh={handleRefresh}
          progressViewOffset={page.progressViewOffset}
          refreshing={refreshing}
          testID={`${testID}-refresh`}
          tintColor={theme.colors.gray400}
        />
      }
      scrollEventThrottle={page.scrollEventThrottle}
      scrollToOverflowEnabled={page.scrollToOverflowEnabled}
      testID={testID}
    >
      {/* 0. Game + window */}
      <View style={styles.controls}>
        <GamePickerButton game={game} onPress={() => setGameSheetOpen(true)} testID={`${testID}-game`} />
        <WindowToggle onChange={setWindow} testID={`${testID}-window`} value={window} />
      </View>

      {loading ? (
        <MarketAnalyticsSkeleton testID={`${testID}-loading`} />
      ) : analytics.failed ? (
        <StateCard
          actionLabel="Retry"
          actionTestID={`${testID}-retry`}
          message="Check your connection and try again."
          onActionPress={() => void analytics.refresh()}
          style={styles.stateCard}
          testID={`${testID}-error`}
          title="Couldn't load the market"
          variant="field"
        />
      ) : data && thin ? (
        <StateCard
          message={`There isn't enough ${gameName} price history for market analytics yet.`}
          style={styles.stateCard}
          testID={`${testID}-empty`}
          title="Not enough market data"
          variant="field"
        />
      ) : data ? (
        <>
          {/* 1. Market index */}
          <View style={styles.pulseWrap}>
            <MarketPulseSection data={data} testID={`${testID}-pulse`} />
          </View>

          {/* 2. Sets rising / falling — 7/30/90-day data only, so hidden on 1Y. */}
          {window === '1y' ? null : (
            <>
              <SectionBand />
              <View style={styles.section}>
                <MarketSectionTitle caption={capitalize(data.windowLabel)} title="Set movers" />
                <SetMoverRail
                  direction="up"
                  emptyMessage="No sets rising in this window."
                  items={data.setsRising}
                  onPressSet={openSet}
                  testID={`${testID}-sets-rising`}
                  title="RISING"
                />
                <SetMoverRail
                  direction="down"
                  emptyMessage="No sets falling in this window."
                  items={data.setsFalling}
                  onPressSet={openSet}
                  testID={`${testID}-sets-falling`}
                  title="FALLING"
                />
              </View>
            </>
          )}
        </>
      ) : null}

      {/* 3. Upcoming sets */}
      {upcoming}

      {data?.asOf ? (
        <Text style={[theme.typography.overline, styles.asOf, { color: theme.colors.gray500 }]} testID={`${testID}-as-of`}>
          {`Prices as of ${data.asOf} · USD`}
        </Text>
      ) : null}

      <InsightsGameSheet
        games={CARD_GAMES}
        onClose={() => setGameSheetOpen(false)}
        onSelect={(next) => {
          setGame(next);
          setGameSheetOpen(false);
        }}
        selectedGame={game}
        testID={`${testID}-game-sheet`}
        visible={gameSheetOpen}
      />
    </AnimatedScrollView>
  );
}

const styles = StyleSheet.create({
  asOf: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.lg,
  },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  gutter: {
    paddingHorizontal: spacing.sm,
  },
  pulseWrap: {
    paddingBottom: spacing.lg,
  },
  section: {
    gap: spacing.xs,
    paddingVertical: spacing.lg,
  },
  stateCard: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
  },
  upcomingRail: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
  },
});
