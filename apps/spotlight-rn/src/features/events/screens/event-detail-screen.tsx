import { useCallback, useRef } from 'react';
import { Image, Linking, Platform, Pressable, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
// Gesture-handler's ScrollView so the floor map's pan can block it while zoomed.
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Clock, Heart, HeartSolid, MapsArrowDiagonal, NavArrowLeft, PeopleTag, ShareIos } from 'iconoir-react-native';

import type { SpotlightEvent, SpotlightEventPricing } from '@spotlight/api-client';
import {
  Button,
  GlassNavBubble,
  GlassNavBubbleGroup,
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

import { EventFlyer } from '@/features/events/components/event-flyer';
import { EventVendorsSection } from '@/features/events/components/event-vendors-section';
import { eventGradientStops } from '@/features/events/event-accent';
import { formatEventSchedule, formatEventShareMessage } from '@/features/events/event-format';
import { useSpotlightEvent } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';

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

const ticketIcon = require('../../../../assets/images/events/ticket-icon.png');

type EventDetailScreenProps = {
  eventId: string;
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

export function EventDetailScreen({ eventId, onBack }: EventDetailScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { event, failed, refresh } = useSpotlightEvent(eventId);
  const { isSaved, toggle } = useSavedEvents();
  const scrollRef = useRef<ScrollView>(null);
  const saved = isSaved(eventId);
  const accent = event?.accentColor ?? theme.colors.eventAccent;
  const canBuy = Boolean(event?.ticketUrl) && event?.status !== 'past';

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

        {event.floorMapUrl ? (
          <EventVendorsSection
            floorMapUrl={event.floorMapUrl}
            renderTitle={(title) => <SectionTitle title={title} />}
            scrollGesture={scrollRef}
            scrollRef={scrollRef}
          />
        ) : null}
      </>
    );
  };

  const stops = eventGradientStops(accent);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl + (canBuy ? 0 : insets.bottom) }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        ref={scrollRef}
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
function SectionTitle({ title }: { title: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.sectionTitle}>
      <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray800 }]}>{title.toUpperCase()}</Text>
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
  details: {
    gap: spacing.sm,
  },
  sectionTitle: {
    gap: spacing.xxs,
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
