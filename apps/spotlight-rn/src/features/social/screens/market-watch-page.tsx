import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { GraphDown, GraphUp } from 'iconoir-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_CARD_GAME, type CalendarEvent, type CardGame, type MetaGroup } from '@spotlight/api-client';
import {
  borderWidths,
  PriceSparkline,
  SearchField,
  spacing,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  AnimatedScrollView,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { isCalendarEventActionable } from '@/features/meta-feed/components/coming-up-block';
import { useCalendar, useMetaPulse } from '@/features/meta-feed/hooks/use-meta-feed';
import { useMetaFeedNavigation } from '@/features/meta-feed/hooks/use-meta-feed-navigation';
import { useTrendSearch } from '@/features/meta-feed/hooks/use-trend-search';
import {
  calendarDateParts,
  formatSignedPercent,
  splitMetaGroups,
} from '@/features/meta-feed/screens/components/meta-format';
import { GameFilterChips } from '@/features/social/components/game-filter-chips';

const TREND_WINDOW_DAYS = 30;
const TREND_ROWS_PER_SECTION = 3;
const SET_CARD_WIDTH = 339;
// Figma 6322:7842 draws the logo at 64 x 30.66.
const SET_LOGO_WIDTH = 64;
const SET_LOGO_HEIGHT = 30.66;
const CARD_THUMB_WIDTH = 46.4;
const CARD_THUMB_HEIGHT = 64;
const CARD_THUMB_RADIUS = 1.6;
const SPARKLINE_WIDTH = 64;
const SPARKLINE_HEIGHT = 32;
const SECTION_ICON_SIZE = 20;
const PERCENT_MIN_WIDTH = 48;

/** "NOV 1" from a YYYY-MM-DD date. */
export function formatTrendDate(date: string | null | undefined): string {
  const { month, day } = calendarDateParts(date ?? '');
  return month ? `${month} ${Number(day)}` : '';
}

/** "Nov 6 Release" from a YYYY-MM-DD date. */
export function formatReleaseLine(date: string): string {
  const { month, day } = calendarDateParts(date);
  if (!month) {
    return 'Release';
  }
  return `${month[0]}${month.slice(1).toLowerCase()} ${Number(day)} Release`;
}

/** "2003–2007" from "2003–2007 · 2,626 cards". */
export function groupYearsLine(description: string): string {
  return description.split(' · ')[0] ?? '';
}

type MarketWatchPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/**
 * The Market Watch tab (Figma 6322:7827): one game at a time, its upcoming set
 * releases, then the top 3 sets rising and cooling over 30 days (English main
 * sets, ranked by the backend; see meta_pulse.aggregate_sets).
 */
export function MarketWatchPage({ page, scrollRef, testID = 'market-watch-page' }: MarketWatchPageProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const navigation = useMetaFeedNavigation();
  const [game, setGame] = useState<CardGame>(DEFAULT_CARD_GAME);
  const [refreshing, setRefreshing] = useState(false);

  const calendar = useCalendar({ game });
  const pulse = useMetaPulse({ game, windowDays: TREND_WINDOW_DAYS, kind: 'sets' });
  const { refresh: refreshCalendar, refreshIfStale: refreshCalendarIfStale } = calendar;
  const { refresh: refreshPulse, refreshIfStale: refreshPulseIfStale } = pulse;

  useFocusEffect(
    useCallback(() => {
      refreshCalendarIfStale();
      refreshPulseIfStale();
    }, [refreshCalendarIfStale, refreshPulseIfStale]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refreshCalendar(), refreshPulse()]).finally(() => setRefreshing(false));
  }, [refreshCalendar, refreshPulse]);

  // `loading` starts false, so "no data yet" only means "nothing to show" once
  // this game's read has actually run.
  const [settledGame, setSettledGame] = useState<CardGame | null>(null);
  const readStartedForRef = useRef<CardGame | null>(null);
  useEffect(() => {
    if (pulse.loading) {
      readStartedForRef.current = game;
    } else if (readStartedForRef.current === game) {
      setSettledGame(game);
    }
  }, [game, pulse.loading]);

  const releases = (calendar.data?.items ?? []).filter((event) => event.kind === 'release');
  const { risers, coolers } = splitMetaGroups(pulse.data?.groups ?? [], TREND_ROWS_PER_SECTION);
  const hasTrends = risers.length > 0 || coolers.length > 0;
  const trendDate = formatTrendDate(pulse.data?.asOfDate);
  const windowDays = pulse.data?.windowDays ?? TREND_WINDOW_DAYS;

  const [trendQuery, setTrendQuery] = useState('');
  const search = useTrendSearch(trendQuery, game, TREND_WINDOW_DAYS);
  const searching = search.query !== '';

  const openGroup = (group: MetaGroup) => {
    navigation.openMetaGroup({ game, groupKey: group.groupKey, windowDays });
  };

  const renderTrendSection = (
    title: string,
    Icon: typeof GraphUp,
    groups: MetaGroup[],
    sectionTestID: string,
    emptyMessage?: string,
  ) =>
    groups.length > 0 || emptyMessage ? (
      <View style={styles.trendSection} testID={sectionTestID}>
        <View style={styles.trendHeader}>
          <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>{title}</Text>
          <Icon color={theme.colors.gray900} height={SECTION_ICON_SIZE} width={SECTION_ICON_SIZE} />
        </View>
        {groups.length === 0 ? (
          <Text style={[theme.typography.label, { color: theme.colors.gray500 }]} testID={`${sectionTestID}-empty`}>
            {emptyMessage}
          </Text>
        ) : null}
        <View style={styles.trendRows}>
          {groups.map((group) => (
            <TrendRow
              group={group}
              key={group.groupKey}
              onPress={() => openGroup(group)}
              testID={`${testID}-group-${group.groupKey}`}
            />
          ))}
        </View>
      </View>
    ) : null;

  return (
    <AnimatedScrollView
      contentContainerStyle={[page.contentContainerStyle, { paddingBottom: insets.bottom + 24 }]}
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
      <View style={styles.top}>
        <View style={styles.chips}>
          <GameFilterChips
            onChange={(next) => {
              if (next) {
                setGame(next);
              }
            }}
            testID={`${testID}-games`}
            value={game}
          />
        </View>

        {releases.length > 0 ? (
          <View style={styles.setsSection} testID={`${testID}-sets`}>
            <Text style={[theme.typography.label, styles.setsTitle, { color: theme.colors.gray900 }]}>
              UPCOMING SETS
            </Text>
            <PageSwipeGuard>
              <ScrollView
                contentContainerStyle={styles.setsRail}
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                {releases.map((event) => (
                  <SetCard
                    event={event}
                    key={event.id}
                    onPress={() => navigation.openCalendarEvent(event)}
                    testID={`${testID}-set-${event.id}`}
                  />
                ))}
              </ScrollView>
            </PageSwipeGuard>
          </View>
        ) : null}
      </View>

      <View
        style={{ backgroundColor: theme.colors.gray50, height: borderWidths.sectionBand }}
        testID={`${testID}-band`}
      />

      <View style={styles.trends}>
        <View style={styles.trendsTitle}>
          <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>PRICE TRENDS</Text>
          {trendDate ? (
            <Text
              style={[theme.typography.postBody, { color: theme.colors.gray500 }]}
              testID={`${testID}-date`}
            >
              {trendDate}
            </Text>
          ) : null}
        </View>
        {/* Any set's trend, not just the top 3: "vintage", "fossil", "neo". */}
        <SearchField
          accessibilityLabel="Search price trends"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setTrendQuery}
          placeholder="Search sets"
          returnKeyType="search"
          size="collection"
          surface="muted"
          testID={`${testID}-search`}
          uppercasePlaceholder
          value={trendQuery}
        />
        {searching ? (
          <View style={styles.trendRows} testID={`${testID}-search-results`}>
            {search.groups.map((group) => (
              <TrendRow
                group={group}
                key={group.groupKey}
                onPress={() => openGroup(group)}
                testID={`${testID}-result-${group.groupKey}`}
              />
            ))}
            {search.groups.length === 0 && !search.loading ? (
              <Text
                style={[theme.typography.label, { color: theme.colors.gray500 }]}
                testID={`${testID}-search-empty`}
              >
                {search.failed
                  ? "Couldn't search price trends. Check your connection."
                  : `No price trends match "${search.query}".`}
              </Text>
            ) : null}
          </View>
        ) : hasTrends ? (
          <>
            {/* Most games outside Pokémon have no rising sets; say so rather than hide the side. */}
            {renderTrendSection('TRENDING UP', GraphUp, risers, `${testID}-trending-up`, 'No sets rising this month.')}
            {renderTrendSection('COOLING OFF', GraphDown, coolers, `${testID}-cooling-off`, 'No sets cooling this month.')}
          </>
        ) : null}
      </View>
      {searching || hasTrends ? null : settledGame === game ? (
        // The read hook keeps failures to itself, so a failed read and a quiet
        // market reach this card alike.
        <StateCard
          message="Check back soon for price trends in this game."
          style={styles.stateCard}
          testID={`${testID}-empty`}
          title="No price trends right now"
          variant="field"
        />
      ) : (
        <StateCard
          centered
          loading
          message="Fetching the latest market moves."
          style={styles.stateCard}
          testID={`${testID}-loading`}
          title="Loading price trends"
          variant="field"
        />
      )}
    </AnimatedScrollView>
  );
}

function SetCard({
  event,
  onPress,
  testID,
}: {
  event: CalendarEvent;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!isCalendarEventActionable(event)}
      onPress={onPress}
      style={[
        styles.setCard,
        { backgroundColor: theme.colors.gray50, borderCurve: 'continuous', borderRadius: theme.radii.sm },
      ]}
      testID={testID}
    >
      {event.logoUrl ? (
        // Figma 6322:7842: the set logo, 64 wide, left of the details.
        <ExpoImage
          accessibilityIgnoresInvertColors
          cachePolicy="memory-disk"
          contentFit="contain"
          source={{ uri: event.logoUrl }}
          style={styles.setLogo}
          testID={`${testID}-logo`}
        />
      ) : null}
      <View style={styles.setDetails}>
        <View
          style={[
            styles.setTag,
            { borderColor: theme.colors.gray300, borderCurve: 'continuous', borderRadius: theme.radii.pill },
          ]}
        >
          <Text style={[theme.typography.captionTiny, { color: theme.colors.gray900 }]}>NEW SET</Text>
        </View>
        <Text numberOfLines={1} style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>
          {event.title}
        </Text>
        <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
          {formatReleaseLine(event.date)}
        </Text>
      </View>
    </Pressable>
  );
}

function TrendRow({
  group,
  onPress,
  testID,
}: {
  group: MetaGroup;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const change = group.medianChangePercent;
  const imageUrl = group.topCards[0]?.imageUrl ?? null;
  return (
    <>
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.trendRow} testID={testID}>
        <View
          style={[
            styles.thumb,
            { backgroundColor: theme.colors.surfaceMuted, borderCurve: 'continuous' },
          ]}
        >
          {imageUrl ? (
            <ExpoImage
              accessibilityIgnoresInvertColors
              contentFit="cover"
              source={{ uri: imageUrl }}
              style={StyleSheet.absoluteFill}
              testID={`${testID}-image`}
            />
          ) : null}
        </View>
        <View style={styles.trendInfo}>
          <Text numberOfLines={1} style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>
            {group.label}
          </Text>
          <Text numberOfLines={1} style={[theme.typography.label, { color: theme.colors.gray500 }]}>
            {groupYearsLine(group.description)}
          </Text>
        </View>
        <View style={styles.performance}>
          <PriceSparkline
            height={SPARKLINE_HEIGHT}
            points={group.sparkPoints}
            testID={`${testID}-sparkline`}
            trendPct={change}
            width={SPARKLINE_WIDTH}
          />
          <Text
            style={[
              theme.typography.feedRowTitle,
              styles.percent,
              { color: change >= 0 ? theme.colors.green500 : theme.colors.red500 },
            ]}
            testID={`${testID}-change`}
          >
            {formatSignedPercent(change)}
          </Text>
        </View>
      </Pressable>
      <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} />
    </>
  );
}

// Spacing follows Figma 6322:7828 and 6322:7895.
const styles = StyleSheet.create({
  chips: {
    paddingTop: spacing.sm,
  },
  divider: {
    height: borderWidths.containerRule,
  },
  performance: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  percent: {
    minWidth: PERCENT_MIN_WIDTH,
    textAlign: 'right',
  },
  // Figma 6322:7840: logo + details in a row, 16 apart; details stack 4 apart.
  setCard: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    width: SET_CARD_WIDTH,
  },
  setDetails: {
    flex: 1,
    gap: spacing.xxxs,
  },
  setLogo: {
    height: SET_LOGO_HEIGHT,
    width: SET_LOGO_WIDTH,
  },
  setTag: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  setsRail: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
  },
  setsSection: {
    gap: spacing.xxs,
    paddingTop: spacing.lg,
  },
  setsTitle: {
    paddingHorizontal: spacing.sm,
  },
  stateCard: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
  },
  thumb: {
    borderRadius: CARD_THUMB_RADIUS,
    height: CARD_THUMB_HEIGHT,
    overflow: 'hidden',
    width: CARD_THUMB_WIDTH,
  },
  top: {
    paddingBottom: spacing.sm,
  },
  trendHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  trendInfo: {
    flex: 1,
    gap: spacing.xxxs,
    minWidth: 0,
  },
  trendRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  trendRows: {
    gap: spacing.xxs,
  },
  trendSection: {
    gap: spacing.xs,
  },
  trends: {
    gap: spacing.lg,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  trendsTitle: {
    gap: 1,
  },
});
