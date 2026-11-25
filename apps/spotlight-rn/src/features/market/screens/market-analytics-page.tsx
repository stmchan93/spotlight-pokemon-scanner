import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type MarketCardTile,
  type MarketWindow,
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
  CardMoversSection,
  GamePickerButton,
  MarketAnalyticsSkeleton,
  MarketSectionTitle,
  WINDOW_OPTIONS,
  SectionBand,
  WindowToggle,
  YourMoversSection,
} from '@/features/market/components/market-analytics-sections';
import { UpcomingSetCard } from '@/features/market/screens/market-watch-page';
import { useMarketAnalytics } from '@/features/market/use-market-analytics';
import { useCalendar } from '@/features/meta-feed/hooks/use-meta-feed';
import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { useAuth } from '@/providers/auth-provider';

/** The window the empty state points to when a shorter or longer one is thin. */
const FALLBACK_WINDOW: MarketWindow = '30d';

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
 * Home → MARKET ANALYTICS: a small entry point into card pages. Game + window,
 * Upcoming sets, the caller's own cards that moved, then the game's Rising and
 * Falling cards. The index chart and Set movers were cut (owner, 2026-11-24).
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
  const { isGuest } = useAuth();

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

  const openCard = useCallback((card: MarketCardTile) => {
    router.push({ pathname: '/cards/[cardId]', params: { cardId: card.cardId, name: card.name } });
  }, [router]);

  const releases = (calendar.data?.items ?? []).filter((event) => event.kind === 'release');
  // No data yet (first read pending) counts as loading, not empty.
  const loading = data == null && !analytics.failed;
  const noMovers = data != null && data.cardsRising.length === 0 && data.cardsFalling.length === 0;
  const fallbackLabel = WINDOW_OPTIONS.find((item) => item.value === FALLBACK_WINDOW)?.label ?? FALLBACK_WINDOW;

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

      {/* 1. Upcoming sets */}
      {upcoming}

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
      ) : data ? (
        <>
          {/* 2. Your cards, then the market's */}
          <YourMoversSection data={data} isGuest={isGuest} onPressCard={openCard} testID={`${testID}-yours`} />
          {noMovers ? (
            <StateCard
              actionLabel={window === FALLBACK_WINDOW ? undefined : `Show ${fallbackLabel}`}
              actionTestID={`${testID}-empty-action`}
              message={window === FALLBACK_WINDOW
                ? `Too few ${gameDisplayName(game)} cards have prices at both ends of this window.`
                : `Try ${fallbackLabel} instead.`}
              onActionPress={window === FALLBACK_WINDOW ? undefined : () => setWindow(FALLBACK_WINDOW)}
              style={styles.stateCard}
              testID={`${testID}-empty`}
              title="Not enough sales in this window"
              variant="field"
            />
          ) : (
            // Keyed so "Show more" collapses again per game/window.
            <>
              <CardMoversSection
                data={data}
                direction="rising"
                key={`rising|${game}|${window}`}
                onPressCard={openCard}
                testID={`${testID}-rising`}
              />
              <CardMoversSection
                data={data}
                direction="falling"
                key={`falling|${game}|${window}`}
                onPressCard={openCard}
                testID={`${testID}-falling`}
              />
            </>
          )}
        </>
      ) : null}

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
