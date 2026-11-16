import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
// Gesture-handler's ScrollView so the floor map's pan can block it while zoomed.
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Clock, Heart, HeartSolid, MapsArrowDiagonal, NavArrowLeft, PeopleTag, ShareIos } from 'iconoir-react-native';

import type { SpotlightEvent, SpotlightEventPricing } from '@spotlight/api-client';
import {
  Button,
  GlassNavBubble,
  GlassNavBubbleGroup,
  SegmentedControl,
  SkeletonBlock,
  StateCard,
  borderWidths,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  layout,
  radii,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { buildBoothStories, orderBoothStories, storyRing } from '@/features/events/booth-stories';
import {
  publishBoothStoriesSource,
  subscribeBoothVendorSelect,
  useSeenBoothPosts,
} from '@/features/events/booth-stories-store';
import { MIN_BROWSING_SHOWN, buildBoothTickerItems } from '@/features/events/booth-ticker';
import { BoothLiveTicker } from '@/features/events/components/booth-live-ticker';
import { BoothStoriesStrip } from '@/features/events/components/booth-stories-strip';
import { EventFeed, type EventFeedHandle } from '@/features/events/components/event-feed';
import { EventFlyer } from '@/features/events/components/event-flyer';
import {
  EventVendorsSection,
  type VendorSelectRequest,
  type VendorStories,
} from '@/features/events/components/event-vendors-section';
import { eventGradientStops } from '@/features/events/event-accent';
import { formatEventSchedule, formatEventShareMessage } from '@/features/events/event-format';
import { isInBoothWindow, useActiveShow } from '@/features/events/hooks/use-active-show';
import { useBoothFloor } from '@/features/events/hooks/use-booth-floor';
import { useEventPresence } from '@/features/events/hooks/use-event-presence';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';
import { useSpotlightEvent } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

// Figma 5882:12594. Gradient band 400 tall; flyer 237×296 at 70 under the status bar.
const GRADIENT_HEIGHT = 400;
const FLYER_WIDTH = 237;
const FLYER_HEIGHT = 296;
const FLYER_TOP_BELOW_STATUS_BAR = 70;
const ICON_SIZE = 20;
// Figma 5882:12628 "train_ticket" — 16×12.29; iconoir has no ticket glyph, so it ships as a 48×37 PNG (3x) drawn at 16×12.
const TICKET_ICON_WIDTH = 16;
const TICKET_ICON_HEIGHT = 12;
// Figma 5882:12631: 15pt bullets on a 26pt line.
const PRICING_NOTE_LINE_HEIGHT = 26;
const PRICING_NOTE_INDENT = 22;
const DISCLAIMER_RADIUS = 6;
/** Feed mode pages in once the scroll is this close to the end. */
const FEED_LOAD_MORE_DISTANCE = 600;

type ShowArea = 'map' | 'feed';
const SHOW_AREA_ITEMS = [
  { label: 'Map', value: 'map' },
  { label: 'Feed', value: 'feed' },
] as const;

const ticketIcon = require('../../../../assets/images/events/ticket-icon.png');

type EventDetailScreenProps = {
  eventId: string;
  /** `?vendor=<id>` from a deep link: selected on the map once it loads. */
  initialVendorId?: string | null;
  onBack: () => void;
};

export function openEventInMaps(event: Pick<SpotlightEvent, 'address' | 'latitude' | 'longitude' | 'title'>): void {
  const query = encodeURIComponent(event.address || event.title);
  const coords = event.latitude != null && event.longitude != null ? `${event.latitude},${event.longitude}` : null;
  const url =
    Platform.OS === 'ios'
      ? `http://maps.apple.com/?q=${query}${coords ? `&ll=${coords}` : ''}`
      : `geo:${coords ?? '0,0'}?q=${coords ? `${coords}(${encodeURIComponent(event.title)})` : query}`;
  void Linking.openURL(url).catch(() => undefined);
}

/** "$10 GENERAL ($15 AT THE DOOR)" — the PRICING headline (Figma 5882:12630). */
export function formatTicketPrice(pricing: Pick<SpotlightEventPricing, 'general' | 'doorPrice'>): string {
  return pricing.doorPrice ? `${pricing.general} (${pricing.doorPrice})` : pricing.general;
}

export function EventDetailScreen({ eventId, initialVendorId = null, onBack }: EventDetailScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { event, failed, refresh } = useSpotlightEvent(eventId);
  const { isSaved, toggle } = useSavedEvents();
  const scrollRef = useRef<ScrollView>(null);
  const saved = isSaved(eventId);
  const accent = event?.accentColor ?? theme.colors.eventAccent;
  const canBuy = Boolean(event?.ticketUrl) && event?.status !== 'past';
  // Same cached read the vendors section makes; the ticker and stories need vendor names.
  const { map } = useSpotlightEventMap(event?.floorMapUrl ?? null);
  const vendorIds = useMemo(() => map?.vendors.map((vendor) => vendor.id) ?? null, [map]);
  const booth = useBoothFloor(eventId, vendorIds);
  const browsingNow = useEventPresence(eventId);
  const [selectRequest, setSelectRequest] = useState<VendorSelectRequest | null>(
    initialVendorId ? { vendorId: initialVendorId, key: 0 } : null,
  );
  const selectVendor = useCallback(
    (vendorId: string) => setSelectRequest((current) => ({ vendorId, key: (current?.key ?? 0) + 1 })),
    [],
  );
  const [showArea, setShowArea] = useState<ShowArea>('map');
  // Ticker, story and "View booth" picks land on the map, whichever tab is open.
  const selectOnMap = useCallback(
    (vendorId: string) => {
      setShowArea('map');
      selectVendor(vendorId);
    },
    [selectVendor],
  );

  // Live ticker: only while the show is in its booth window (staging: the stand-in show).
  const activeShow = useActiveShow();
  const [now] = useState(() => new Date());
  const live = event != null && (activeShow?.id === eventId || isInBoothWindow(event, now));
  const tickerItems = useMemo(
    () =>
      live && map
        ? buildBoothTickerItems({ browsingNow })
        : [],
    [browsingNow, live, map],
  );

  // Booth stories: photo posts from the last day. Images stream with a bearer token only.
  const router = useRouter();
  const { accessToken } = useAuth();
  const canShowStories = Boolean(accessToken && resolveRepositoryBaseUrl());
  const { seenPostIds } = useSeenBoothPosts();
  const stories = useMemo(
    () => (canShowStories && map ? buildBoothStories(booth.posts, new Set(vendorIds ?? [])) : []),
    [booth.posts, canShowStories, map, vendorIds],
  );
  const orderedStories = useMemo(() => orderBoothStories(stories, seenPostIds), [seenPostIds, stories]);
  const openStory = useCallback(
    (vendorId: string, source: 'strip' | 'row' | 'card') => {
      capturePostHogEvent(AnalyticsEvent.boothStoryOpened, { event_id: eventId, vendor_id: vendorId, source });
      router.push({ pathname: '/booth-stories', params: { eventId, vendorId } } as never);
    },
    [eventId, router],
  );
  const vendorStories = useMemo<VendorStories | null>(() => {
    if (stories.length === 0) {
      return null;
    }
    const byVendor = new Map(stories.map((story) => [story.vendorId, story]));
    return { ringFor: (vendorId) => storyRing(byVendor.get(vendorId), seenPostIds), open: openStory };
  }, [openStory, seenPostIds, stories]);

  // The viewer reads what this page already loaded, and asks it to select on "View booth".
  useEffect(() => {
    publishBoothStoriesSource(eventId, { posts: booth.posts, claims: booth.claims });
  }, [booth.claims, booth.posts, eventId]);
  useEffect(
    () =>
      subscribeBoothVendorSelect((requestedEventId, vendorId) => {
        if (requestedEventId === eventId) {
          selectOnMap(vendorId);
        }
      }),
    [eventId, selectOnMap],
  );
  const feedRef = useRef<EventFeedHandle>(null);
  const feedVisible = showArea === 'feed' || !event?.floorMapUrl;
  // Mounted on first visit and kept, so switching tabs neither refetches nor collapses the page.
  const [feedMounted, setFeedMounted] = useState(feedVisible);
  useEffect(() => {
    if (feedVisible) {
      setFeedMounted(true);
    }
  }, [feedVisible]);
  const handleScroll = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
      if (feedVisible && contentOffset.y + layoutMeasurement.height >= contentSize.height - FEED_LOAD_MORE_DISTANCE) {
        feedRef.current?.loadMore();
      }
    },
    [feedVisible],
  );

  const handleShare = useCallback(() => {
    if (!event) {
      return;
    }
    const url = event.shareUrl;
    // Just the link when there is one (the page previews itself); Android has no `url` field.
    const payload = !url
      ? { message: formatEventShareMessage(event) }
      : Platform.OS === 'ios'
        ? { url }
        : { message: url };
    void Share.share(payload).catch(() => undefined);
  }, [event]);

  const rowText = [theme.typography.body, { color: theme.colors.gray700 }];

  const renderPricing = (pricing: SpotlightEventPricing) => (
    <View style={styles.pricing} testID="event-detail-pricing">
      <SectionTitle title="Pricing" />
      <View style={styles.ticketPricing}>
        <View style={styles.ticketPrice}>
          <Image
            accessibilityIgnoresInvertColors
            source={ticketIcon}
            style={[styles.ticketIcon, { tintColor: theme.colors.gray900 }]}
          />
          <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
            {formatTicketPrice(pricing).toUpperCase()}
          </Text>
        </View>
        {pricing.notes.map((note) => (
          <View key={note} style={styles.note}>
            <Text style={[theme.typography.body, styles.noteText, styles.bullet, { color: theme.colors.gray700 }]}>
              {'•'}
            </Text>
            <Text style={[theme.typography.body, styles.noteText, styles.shrink, { color: theme.colors.gray700 }]}>
              {note.toUpperCase()}
            </Text>
          </View>
        ))}
      </View>
      {pricing.disclaimer ? (
        <View style={[styles.disclaimer, { backgroundColor: theme.colors.gray100 }]}>
          <Text style={[theme.typography.overline, styles.shrink, { color: theme.colors.gray800 }]}>
            {pricing.disclaimer.toUpperCase()}
          </Text>
        </View>
      ) : null}
    </View>
  );

  const renderBody = () => {
    if (!event) {
      return failed ? (
        <StateCard
          actionLabel="Try again"
          message="This event couldn't be loaded."
          onActionPress={() => void refresh()}
          testID="event-detail-error"
          title="Event unavailable"
        />
      ) : (
        <View style={styles.loading} testID="event-detail-loading">
          <SkeletonBlock height={24} width="80%" />
          <SkeletonBlock height={18} width="50%" />
        </View>
      );
    }
    return (
      <>
        {/* Figma 5882:12716 — title, schedule rows, category tags. */}
        <View style={styles.details}>
          <Text style={theme.typography.detailTitleBold} testID="event-detail-title">
            {event.title.toUpperCase()}
          </Text>
          <View style={styles.rows}>
            <View style={styles.row}>
              <Clock color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
              <Text style={rowText}>{formatEventSchedule(event).toUpperCase()}</Text>
            </View>
            <Pressable
              accessibilityHint="Opens in Maps"
              accessibilityRole="link"
              onPress={() => openEventInMaps(event)}
              style={[styles.row, styles.rowTop]}
              testID="event-detail-address"
            >
              <MapsArrowDiagonal color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
              <Text style={[rowText, styles.shrink]}>{event.address.toUpperCase()}</Text>
            </Pressable>
            {event.tableCount ? (
              <View style={styles.row}>
                <PeopleTag color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
                <Text style={rowText}>{`${event.tableCount}+ TABLES`}</Text>
              </View>
            ) : null}
            {event.about ? (
              <Text style={[theme.typography.body, { color: theme.colors.gray700 }]}>{event.about}</Text>
            ) : null}
          </View>
          {/* No category chips (Pokemon, Sports…) under the details: user call, 2026-10-18. */}
        </View>

        {event.pricing ? renderPricing(event.pricing) : null}

        {/* Map | Feed: the floor (vendors, booth photos) or every post tagged to the show. */}
        <View style={styles.showArea}>
          <BoothLiveTicker items={tickerItems} onSelectVendor={selectOnMap} />
          {event.floorMapUrl ? (
            <SegmentedControl
              items={SHOW_AREA_ITEMS}
              onChange={setShowArea}
              testID="event-detail-show-area"
              value={showArea}
            />
          ) : (
            <SectionTitle title="Feed" />
          )}
          {/*
            Both panes stay mounted and the hidden one is display:none. Swapping
            them shrank the page under the reader's scroll offset (the feed opens
            as a short loading card) and iOS snapped it up to the top. The
            screen-tall floor keeps the switch from ever shortening the page.
          */}
          <View style={{ minHeight: windowHeight }}>
            {feedMounted ? (
              <View style={feedVisible ? null : styles.hiddenPane} testID="event-detail-feed-pane">
                <EventFeed eventId={eventId} ref={feedRef} testID="event-feed" />
              </View>
            ) : null}
            {event.floorMapUrl ? (
              <View style={[styles.mapArea, feedVisible ? styles.hiddenPane : null]} testID="event-detail-map-pane">
                {map ? (
                  <BoothStoriesStrip
                    onOpen={(vendorId) => openStory(vendorId, 'strip')}
                    seenPostIds={seenPostIds}
                    stories={orderedStories}
                    vendors={map.vendors}
                  />
                ) : null}

                {event.floorMapUrl ? (
                  <EventVendorsSection
                    booth={booth.enabled ? booth : null}
                    eventId={eventId}
                    floorMapUrl={event.floorMapUrl}
                    renderTitle={(title) => (
                      <SectionTitle
                        title={title}
                        trailing={
                          browsingNow != null && browsingNow >= MIN_BROWSING_SHOWN ? `${browsingNow} people browsing now` : null
                        }
                      />
                    )}
                    scrollGesture={scrollRef}
                    scrollRef={scrollRef}
                    selectRequest={selectRequest}
                    stories={vendorStories}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </>
    );
  };

  const stops = eventGradientStops(accent);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl + (canBuy ? 0 : insets.bottom) }}
        contentInsetAdjustmentBehavior="never"
        // iOS: room to scroll the vendor search above the keyboard even when results are short.
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        ref={scrollRef}
        scrollEventThrottle={64}
        showsVerticalScrollIndicator={false}
        testID="event-detail-scroll"
      >
        {/* Accent wash fading to white (Figma 5882:12595). */}
        <Svg height={GRADIENT_HEIGHT} style={styles.gradient} width={windowWidth}>
          <Defs>
            <LinearGradient id="eventDetailWash" x1="0" x2="0" y1="0" y2="1">
              {stops.map((stop) => (
                <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} stopOpacity="1" />
              ))}
            </LinearGradient>
          </Defs>
          <Rect fill="url(#eventDetailWash)" height={GRADIENT_HEIGHT} width={windowWidth} x="0" y="0" />
        </Svg>
        <View style={[styles.flyerRow, { paddingTop: insets.top + FLYER_TOP_BELOW_STATUS_BAR }]}>
          <EventFlyer
            height={FLYER_HEIGHT}
            radius={radii.sm}
            testID="event-detail-flyer"
            uri={event?.flyerUrl ?? null}
            width={FLYER_WIDTH}
          />
        </View>
        <View style={styles.body}>{renderBody()}</View>
      </ScrollView>

      <View pointerEvents="box-none" style={[styles.toolbar, { top: insets.top }]}>
        <GlassNavBubble accessibilityLabel="Go back" material="frost" onPress={onBack} size="medium" testID="event-detail-back">
          <NavArrowLeft
            color={theme.colors.gray900}
            height={glassNavBubbleGlyphSize}
            strokeWidth={glassNavBubbleGlyphStrokeWidth}
            width={glassNavBubbleGlyphSize}
          />
        </GlassNavBubble>
        <GlassNavBubbleGroup
          items={[
            {
              accessibilityLabel: saved ? 'Remove from saved events' : 'Save event',
              children: saved ? (
                <HeartSolid color={theme.colors.red500} height={glassNavBubbleGlyphSize} width={glassNavBubbleGlyphSize} />
              ) : (
                <Heart
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              ),
              onPress: () => toggle(eventId),
              testID: 'event-detail-save',
            },
            {
              accessibilityLabel: 'Share event',
              children: (
                <ShareIos
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              ),
              disabled: !event,
              onPress: handleShare,
              testID: 'event-detail-share',
            },
          ]}
          material="frost"
          size="medium"
          testID="event-detail-actions"
        />
      </View>

      {canBuy && event?.ticketUrl ? (
        <View
          style={[
            styles.footer,
            { backgroundColor: theme.colors.gray0, paddingBottom: Math.max(insets.bottom, spacing.sm) },
          ]}
        >
          <Button
            label="Buy Tickets"
            labelStyleVariant="label"
            onPress={() => void openLinkOut(event.ticketUrl ?? '')}
            shape="rounded"
            size="xs"
            style={styles.buy}
            testID="event-detail-buy"
            uppercase
            variant="accent"
          />
        </View>
      ) : null}
    </View>
  );
}

/** Figma 5882:12622 — 15pt bold gray-800 title over a hairline. */
function SectionTitle({ title, trailing }: { title: string; trailing?: string | null }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.sectionTitle}>
      <View style={styles.sectionTitleRow}>
        <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray800 }]}>{title.toUpperCase()}</Text>
        {trailing ? (
          <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID="event-browsing-now">
            {trailing}
          </Text>
        ) : null}
      </View>
      <View style={[styles.rule, { backgroundColor: theme.colors.gray200 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  gradient: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  flyerRow: {
    alignItems: 'center',
  },
  body: {
    gap: spacing.xxxl,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.lg,
  },
  loading: {
    gap: spacing.xs,
  },
  showArea: {
    gap: spacing.lg,
  },
  hiddenPane: {
    display: 'none',
  },
  mapArea: {
    gap: spacing.xxxl,
  },
  details: {
    gap: spacing.sm,
  },
  sectionTitle: {
    gap: spacing.xxs,
  },
  sectionTitleRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rule: {
    height: borderWidths.containerRule,
  },
  rows: {
    gap: spacing.xxs,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  // The address can wrap; its arrow stays on the first line.
  rowTop: {
    alignItems: 'flex-start',
    gap: spacing.xxxs,
  },
  shrink: {
    flexShrink: 1,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  // Figma 5882:12730 — 10/6 padding, radius 8.
  tag: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pricing: {
    gap: spacing.sm,
  },
  ticketPricing: {
    gap: spacing.xxs,
  },
  ticketPrice: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  ticketIcon: {
    height: TICKET_ICON_HEIGHT,
    width: TICKET_ICON_WIDTH,
  },
  note: {
    flexDirection: 'row',
  },
  noteText: {
    lineHeight: PRICING_NOTE_LINE_HEIGHT,
  },
  bullet: {
    textAlign: 'center',
    width: PRICING_NOTE_INDENT,
  },
  // Figma 5882:12632 — 16/12 padding, radius 6.
  disclaimer: {
    borderCurve: 'continuous',
    borderRadius: DISCLAIMER_RADIUS,
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: layout.pageGutter,
    position: 'absolute',
    right: 0,
  },
  footer: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: 10,
  },
  buy: {
    alignSelf: 'stretch',
  },
});
