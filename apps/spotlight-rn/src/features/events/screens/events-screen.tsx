import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Image, Platform, RefreshControl, ScrollView, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Menu, ShareIos } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import {
  GlassNavBubble,
  PageTabs,
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
import { formatEventDateRange } from '@/features/events/event-format';
import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';
import { useAppDrawer } from '@/providers/app-drawer-provider';

export type EventsTab = 'events' | 'tickets' | 'saved';

const TABS = [
  { value: 'events', label: 'Events' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'saved', label: 'Saved' },
] as const;

// Figma 5476:7127. The photo runs 328 tall; the white sheet laps it at 261.
const HEADER_IMAGE_HEIGHT = 328;
const HEADER_SCRIM_HEIGHT = 285;
const SHEET_TOP = 261;
const SHEET_RADIUS = radii.xl;
// Logo 203×170, sitting 8 under the status bar and 11 left of center.
const LOGO_WIDTH = 203;
const LOGO_HEIGHT = 170;
const LOGO_TOP_BELOW_STATUS_BAR = spacing.xxs;
const LOGO_CENTER_OFFSET = -11;

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

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { openDrawer } = useAppDrawer();
  const { events, failed, refresh } = useSpotlightEvents();
  const { isSaved, savedIds, toggle } = useSavedEvents();
  const [tab, setTab] = useState<EventsTab>('events');
  const [refreshing, setRefreshing] = useState(false);

  const upcoming = useMemo(() => events.filter((event) => event.status !== 'past'), [events]);
  const past = useMemo(() => events.filter((event) => event.status === 'past'), [events]);
  const tickets = useMemo(() => selectTicketEvents(events), [events]);
  const saved = useMemo(() => events.filter((event) => savedIds.has(event.id)), [events, savedIds]);

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

  const renderCard = (event: SpotlightEvent, onPress: () => void = () => openEvent(event)) => (
    <EventListCard
      key={event.id}
      event={event}
      onPress={onPress}
      onToggleSaved={() => toggle(event.id)}
      saved={isSaved(event.id)}
    />
  );

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
      return tickets.length > 0 ? (
        // Tickets are sold on the web; the row goes straight to the checkout.
        <View style={styles.list}>
          {tickets.map((event) => renderCard(event, () => void openLinkOut(event.ticketUrl ?? '')))}
        </View>
      ) : (
        <StateCard message="Check back closer to the next show." testID="events-tickets-empty" title="No tickets on sale yet" />
      );
    }
    if (tab === 'saved') {
      return saved.length > 0 ? (
        <View style={styles.list}>{saved.map((event) => renderCard(event))}</View>
      ) : (
        <StateCard message="Tap the heart on a show to keep it here." testID="events-saved-empty" title="No saved events" />
      );
    }
    return (
      <View style={styles.list}>
        {upcoming.map((event) => renderCard(event))}
        {past.length > 0 ? (
          <>
            <Text style={[theme.typography.bodyMedium, styles.pastHeader, { color: theme.colors.gray600 }]}>
              Past events
            </Text>
            {past.map((event) => renderCard(event))}
          </>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabBarBottomFadeHeight + (Platform.OS === 'ios' ? insets.bottom : 0) }}
        contentInsetAdjustmentBehavior="never"
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} tintColor={theme.colors.gray0} />}
        showsVerticalScrollIndicator={false}
        testID="events-scroll"
      >
        <View style={{ height: SHEET_TOP }}>
          <Image accessibilityIgnoresInvertColors resizeMode="cover" source={headerImage} style={styles.headerImage} />
          {/* Darkens toward the sheet so the white logo holds up (Figma 5476:7129). */}
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
        </View>

        <View style={[styles.sheet, { backgroundColor: theme.colors.gray0 }]}>
          <View style={styles.tabs}>
            <PageTabs align="start" onChange={setTab} tabs={TABS} testID="events-tabs" value={tab} />
          </View>
          <View style={{ paddingHorizontal: gutter }}>{renderList()}</View>
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
        <GlassNavBubble accessibilityLabel="Share events" material="frost" onPress={handleShare} size="medium" testID="events-share">
          <ShareIos
            color={theme.colors.gray900}
            height={glassNavBubbleGlyphSize}
            strokeWidth={glassNavBubbleGlyphStrokeWidth}
            width={glassNavBubbleGlyphSize}
          />
        </GlassNavBubble>
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
  sheet: {
    borderCurve: 'continuous',
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingTop: spacing.lg,
  },
  tabs: {
    paddingBottom: spacing.sm,
  },
  list: {
    gap: spacing.sm,
  },
  pastHeader: {
    paddingTop: spacing.xxs,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
