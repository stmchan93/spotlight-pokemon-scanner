import { StyleSheet, View } from 'react-native';

import type { CalendarEvent, CalendarFeed } from '@spotlight/api-client';
import { CalendarEventRow, useSpotlightTheme } from '@spotlight/design-system';

import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import { calendarDateParts, calendarKindLabel } from '@/features/meta-feed/screens/components/meta-format';

/** Dates the feed block shows; "All dates ›" opens the rest. */
export const COMING_UP_BLOCK_ROWS = 3;

export function hasComingUpContent(feed: CalendarFeed | null): boolean {
  return feed != null && feed.items.length > 0;
}

/** Whether tapping the event goes anywhere (set page or its source). */
export function isCalendarEventActionable(event: CalendarEvent): boolean {
  return Boolean(event.setId || event.url);
}

export type ComingUpBlockProps = {
  feed: CalendarFeed | null;
  /** "All dates ›"; the feed pushes `/calendar`. */
  onOpenCalendar?: () => void;
  /** Row taps; see `openCalendarEvent`. */
  onOpenEvent?: (event: CalendarEvent) => void;
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Coming up" (docs/meta-feed-mockup/v2/FeedV6.dc.html): the next
 * three dates that move prices — releases, ban lists, reveals. Hidden when
 * there are none or the feature is off.
 */
export function ComingUpBlock({
  feed,
  onOpenCalendar,
  onOpenEvent,
  showBand = true,
  testID = 'coming-up',
}: ComingUpBlockProps) {
  const theme = useSpotlightTheme();
  if (!feed || !hasComingUpContent(feed)) {
    return null;
  }
  const events = feed.items.slice(0, COMING_UP_BLOCK_ROWS);

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <MetaBlockHeader
        actionLabel="All dates ›"
        onPressAction={onOpenCalendar}
        size="large"
        testID={`${testID}-header`}
        title="Coming up"
      />
      <View style={styles.list}>
        {events.map((event) => {
          const { month, day } = calendarDateParts(event.date);
          return (
            <CalendarEventRow
              dayLabel={day}
              key={event.id}
              kindLabel={calendarKindLabel(event.kind)}
              kindTone={event.kind}
              monthLabel={month}
              onPress={onOpenEvent && isCalendarEventActionable(event) ? () => onOpenEvent(event) : undefined}
              testID={`${testID}-event-${event.id}`}
              title={event.title}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Mockup: 20 top / 14 bottom / 16 sides; band as a BORDER like the others.
  section: {
    alignSelf: 'stretch',
    paddingBottom: 14,
    paddingHorizontal: 16,
    paddingTop: 20,
    width: '100%',
  },
  list: {
    marginTop: 4,
  },
});
