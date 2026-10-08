import { Pressable, StyleSheet, View } from 'react-native';
import { MapPin } from 'iconoir-react-native';

import type { SpotlightEvent } from '@spotlight/api-client';
import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { formatEventDateRange } from '@/features/events/event-format';

import { EventFlyer } from './event-flyer';

// Figma 5476:7214 — 353×148 card, 125×132 flyer inset 8.
export const FEATURED_EVENT_CARD_WIDTH = 353;
const CARD_HEIGHT = 148;
const FLYER_INSET = spacing.xxs;
const FLYER_WIDTH = 125;
const FLYER_HEIGHT = 132;
const FLYER_RADIUS = 6;

type FeaturedEventCardProps = {
  event: SpotlightEvent;
  width: number;
  onPress: () => void;
};

export function FeaturedEventCard({ event, width, onPress }: FeaturedEventCardProps) {
  const theme = useSpotlightTheme();
  const secondary = [theme.typography.bodySmall, { color: theme.colors.gray700 }];

  return (
    <Pressable
      accessibilityLabel={`Featured: ${event.shortTitle}, ${formatEventDateRange(event)}, ${event.city}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.85 : 1, width },
      ]}
      testID={`featured-event-${event.id}`}
    >
      <EventFlyer height={FLYER_HEIGHT} radius={FLYER_RADIUS} uri={event.flyerUrl} width={FLYER_WIDTH} />
      <View style={styles.details}>
        <Text numberOfLines={2} style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>
          {event.shortTitle}
        </Text>
        <Text style={secondary}>{formatEventDateRange(event)}</Text>
        <View style={styles.location}>
          <MapPin color={theme.colors.gray700} height={16} strokeWidth={1.5} width={16} />
          <Text numberOfLines={1} style={secondary}>
            {event.city}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.sm,
    height: CARD_HEIGHT,
    overflow: 'hidden',
    padding: FLYER_INSET,
  },
  details: {
    flex: 1,
    gap: spacing.xxxs,
    minWidth: 0,
    paddingRight: spacing.sm,
  },
  location: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
});
