import type { CalendarEvent, MetaLaneFilter, NewsItem } from '@spotlight/api-client';

import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

/*
  Taps on the feed's market surfaces. Only enums, ranks and group keys travel —
  never a card id, a title or a link. A news `publisher` is the public outlet
  name ("PokéBeach"), which is what makes the tap readable.
*/

export type MetaDirection = 'up' | 'down';
export type MetaGroupOpenSource = 'feed' | 'meta_page' | 'callout';

export function trackMetaGroupOpened(props: {
  groupKey: string;
  lane: MetaLaneFilter;
  direction: MetaDirection;
  source: MetaGroupOpenSource;
}) {
  capturePostHogEvent(AnalyticsEvent.metaGroupOpened, {
    group_key: props.groupKey,
    lane: props.lane,
    direction: props.direction,
    source: props.source,
  });
}

/** The callout is both a callout tap and a group open (source `callout`). */
export function trackMetaCalloutTapped(props: {
  groupKey: string;
  lane: MetaLaneFilter;
  direction: MetaDirection;
}) {
  capturePostHogEvent(AnalyticsEvent.metaCalloutTapped, { direction: props.direction });
  trackMetaGroupOpened({ ...props, source: 'callout' });
}

export function trackHotCardOpened(rank: number) {
  capturePostHogEvent(AnalyticsEvent.hotCardOpened, { rank });
}

export function trackComingUpEventOpened(event: CalendarEvent, source: 'feed' | 'calendar') {
  capturePostHogEvent(AnalyticsEvent.comingUpEventOpened, {
    kind: event.kind,
    game: event.game,
    source,
  });
}

export type NewsSurface = 'feed' | 'news_page' | 'set_page';

export function trackNewsItemOpened(item: Pick<NewsItem, 'kind' | 'source'>, surface: NewsSurface) {
  capturePostHogEvent(AnalyticsEvent.newsItemOpened, {
    kind: item.kind,
    surface,
    publisher: item.source,
  });
}
