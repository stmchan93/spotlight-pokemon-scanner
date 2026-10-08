/**
 * Spotlight's own card shows — the Events tab. Served by `GET /api/v1/events`
 * from the hand-maintained `backend/data/spotlight_events.json`.
 */

export type SpotlightEventStatus = 'upcoming' | 'live' | 'past';

export type SpotlightEvent = {
  id: string;
  /** Full title for the detail page ("Spotlight at the Ontario Convention Center"). */
  title: string;
  /** List/carousel title ("Spotlight Ontario"); the server falls back to `title`. */
  shortTitle: string;
  venue: string;
  /** Short location label ("Ontario, CA"). */
  city: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** `YYYY-MM-DD` in the event's own timezone. */
  startDate: string;
  endDate: string;
  timezone: string;
  /** `HH:MM`, 24h. */
  openTime: string | null;
  closeTime: string | null;
  tableCount: number | null;
  categories: string[];
  about: string | null;
  /** Absolute URL (resolved against the API base) or null. */
  flyerUrl: string | null;
  ticketUrl: string | null;
  shareUrl: string | null;
  featured: boolean;
  /** `#RRGGBB` for the detail-page gradient, or null for the default. */
  accentColor: string | null;
  status: SpotlightEventStatus;
};

/** Server order: live, then upcoming ascending, then past descending. */
export type SpotlightEventsFeed = { items: SpotlightEvent[] };

type Raw = Record<string, unknown>;

const STATUSES: readonly SpotlightEventStatus[] = ['upcoming', 'live', 'past'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function httpUrl(value: unknown): string | null {
  const url = str(value);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function resolveUrl(value: unknown, baseUrl: string): string | null {
  const url = str(value);
  if (!url) {
    return null;
  }
  if (url.startsWith('/')) {
    return `${baseUrl.replace(/\/+$/, '')}${url}`;
  }
  return httpUrl(url);
}

function parseSpotlightEvent(value: unknown, baseUrl: string): SpotlightEvent | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Raw;
  const id = str(raw.id);
  const title = str(raw.title);
  const startDate = str(raw.startDate);
  const endDate = str(raw.endDate) ?? startDate;
  if (!id || !title || !startDate || !DATE_RE.test(startDate) || !endDate || !DATE_RE.test(endDate)) {
    return null;
  }
  const openTime = str(raw.openTime);
  const closeTime = str(raw.closeTime);
  const accentColor = str(raw.accentColor);
  const tableCount = finite(raw.tableCount);
  const status = STATUSES.includes(raw.status as SpotlightEventStatus)
    ? (raw.status as SpotlightEventStatus)
    : 'upcoming';
  return {
    id,
    title,
    shortTitle: str(raw.shortTitle) ?? title,
    venue: str(raw.venue) ?? '',
    city: str(raw.city) ?? '',
    address: str(raw.address) ?? '',
    latitude: finite(raw.latitude),
    longitude: finite(raw.longitude),
    startDate,
    endDate,
    timezone: str(raw.timezone) ?? 'America/Los_Angeles',
    openTime: openTime && TIME_RE.test(openTime) ? openTime : null,
    closeTime: closeTime && TIME_RE.test(closeTime) ? closeTime : null,
    tableCount: tableCount != null && tableCount > 0 ? Math.trunc(tableCount) : null,
    categories: Array.isArray(raw.categories)
      ? raw.categories.map(str).filter((item): item is string => item != null)
      : [],
    about: str(raw.about),
    flyerUrl: resolveUrl(raw.flyerUrl, baseUrl),
    ticketUrl: httpUrl(raw.ticketUrl),
    shareUrl: httpUrl(raw.shareUrl),
    featured: raw.featured === true,
    accentColor: accentColor && COLOR_RE.test(accentColor) ? accentColor : null,
    status,
  };
}

export function parseSpotlightEventsPayload(value: unknown, baseUrl = ''): SpotlightEventsFeed {
  const items = value && typeof value === 'object' ? (value as Raw).items : null;
  return {
    items: Array.isArray(items)
      ? items
          .map((item) => parseSpotlightEvent(item, baseUrl))
          .filter((item): item is SpotlightEvent => item != null)
      : [],
  };
}

export const mockSpotlightEventsFeed: SpotlightEventsFeed = {
  items: [
    {
      id: 'hawaii-2026-10',
      title: 'Spotlight at the Hawaii Convention Center',
      shortTitle: 'Spotlight Hawaii',
      venue: 'Hawaii Convention Center',
      city: 'Oahu, HI',
      address: '1801 Kalakaua Ave, Honolulu, HI 96815',
      latitude: 21.2906,
      longitude: -157.836,
      startDate: '2026-10-24',
      endDate: '2026-10-25',
      timezone: 'Pacific/Honolulu',
      openTime: '10:00',
      closeTime: '17:00',
      tableCount: null,
      categories: ['Pokemon', 'Sports', 'One Piece', 'Yu-Gi-Oh', 'Magic The Gathering', 'Lorcana'],
      about: null,
      flyerUrl: null,
      ticketUrl: 'https://example.com/tickets/hawaii',
      shareUrl: null,
      featured: true,
      accentColor: '#FFB000',
      status: 'upcoming',
    },
    {
      id: 'ontario-2026-08',
      title: 'Spotlight at the Ontario Convention Center',
      shortTitle: 'Spotlight Ontario',
      venue: 'Ontario Convention Center',
      city: 'Ontario, CA',
      address: '2000 E Convention Center Way, Ontario, CA 91764',
      latitude: 34.0672,
      longitude: -117.597,
      startDate: '2026-08-22',
      endDate: '2026-08-23',
      timezone: 'America/Los_Angeles',
      openTime: '11:00',
      closeTime: '17:00',
      tableCount: 275,
      categories: ['Pokemon', 'Sports', 'One Piece', 'Yu-Gi-Oh', 'Magic The Gathering', 'Lorcana'],
      about: null,
      flyerUrl: null,
      ticketUrl: null,
      shareUrl: null,
      featured: true,
      accentColor: '#FFB000',
      status: 'past',
    },
  ],
};
