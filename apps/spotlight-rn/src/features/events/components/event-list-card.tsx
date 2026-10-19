import { Pressable, StyleSheet, View } from 'react-native';
import { Heart, HeartSolid, MapPin } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import { Text, borderWidths, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { formatEventDateRange, formatEventHours } from '@/features/events/event-format';

import { EventFlyer } from './event-flyer';

// Figma 5865:9373 — white card, 10 padding, 117×123 flyer at 6pt corners.
const CARD_PADDING = 10;
const FLYER_HEIGHT = 123;
// The flyers are 4:5 portrait; a squarer box cropped their top and bottom.
const FLYER_WIDTH = Math.round((FLYER_HEIGHT * 4) / 5);
const FLYER_RADIUS = 6;
const HEART_SIZE = 20;
const PIN_SIZE = 16;
const TIMING_DIVIDER_HEIGHT = 16;

type EventListCardProps = {
  event: SpotlightEvent;
  saved: boolean;
  onPress: () => void;
  onToggleSaved: () => void;
};

/** One show in the Events list (Figma 5865:9373). Copy renders uppercase, as drawn. */
export function EventListCard({ event, saved, onPress, onToggleSaved }: EventListCardProps) {
  const theme = useSpotlightTheme();
  const hours = formatEventHours(event);
  const meta = [theme.typography.overline, { color: theme.colors.gray700 }];

  return (
    <Pressable
      accessibilityLabel={`${event.shortTitle}, ${formatEventDateRange(event)}, ${event.city}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: theme.colors.gray0, opacity: pressed ? 0.85 : 1 }]}
      testID={`event-card-${event.id}`}
    >
      <EventFlyer height={FLYER_HEIGHT} radius={FLYER_RADIUS} uri={event.flyerUrl} width={FLYER_WIDTH} />
      <View style={styles.details}>
        <View style={styles.summary}>
          <Text
            numberOfLines={1}
            style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}
          >
            {event.shortTitle.toUpperCase()}
          </Text>
          <Text numberOfLines={1} style={meta}>
            {event.venue.toUpperCase()}
          </Text>
          <View style={styles.timing}>
            <Text style={meta}>{formatEventDateRange(event).toUpperCase()}</Text>
            {hours ? (
              <>
                <View style={[styles.divider, { backgroundColor: theme.colors.gray300 }]} />
                <Text style={meta}>{hours.toUpperCase()}</Text>
              </>
            ) : null}
          </View>
        </View>
        <View style={styles.location}>
          <MapPin color={theme.colors.gray700} height={PIN_SIZE} strokeWidth={1.5} width={PIN_SIZE} />
          <Text numberOfLines={1} style={[theme.typography.body, { color: theme.colors.gray700 }]}>
            {event.city.toUpperCase()}
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
          <HeartSolid color={theme.colors.red500} height={HEART_SIZE} width={HEART_SIZE} />
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
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: CARD_PADDING,
  },
  details: {
    flex: 1,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  summary: {
    gap: spacing.xxxs,
    // Keep the title clear of the heart.
    paddingRight: HEART_SIZE + spacing.xxxs,
  },
  timing: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  divider: {
    height: TIMING_DIVIDER_HEIGHT,
    width: borderWidths.containerRule,
  },
  location: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  heart: {
    position: 'absolute',
    right: CARD_PADDING,
    top: CARD_PADDING,
  },
});
