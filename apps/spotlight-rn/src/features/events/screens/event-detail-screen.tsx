import { useCallback, useRef } from 'react';
import { Linking, Platform, Pressable, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
// Gesture-handler's ScrollView so the floor map's pan can block it while zoomed.
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Clock, Heart, HeartSolid, MapsArrowDiagonal, NavArrowLeft, PeopleTag, ShareIos } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import {
  Button,
  GlassNavBubble,
  GlassNavBubbleGroup,
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

import { EventFlyer } from '@/features/events/components/event-flyer';
import { EventVendorsSection } from '@/features/events/components/event-vendors-section';
import { formatEventSchedule, formatEventShareMessage } from '@/features/events/event-format';
import { useSpotlightEvent } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';

// Figma 5528:730. Gradient band 400 tall; flyer 237×296 at 70 under the status bar.
const GRADIENT_HEIGHT = 400;
const FLYER_WIDTH = 237;
const FLYER_HEIGHT = 296;
const FLYER_TOP_BELOW_STATUS_BAR = 70;
const ICON_SIZE = 20;

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
    const message = formatEventShareMessage(event);
    void Share.share(event.shareUrl ? { message, url: event.shareUrl } : { message }).catch(() => undefined);
  }, [event]);

  const bodyText = [theme.typography.body, { color: theme.colors.gray700 }];

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
        <View style={styles.heading}>
          <Text style={theme.typography.detailTitleBold} testID="event-detail-title">
            {event.title}
          </Text>
          <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>{formatEventSchedule(event)}</Text>
        </View>

        <View style={styles.section}>
          <SectionTitle title="About" />
          <View style={styles.rows}>
            <View style={styles.row}>
              <Clock color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
              <Text style={bodyText}>{formatEventSchedule(event)}</Text>
            </View>
            {event.tableCount ? (
              <View style={styles.row}>
                <PeopleTag color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
                <Text style={bodyText}>{`${event.tableCount}+ Tables`}</Text>
              </View>
            ) : null}
            {event.about ? <Text style={bodyText}>{event.about}</Text> : null}
          </View>
          {event.categories.length > 0 ? (
            <View style={styles.tags} testID="event-detail-categories">
              {event.categories.map((category) => (
                <View key={category} style={[styles.tag, { backgroundColor: theme.colors.gray100 }]}>
                  <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>{category}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <SectionTitle title="Location" />
          <Pressable
            accessibilityHint="Opens in Maps"
            accessibilityRole="link"
            onPress={() => openEventInMaps(event)}
            style={styles.row}
            testID="event-detail-address"
          >
            <MapsArrowDiagonal color={theme.colors.gray700} height={ICON_SIZE} strokeWidth={1.5} width={ICON_SIZE} />
            <Text style={[bodyText, styles.shrink]}>{event.address}</Text>
          </Pressable>
          {/* The embedded Apple map is off for now; the address row opens Maps. EventMap stays for later. */}
        </View>

        {event.floorMapUrl ? (
          <EventVendorsSection
            floorMapUrl={event.floorMapUrl}
            renderTitle={(title) => <SectionTitle title={title} />}
            scrollGesture={scrollRef}
          />
        ) : null}
      </>
    );
  };

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
        {/* Flyer-colored wash fading to white (Figma 5528:731). */}
        <Svg height={GRADIENT_HEIGHT} style={styles.gradient} width={windowWidth}>
          <Defs>
            <LinearGradient id="eventDetailWash" x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor={accent} stopOpacity="1" />
              <Stop offset="0.75" stopColor={accent} stopOpacity="0.5" />
              <Stop offset="1" stopColor={theme.colors.gray0} stopOpacity="1" />
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
            variant="accent"
          />
        </View>
      ) : null}
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.sectionTitle}>
      <Text
        style={[
          theme.typography.body,
          // Figma Body-medium: the 15pt body size at medium weight.
          { color: theme.colors.gray800, fontFamily: theme.typography.bodyMedium.fontFamily },
        ]}
      >
        {title}
      </Text>
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
    paddingTop: spacing.xxxl,
  },
  loading: {
    gap: spacing.xs,
  },
  heading: {
    gap: spacing.xs,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    gap: spacing.xxs,
  },
  rule: {
    height: 1,
  },
  rows: {
    gap: spacing.sm,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  shrink: {
    flexShrink: 1,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxxs,
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
