import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CalendarEvent } from '@spotlight/api-client';
import {
  CalendarEventRow,
  SkeletonBlock,
  StateCard,
  Text,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { isCalendarEventActionable } from '@/features/meta-feed/components/coming-up-block';
import { calendarDateParts, calendarKindLabel } from '@/features/meta-feed/screens/components/meta-format';
import { MetaPageHeader } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useCalendarPageData } from '@/features/meta-feed/screens/components/meta-page-data';

/** How many upcoming dates the page asks for. */
export const CALENDAR_PAGE_LIMIT = 50;

export type CalendarMonth = { key: string; title: string; events: CalendarEvent[] };

/** Consecutive events grouped by calendar month, keeping the server's order. */
export function groupCalendarByMonth(events: CalendarEvent[]): CalendarMonth[] {
  const months: CalendarMonth[] = [];
  for (const event of events) {
    const { monthKey, monthTitle } = calendarDateParts(event.date);
    const last = months[months.length - 1];
    if (last && last.key === monthKey) {
      last.events.push(event);
    } else {
      months.push({ events: [event], key: monthKey, title: monthTitle });
    }
  }
  return months;
}

export type CalendarScreenProps = {
  onBack: () => void;
  /** Row taps; the route opens the set page or the source link. */
  onOpenEvent: (event: CalendarEvent) => void;
};

/**
 * Coming up page (docs/meta-feed-mockup/v2/CalendarV5.dc.html): every
 * upcoming release, ban list and reveal, grouped by month.
 */
export function CalendarScreen({ onBack, onOpenEvent }: CalendarScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const { data: feed, loading, refresh, status } = useCalendarPageData({ limit: CALENDAR_PAGE_LIMIT });
  const months = useMemo(() => groupCalendarByMonth(feed?.items ?? []), [feed]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  let body;
  if (feed && months.length > 0) {
    body = (
      <View style={[styles.list, loading ? styles.stale : null]} testID="calendar-content">
        {months.map((month) => (
          <View key={month.key} testID={`calendar-month-${month.key}`}>
            <Text
              accessibilityRole="header"
              style={[theme.typography.feedEyebrow, styles.monthTitle, { color: theme.colors.gray600 }]}
            >
              {month.title.toUpperCase()}
            </Text>
            {month.events.map((event, index) => {
              const { month: monthLabel, day } = calendarDateParts(event.date);
              return (
                <CalendarEventRow
                  dayLabel={day}
                  divider={index < month.events.length - 1}
                  key={event.id}
                  kindLabel={calendarKindLabel(event.kind)}
                  kindTone={event.kind}
                  monthLabel={monthLabel}
                  onPress={isCalendarEventActionable(event) ? () => onOpenEvent(event) : undefined}
                  subtitle={event.subtitle}
                  testID={`calendar-event-${event.id}`}
                  title={event.title}
                  variant="full"
                />
              );
            })}
          </View>
        ))}
      </View>
    );
  } else if (feed) {
    body = (
      <View style={styles.stateWrap}>
        <StateCard
          message="Nothing is on the calendar yet. New releases and ban lists show up here."
          testID="calendar-empty"
          title="No dates coming up"
          variant="muted"
        />
      </View>
    );
  } else if (status === 'loading') {
    body = (
      <View style={styles.skeleton} testID="calendar-loading">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonBlock key={index} height={72} radius={radii.md} />
        ))}
      </View>
    );
  } else {
    body = (
      <View style={styles.stateWrap}>
        {status === 'disabled' ? (
          <StateCard
            message="The release calendar isn't switched on yet. Check back soon."
            testID="calendar-disabled"
            title="Coming soon"
            variant="muted"
          />
        ) : (
          <StateCard
            actionLabel="Try again"
            actionTestID="calendar-retry"
            message="We couldn't load upcoming dates. Check your connection and try again."
            onActionPress={() => void refresh()}
            testID="calendar-error"
            title="Dates aren't available right now"
          />
        )}
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader onBack={onBack} subtitle="Dates that move prices" testID="calendar-header" title="Coming up" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        testID="calendar-scroll"
      >
        {body}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.sm,
  },
  monthTitle: {
    paddingTop: spacing.sm,
  },
  safeArea: {
    flex: 1,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
  },
  stale: {
    opacity: 0.6,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
  },
});
