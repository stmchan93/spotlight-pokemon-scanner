import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Menu, Search, ShareIos, Xmark } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import {
  GlassNavBubble,
  GlassNavBubbleGroup,
  PageTabs,
  PillButton,
  SearchField,
  SkeletonBlock,
  StateCard,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  layout,
  radii,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EventListCard } from '@/features/events/components/event-list-card';
import { eventRegion, eventRegions, formatEventDateRange } from '@/features/events/event-format';
import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';
import { useAppDrawer } from '@/providers/app-drawer-provider';

export type EventsTab = 'events' | 'tickets' | 'saved' | 'past';

const TABS: readonly { value: EventsTab; label: string; title: string }[] = [
  { value: 'events', label: 'Events', title: 'Upcoming Spotlight events' },
  { value: 'tickets', label: 'Tickets', title: 'Tickets on sale' },
  { value: 'saved', label: 'Saved', title: 'Saved events' },
  { value: 'past', label: 'Past events', title: 'Past Spotlight events' },
];

const ALL_REGIONS = 'all';

// Figma 5865:9330. The photo runs 328 tall under a 348 scrim; the chip row sits
// at 256 and the white sheet laps the photo at 304.
const HEADER_IMAGE_HEIGHT = 328;
const HEADER_SCRIM_HEIGHT = 348;
const SHEET_TOP = 304;
const CHIP_ROW_TOP = 256;
const SHEET_RADIUS = radii.xl;
// Logo 203×170, sitting 8 under the status bar and 11 left of center.
const LOGO_WIDTH = 203;
const LOGO_HEIGHT = 170;
const LOGO_TOP_BELOW_STATUS_BAR = spacing.xxs;
const LOGO_CENTER_OFFSET = -11;
const SEARCH_ICON_SIZE = 16;

const headerImage = require('../../../../assets/images/events/events-header.jpg');
const showLogo = require('../../../../assets/images/events/spotlight-card-show-logo.png');

/** Events with a ticket link that can still be bought. */
export function selectTicketEvents(events: SpotlightEvent[]): SpotlightEvent[] {
  return events.filter((event) => event.ticketUrl && event.status !== 'past');
}

export function buildEventsShareMessage(events: SpotlightEvent[]): string {
  const upcoming = events.filter((event) => event.status !== 'past');
  const lines = upcoming.map((event) => `${event.shortTitle} · ${formatEventDateRange(event)} · ${event.city}`);
  return ['Spotlight Card Show — upcoming events', ...lines].join('\n');
}

/** Case-insensitive match on the title, venue or city. */
export function searchEvents(events: SpotlightEvent[], query: string): SpotlightEvent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return events;
  }
  return events.filter((event) =>
    [event.title, event.shortTitle, event.venue, event.city].some((text) => text.toLowerCase().includes(needle)),
  );
}

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { openDrawer } = useAppDrawer();
  const { events, failed, refresh } = useSpotlightEvents();
  const { isSaved, savedIds, toggle } = useSavedEvents();
  const [tab, setTab] = useState<EventsTab>('events');
  const [region, setRegion] = useState<string>(ALL_REGIONS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const upcoming = useMemo(() => events.filter((event) => event.status !== 'past'), [events]);
  const past = useMemo(() => events.filter((event) => event.status === 'past'), [events]);
  const tickets = useMemo(() => selectTicketEvents(events), [events]);
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

  const handleShare = useCallback(() => {
    void Share.share({ message: buildEventsShareMessage(events) }).catch(() => undefined);
  }, [events]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) {
        setQuery('');
      }
      return !open;
    });
  }, []);

  const renderCard = (event: SpotlightEvent, onPress: () => void = () => openEvent(event)) => (
    <EventListCard
      key={event.id}
      event={event}
      onPress={onPress}
      onToggleSaved={() => toggle(event.id)}
      saved={isSaved(event.id)}
    />
  );

  const inRegion = (list: SpotlightEvent[]) =>
    region === ALL_REGIONS ? list : list.filter((event) => eventRegion(event)?.value === region);
  const visible = (list: SpotlightEvent[]) => searchEvents(inRegion(list), query);

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
    if (tab === 'tickets') {
      const rows = visible(tickets);
      return rows.length > 0 ? (
        // Tickets are sold on the web; the row goes straight to the checkout.
        <View style={styles.list}>
          {rows.map((event) => renderCard(event, () => void openLinkOut(event.ticketUrl ?? '')))}
        </View>
      ) : (
        <StateCard message="Check back closer to the next show." testID="events-tickets-empty" title="No tickets on sale yet" />
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
    <View style={[styles.root, { backgroundColor: theme.colors.gray50 }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabBarBottomFadeHeight + (Platform.OS === 'ios' ? insets.bottom : 0) }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} tintColor={theme.colors.gray0} />}
        showsVerticalScrollIndicator={false}
        testID="events-scroll"
      >
        <View style={{ height: SHEET_TOP }}>
          <Image accessibilityIgnoresInvertColors resizeMode="cover" source={headerImage} style={styles.headerImage} />
          {/* Darkens toward the sheet so the white logo and chips hold up (Figma 5865:9332). */}
          <Svg height={HEADER_SCRIM_HEIGHT} style={styles.scrim} width="100%">
            <Defs>
              <LinearGradient id="eventsHeaderScrim" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#666666" stopOpacity="0" />
                <Stop offset="0.557" stopColor="#414141" stopOpacity="0.25" />
                <Stop offset="1" stopColor="#000000" stopOpacity="0.5" />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#eventsHeaderScrim)" height={HEADER_SCRIM_HEIGHT} width="100%" x="0" y="0" />
          </Svg>
          <Image
            accessibilityLabel="Spotlight Card Show"
            resizeMode="contain"
            source={showLogo}
            style={[
              styles.logo,
              {
                top: insets.top + LOGO_TOP_BELOW_STATUS_BAR,
                left: (windowWidth - LOGO_WIDTH) / 2 + LOGO_CENTER_OFFSET,
              },
            ]}
          />
          {/* Figma 5865:9334 — the chip row floats on the photo, just above the sheet. */}
          <ScrollView
            contentContainerStyle={[styles.chips, { paddingHorizontal: gutter }]}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.chipRow}
            testID="events-tabs"
          >
            {TABS.map((item) => {
              const selected = item.value === tab;
              return (
                <PillButton
                  key={item.value}
                  label={item.label.toUpperCase()}
                  onPress={() => setTab(item.value)}
                  selected={selected}
                  // Over the photo the idle chip is gray-50, not the rail's gray-100 (Figma 5865:9337).
                  style={selected ? null : { backgroundColor: theme.colors.gray50, borderColor: theme.colors.gray50 }}
                  testID={`events-tabs-tab-${item.value}`}
                  tone="filled"
                />
              );
            })}
          </ScrollView>
        </View>

        <View style={[styles.sheet, { backgroundColor: theme.colors.gray0 }]}>
          <Text
            style={[theme.typography.headline, styles.title, { color: theme.colors.gray900, paddingHorizontal: gutter }]}
            testID="events-title"
          >
            {title}
          </Text>
          {searchOpen ? (
            <View style={{ paddingHorizontal: gutter }}>
              <SearchField
                accessibilityLabel="Search events"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                leading={<Search color={theme.colors.gray500} height={SEARCH_ICON_SIZE} width={SEARCH_ICON_SIZE} />}
                onChangeText={setQuery}
                placeholder="SEARCH BY SHOW, VENUE OR CITY"
                returnKeyType="search"
                size="collection"
                surface="muted"
                testID="events-search-field"
                trailing={
                  <Pressable accessibilityLabel="Close search" hitSlop={spacing.xxs} onPress={toggleSearch}>
                    <Xmark color={theme.colors.gray500} height={SEARCH_ICON_SIZE} width={SEARCH_ICON_SIZE} />
                  </Pressable>
                }
                value={query}
              />
            </View>
          ) : null}
          <PageTabs onChange={setRegion} scrollable size="compact" tabs={regionTabs} testID="events-regions" value={region} />
        </View>
        <View style={[styles.listArea, { backgroundColor: theme.colors.gray50, paddingHorizontal: gutter }]}>
          {renderList()}
        </View>
      </ScrollView>

      {/* Fixed chrome over the photo, so the drawer stays one tap away. */}
      <View pointerEvents="box-none" style={[styles.toolbar, { paddingHorizontal: gutter, top: insets.top }]}>
        <GlassNavBubble accessibilityLabel="Open menu" material="frost" onPress={openDrawer} size="medium" testID="events-menu">
          <Menu
            color={theme.colors.gray900}
            height={glassNavBubbleGlyphSize}
            strokeWidth={glassNavBubbleGlyphStrokeWidth}
            width={glassNavBubbleGlyphSize}
          />
        </GlassNavBubble>
        <GlassNavBubbleGroup
          items={[
            {
              accessibilityLabel: searchOpen ? 'Close search' : 'Search events',
              children: (
                <Search
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              ),
              onPress: toggleSearch,
              testID: 'events-search',
            },
            {
              accessibilityLabel: 'Share events',
              children: (
                <ShareIos
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              ),
              onPress: handleShare,
              testID: 'events-share',
            },
          ]}
          material="frost"
          size="medium"
          testID="events-actions"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerImage: {
    height: HEADER_IMAGE_HEIGHT,
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
    top: CHIP_ROW_TOP,
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
  title: {
    textTransform: 'uppercase',
  },
  listArea: {
    paddingTop: spacing.sm,
  },
  list: {
    gap: spacing.xs,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
