import { Pressable, StyleSheet, View } from 'react-native';
import { Heart, HeartSolid, MapPin } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { formatEventDateRange, formatEventHours } from '@/features/events/event-format';

import { EventFlyer } from './event-flyer';

// Figma 5476:7156 — 117×123 flyer, 6pt corners.
const FLYER_WIDTH = 117;
const FLYER_HEIGHT = 123;
const FLYER_RADIUS = 6;
const HEART_SIZE = 20;
const PIN_SIZE = 16;

type EventListCardProps = {
  event: SpotlightEvent;
  saved: boolean;
  onPress: () => void;
  onToggleSaved: () => void;
};

/** One show in the Events list (Figma 5476:7156). */
export function EventListCard({ event, saved, onPress, onToggleSaved }: EventListCardProps) {
  const theme = useSpotlightTheme();
  const hours = formatEventHours(event);
  const secondary = [theme.typography.bodySmall, { color: theme.colors.gray700 }];

  return (
    <Pressable
      accessibilityLabel={`${event.shortTitle}, ${formatEventDateRange(event)}, ${event.city}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { borderColor: theme.colors.gray200, opacity: pressed ? 0.85 : 1 },
      ]}
      testID={`event-card-${event.id}`}
    >
      <EventFlyer height={FLYER_HEIGHT} radius={FLYER_RADIUS} uri={event.flyerUrl} width={FLYER_WIDTH} />
      <View style={styles.details}>
        <View style={styles.summary}>
          <Text numberOfLines={1} style={[theme.typography.feedRowTitle, styles.title, { color: theme.colors.gray900 }]}>
            {event.shortTitle}
          </Text>
          <Text numberOfLines={1} style={secondary}>
            {event.venue}
          </Text>
          <View style={styles.timing}>
            <Text style={secondary}>{formatEventDateRange(event)}</Text>
            {hours ? (
              <>
                <View style={[styles.divider, { backgroundColor: theme.colors.gray700 }]} />
                <Text style={secondary}>{hours}</Text>
              </>
            ) : null}
          </View>
        </View>
        <View style={styles.location}>
          <MapPin color={theme.colors.gray700} height={PIN_SIZE} strokeWidth={1.5} width={PIN_SIZE} />
          <Text numberOfLines={1} style={secondary}>
            {event.city}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityLabel={saved ? `Remove ${event.shortTitle} from saved events` : `Save ${event.shortTitle}`}
        accessibilityRole="button"
        accessibilityState={{ selected: saved }}
        hitSlop={spacing.xs}
        onPress={onToggleSaved}
        style={styles.heart}
        testID={`event-card-${event.id}-save`}
      >
        {saved ? (
          <HeartSolid color={theme.colors.gray900} height={HEART_SIZE} width={HEART_SIZE} />
        ) : (
          <Heart color={theme.colors.gray900} height={HEART_SIZE} strokeWidth={1.5} width={HEART_SIZE} />
        )}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: 10,
  },
  details: {
    flex: 1,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  summary: {
    gap: 2,
    // Keep the title clear of the heart.
    paddingRight: HEART_SIZE + spacing.xxxs,
  },
  title: {
    lineHeight: 19,
  },
  timing: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  divider: {
    height: 16,
    width: StyleSheet.hairlineWidth * 2,
  },
  location: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  heart: {
    position: 'absolute',
    right: 10,
    top: 10,
  },
});
