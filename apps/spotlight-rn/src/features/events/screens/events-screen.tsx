import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SpotlightEvent } from '@spotlight/api-client';
import {
  PageTabs,
  PillButton,
  SkeletonBlock,
  StateCard,
  layout,
  radii,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import { EventListCard } from '@/features/events/components/event-list-card';
import { eventRegion, eventRegions } from '@/features/events/event-format';
import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';
import {
  AnimatedScrollView,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';

export type EventsTab = 'events' | 'tickets' | 'saved' | 'past';

const TABS: readonly { value: EventsTab; label: string; title: string }[] = [
  { value: 'events', label: 'Events', title: 'Upcoming Spotlight events' },
  { value: 'tickets', label: 'Tickets', title: 'My tickets' },
  { value: 'saved', label: 'Saved', title: 'Saved events' },
  { value: 'past', label: 'Past events', title: 'Past Spotlight events' },
];

const ALL_REGIONS = 'all';

type EventsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  /** Prefix for every testID; the scroller is `${testID}-scroll`. */
  testID?: string;
};

/**
 * EVENTS on Social: the upcoming-shows list as a hub page. The hub draws the
 * header and the FOR YOU · YOUR POSTS · EVENTS rail, so this page starts at the
 * status chips. Guests get only the upcoming list (owner, 2026-11-21).
 */
export function EventsPage({ page, scrollRef, testID = 'events' }: EventsPageProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { events, failed, refresh } = useSpotlightEvents();
  const { isSaved, savedIds, toggle } = useSavedEvents();
  const { isGuest } = useGuestGate();
  const [selectedTab, setTab] = useState<EventsTab>('events');
  const tab: EventsTab = isGuest ? 'events' : selectedTab;
  const [region, setRegion] = useState<string>(ALL_REGIONS);
  const [refreshing, setRefreshing] = useState(false);

  const upcoming = useMemo(() => events.filter((event) => event.status !== 'past'), [events]);
  const past = useMemo(() => events.filter((event) => event.status === 'past'), [events]);
  const saved = useMemo(() => events.filter((event) => savedIds.has(event.id)), [events, savedIds]);

  // Region tabs come from the whole feed, so they don't jump as the chip changes.
  const regionTabs = useMemo(
    () => [
      { value: ALL_REGIONS, label: 'ALL' },
      ...eventRegions(events).map((item) => ({ value: item.value, label: item.label.toUpperCase() })),
    ],
    [events],
  );

  const gutter = layout.pageGutter;

  const openEvent = useCallback(
    (event: SpotlightEvent) => router.push({ pathname: '/events/[eventId]', params: { eventId: event.id } } as never),
    [router],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const renderCard = (event: SpotlightEvent) => (
    <EventListCard
      key={event.id}
      event={event}
      onPress={() => openEvent(event)}
      onToggleSaved={isGuest ? undefined : () => toggle(event.id)}
      saved={isSaved(event.id)}
    />
  );

  const visible = (list: SpotlightEvent[]) =>
    region === ALL_REGIONS ? list : list.filter((event) => eventRegion(event)?.value === region);

  const renderList = () => {
    if (events.length === 0) {
      if (failed) {
        return (
          <StateCard
            actionLabel="Try again"
            message="Check your connection and try again."
            onActionPress={() => void refresh()}
            testID={`${testID}-error`}
            title="Couldn't load events"
          />
        );
      }
      return (
        <View style={styles.list} testID={`${testID}-loading`}>
          {[0, 1, 2].map((key) => (
            <SkeletonBlock key={key} height={143} radius={radii.sm} width="100%" />
          ))}
        </View>
      );
    }
    // Nothing records a purchase yet: "Buy Tickets" opens the show's external
    // ticket page, so this tab can only be honest about being empty.
    if (tab === 'tickets') {
      return (
        <StateCard
          message="Tickets you buy from a show's ticket page don't appear in the app yet."
          testID={`${testID}-tickets-empty`}
          title="No tickets yet"
        />
      );
    }
    if (tab === 'saved') {
      const rows = visible(saved);
      return rows.length > 0 ? (
        <View style={styles.list}>{rows.map(renderCard)}</View>
      ) : (
        <StateCard message="Tap the heart on a show to keep it here." testID={`${testID}-saved-empty`} title="No saved events" />
      );
    }
    if (tab === 'past') {
      const rows = visible(past);
      return rows.length > 0 ? (
        <View style={styles.list}>{rows.map(renderCard)}</View>
      ) : (
        <StateCard message="Shows that have wrapped will show up here." testID={`${testID}-past-empty`} title="No past events" />
      );
    }
    const rows = visible(upcoming);
    return rows.length > 0 ? (
      <View style={styles.list}>{rows.map(renderCard)}</View>
    ) : (
      <StateCard message="New shows are announced here first." testID={`${testID}-upcoming-empty`} title="No upcoming events" />
    );
  };

  const title = TABS.find((item) => item.value === tab)?.title ?? '';

  return (
    <AnimatedScrollView
      // `automatic`, like the other hub pages: the pager's top math assumes UIKit's inset.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        page.contentContainerStyle,
        { backgroundColor: theme.colors.gray0, paddingBottom: tabBarBottomFadeHeight },
      ]}
      keyboardShouldPersistTaps="handled"
      onScroll={page.onScroll}
      ref={scrollRef as unknown as RefObject<ScrollView>}
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
      showsVerticalScrollIndicator={false}
      testID={`${testID}-scroll`}
    >
      <View style={styles.head}>
        {/* Horizontal rows are guarded so dragging them scrolls the row, not the pagers. */}
        {isGuest ? null : (
          <PageSwipeGuard>
            <ScrollView
              contentContainerStyle={[styles.chips, { paddingHorizontal: gutter }]}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              testID={`${testID}-tabs`}
            >
              {TABS.map((item) => (
                <PillButton
                  key={item.value}
                  label={item.label.toUpperCase()}
                  labelRole="caption"
                  onPress={() => setTab(item.value)}
                  selected={item.value === tab}
                  testID={`${testID}-tabs-tab-${item.value}`}
                  tone="filled"
                />
              ))}
            </ScrollView>
          </PageSwipeGuard>
        )}
        <Text
          style={[theme.typography.headline, { color: theme.colors.gray900, paddingHorizontal: gutter }]}
          testID={`${testID}-title`}
        >
          {title.toUpperCase()}
        </Text>
        <PageSwipeGuard>
          <PageTabs
            // Tight and centred: the default 40pt gap spread five-plus regions apart (owner, 2026-11-19).
            align="gutter-center"
            labelSize="caption"
            onChange={setRegion}
            scrollable
            tabs={regionTabs}
            testID={`${testID}-regions`}
            uppercase
            value={region}
          />
        </PageSwipeGuard>
      </View>
      <View style={[styles.listArea, { backgroundColor: theme.colors.gray50, paddingHorizontal: gutter }]}>
        {renderList()}
      </View>
    </AnimatedScrollView>
  );
}

const STANDALONE_SCROLL_THROTTLE = 16;

/**
 * The Events page on its own, for the dev screen host and the legacy `/events`
 * tab route until it redirects to `/social?tab=events`.
 */
export function EventsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const page = useMemo<CollapsiblePageProps>(
    () => ({
      contentContainerStyle: { minHeight: 0, paddingTop: 0 },
      onScroll: () => undefined,
      progressViewOffset: 0,
      scrollEventThrottle: STANDALONE_SCROLL_THROTTLE,
      scrollToOverflowEnabled: false,
    }),
    [],
  );
  return (
    // iOS: the scroller's `automatic` inset already clears the status bar.
    <View style={[styles.root, { backgroundColor: theme.colors.gray0, paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
      <EventsPage page={page} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  head: {
    gap: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  chips: {
    gap: spacing.xxs,
  },
  listArea: {
    flexGrow: 1,
    paddingTop: spacing.sm,
  },
  list: {
    gap: spacing.xs,
  },
});
