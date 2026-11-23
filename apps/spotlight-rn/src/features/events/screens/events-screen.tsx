import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

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
import { profileHeaderSheetTop } from '@/features/profile/components/profile-header';
import { eventRegion, eventRegions } from '@/features/events/event-format';
import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';
import { PageSwipeGuard } from '@/components/page-tab-pager';

export type EventsTab = 'events' | 'tickets' | 'saved' | 'past';

const TABS: readonly { value: EventsTab; label: string; title: string }[] = [
  { value: 'events', label: 'Events', title: 'Upcoming Spotlight events' },
  { value: 'tickets', label: 'Tickets', title: 'My tickets' },
  { value: 'saved', label: 'Saved', title: 'Saved events' },
  { value: 'past', label: 'Past events', title: 'Past Spotlight events' },
];

const ALL_REGIONS = 'all';

// Figma 5865:9330. The photo runs 328 tall under a 348 scrim; the chip row sits
// at 256 and the white sheet laps the photo at 304.
// Figma measures these on a 59pt status bar; the sheet itself follows the
// Collection tab's (`profileHeaderSheetTop`), and the photo and chips keep
// their Figma distances to it.
const HEADER_IMAGE_BELOW_SHEET = 24;
const CHIP_ROW_ABOVE_SHEET = 48;
const SHEET_RADIUS = radii.xl;
// Figma 6642:5725 — 174×146, 11 left of center, its bottom 32 above the chips.
const LOGO_WIDTH = 174;
const LOGO_HEIGHT = 146;
const LOGO_ABOVE_CHIP_ROW = spacing.xxl;
const LOGO_CENTER_OFFSET = -11;

const headerImage = require('../../../../assets/images/events/events-header.jpg');
const showLogo = require('../../../../assets/images/events/spotlight-card-show-logo.png');

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sheetTop = profileHeaderSheetTop(insets.top);
  const headerImageHeight = sheetTop + HEADER_IMAGE_BELOW_SHEET;
  const chipRowTop = sheetTop - CHIP_ROW_ABOVE_SHEET;
  const { width: windowWidth } = useWindowDimensions();
  const { events, failed, refresh } = useSpotlightEvents();
  const { isSaved, savedIds, toggle } = useSavedEvents();
  // Guests see only the upcoming list and open shows (owner, 2026-11-21): no
  // Saved/Past tabs or save hearts.
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

  const renderCard = (event: SpotlightEvent, onPress: () => void = () => openEvent(event)) => (
    <EventListCard
      key={event.id}
      event={event}
      onPress={onPress}
      onToggleSaved={isGuest ? undefined : () => toggle(event.id)}
      saved={isSaved(event.id)}
    />
  );

  const inRegion = (list: SpotlightEvent[]) =>
    region === ALL_REGIONS ? list : list.filter((event) => eventRegion(event)?.value === region);
  const visible = inRegion;

  const renderList = () => {
    if (events.length === 0) {
      if (failed) {
        return (
          <StateCard
            actionLabel="Try again"
            message="Check your connection and try again."
            onActionPress={() => void refresh()}
            testID="events-error"
            title="Couldn't load events"
          />
        );
      }
      return (
        <View style={styles.list} testID="events-loading">
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
          testID="events-tickets-empty"
          title="No tickets yet"
        />
      );
    }
    if (tab === 'saved') {
      const rows = visible(saved);
      return rows.length > 0 ? (
        <View style={styles.list}>{rows.map((event) => renderCard(event))}</View>
      ) : (
        <StateCard message="Tap the heart on a show to keep it here." testID="events-saved-empty" title="No saved events" />
      );
    }
    if (tab === 'past') {
      const rows = visible(past);
      return rows.length > 0 ? (
        <View style={styles.list}>{rows.map((event) => renderCard(event))}</View>
      ) : (
        <StateCard message="Shows that have wrapped will show up here." testID="events-past-empty" title="No past events" />
      );
    }
    const rows = visible(upcoming);
    return rows.length > 0 ? (
      <View style={styles.list}>{rows.map((event) => renderCard(event))}</View>
    ) : (
      <StateCard message="New shows are announced here first." testID="events-upcoming-empty" title="No upcoming events" />
    );
  };

  const title = TABS.find((item) => item.value === tab)?.title ?? '';

  return (
    // A horizontal drag here pages the tab strip (back to Scan, forward to
    // Social); the two chip rows are `PageSwipeGuard`ed so dragging them
    // scrolls the chips instead.
    <View style={[styles.root, { backgroundColor: theme.colors.gray50 }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabBarBottomFadeHeight + (Platform.OS === 'ios' ? insets.bottom : 0) }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} tintColor={theme.colors.gray0} />}
        showsVerticalScrollIndicator={false}
        testID="events-scroll"
      >
        <View style={{ height: sheetTop }}>
          <Image accessibilityIgnoresInvertColors resizeMode="cover" source={headerImage} style={[styles.headerImage, { height: headerImageHeight }]} />
          {/* Darkens toward the sheet so the white logo and chips hold up (Figma 5865:9332). */}
          <Svg height={headerImageHeight} style={styles.scrim} width="100%">
            <Defs>
              <LinearGradient id="eventsHeaderScrim" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#666666" stopOpacity="0" />
                <Stop offset="0.557" stopColor="#414141" stopOpacity="0.25" />
                <Stop offset="1" stopColor="#000000" stopOpacity="0.5" />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#eventsHeaderScrim)" height={headerImageHeight} width="100%" x="0" y="0" />
          </Svg>
          <Image
            accessibilityLabel="Spotlight Card Show"
            resizeMode="contain"
            source={showLogo}
            style={[
              styles.logo,
              {
                top: chipRowTop - LOGO_ABOVE_CHIP_ROW - LOGO_HEIGHT,
                left: (windowWidth - LOGO_WIDTH) / 2 + LOGO_CENTER_OFFSET,
              },
            ]}
          />
          {/* Figma 5865:9334 — the chip row floats on the photo, just above the sheet. */}
          {isGuest ? null : (
            <PageSwipeGuard style={[styles.chipRow, { top: chipRowTop }]}>
            <ScrollView
              contentContainerStyle={[styles.chips, { paddingHorizontal: gutter }]}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              testID="events-tabs"
            >
              {TABS.map((item) => {
                const selected = item.value === tab;
                return (
                  <PillButton
                    key={item.value}
                    label={item.label.toUpperCase()}
                    // One chip style app-wide (Figma 5938:13960; user 2026-11-16), so the
                    // idle chip is gray-100 here too, not the photo's former gray-50.
                    labelRole="caption"
                    onPress={() => setTab(item.value)}
                    selected={selected}
                    testID={`events-tabs-tab-${item.value}`}
                    tone="filled"
                  />
                );
              })}
            </ScrollView>
            </PageSwipeGuard>
          )}
        </View>

        <View style={[styles.sheet, { backgroundColor: theme.colors.gray0 }]}>
          <Text
            style={[theme.typography.headline, { color: theme.colors.gray900, paddingHorizontal: gutter }]}
            testID="events-title"
          >
            {title.toUpperCase()}
          </Text>
          <PageSwipeGuard>
                        <PageTabs
              // Tight and centred like Social's tabs: the default 40pt gap is for
              // two tabs and spread five-plus regions apart (owner, 2026-11-19).
              align="gutter-center"
              labelSize="caption"
              onChange={setRegion}
              scrollable
              tabs={regionTabs}
              testID="events-regions"
              uppercase
              value={region}
            />
          </PageSwipeGuard>
        </View>
        <View style={[styles.listArea, { backgroundColor: theme.colors.gray50, paddingHorizontal: gutter }]}>
          {renderList()}
        </View>
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerImage: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  scrim: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  logo: {
    height: LOGO_HEIGHT,
    position: 'absolute',
    width: LOGO_WIDTH,
  },
  chipRow: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
  chips: {
    gap: spacing.xxs,
  },
  sheet: {
    borderCurve: 'continuous',
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    gap: spacing.lg,
    paddingTop: spacing.lg,
  },
  listArea: {
    paddingTop: spacing.sm,
  },
  list: {
    gap: spacing.xs,
  },
});
