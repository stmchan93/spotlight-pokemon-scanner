import type { SpotlightEvent } from '@spotlight/api-client';

import { mockSpotlightEventsFeed } from '../../mock-api-client';

/** Hawaii: featured, upcoming, ticketed, has coordinates. */
export const upcomingFeatured = mockSpotlightEventsFeed.items[0];
/** Ontario: featured, past, no ticket, 275 tables. */
export const pastFeatured = mockSpotlightEventsFeed.items[1];

export function makeEvent(overrides: Partial<SpotlightEvent> = {}): SpotlightEvent {
  return { ...upcomingFeatured, categories: [...upcomingFeatured.categories], ...overrides };
}
