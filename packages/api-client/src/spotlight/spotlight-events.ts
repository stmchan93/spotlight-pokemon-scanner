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
  /** Absolute URL of the floor map (`GET` -> SpotlightEventMap), or null when the show has none. */
  floorMapUrl: string | null;
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
    floorMapUrl: resolveUrl(raw.floorMapUrl, baseUrl),
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
      floorMapUrl: null,
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
      floorMapUrl: null,
      status: 'past',
    },
  ],
};

/**
 * A show's floor map: `GET <floorMapUrl>`, generated from the Figma layout.
 * Table geometry is in FRACTIONS of the map image (0..1, top-left origin).
 */
export type SpotlightEventMapTable = {
  /** "C14", "HA3", "FOOD2". */
  id: string;
  block: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SpotlightEventMapVendor = {
  id: string;
  name: string;
  /** As printed on the layout ("C1-C5, C26-C28"). */
  location: string;
  tableIds: string[];
  tags: string[];
  /** Bare handle, no "@". */
  instagram: string | null;
  /** Square logo from their vendor application; absent -> show initials. */
  logoUrl: string | null;
};

/** A box in the map's fractional space (0..1 of the floor's width/height, top-left origin). */
export type SpotlightEventMapBox = { x: number; y: number; width: number; height: number };

export type SpotlightEventMapArea = SpotlightEventMapBox & {
  shape: 'rect' | 'ellipse';
  /** `#RRGGBB`. */
  color: string;
  opacity: number;
};

export type SpotlightEventMapLabel = SpotlightEventMapBox & {
  text: string;
  /** Fraction of the floor's height. */
  fontSize: number;
  bold: boolean;
};

/**
 * Pieces the app draws itself so tables, numbers and labels stay sharp at any
 * zoom: only the walls are an image. Absent -> draw the flat `imageUrl`.
 */
export type SpotlightEventMapVector = {
  baseImageUrl: string;
  baseImage: SpotlightEventMapBox;
  areas: SpotlightEventMapArea[];
  labels: SpotlightEventMapLabel[];
  tableColor: string;
  /** Table number font size, as a fraction of the floor's height. */
  tableNumberSize: number;
};

export type SpotlightEventMap = {
  eventId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  tables: SpotlightEventMapTable[];
  vendors: SpotlightEventMapVendor[];
  /** Most common first. */
  tags: string[];
  updatedAt: string | null;
  vector: SpotlightEventMapVector | null;
};

function fraction(value: unknown): number | null {
  const number = finite(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((item): item is string => item != null) : [];
}

function parseMapTable(value: unknown): SpotlightEventMapTable | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Raw;
  const id = str(raw.id);
  const x = fraction(raw.x);
  const y = fraction(raw.y);
  const width = fraction(raw.width);
  const height = fraction(raw.height);
  if (!id || x == null || y == null || !width || !height) {
    return null;
  }
  return { id, block: str(raw.block) ?? '', number: finite(raw.number) ?? 0, x, y, width, height };
}

function parseMapVendor(
  value: unknown,
  tableIds: ReadonlySet<string>,
  baseUrl: string,
): SpotlightEventMapVendor | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Raw;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) {
    return null;
  }
  const instagram = str(raw.instagram)?.replace(/^@+/, '') || null;
  return {
    id,
    name,
    location: str(raw.location) ?? '',
    // A vendor pointing at a table the map lacks still lists; it just can't highlight.
    tableIds: strings(raw.tableIds).filter((tableId) => tableIds.has(tableId)),
    tags: strings(raw.tags),
    instagram: instagram && /^[A-Za-z0-9._]+$/.test(instagram) ? instagram : null,
    logoUrl: resolveUrl(raw.logoUrl, baseUrl),
  };
}

function parseBox(raw: Raw): SpotlightEventMapBox | null {
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x == null || y == null || !width || !height || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function parseMapVector(value: unknown, baseUrl: string): SpotlightEventMapVector | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Raw;
  const baseImageUrl = resolveUrl(raw.baseImageUrl, baseUrl);
  const baseImage = raw.baseImage && typeof raw.baseImage === 'object' ? parseBox(raw.baseImage as Raw) : null;
  const tableNumberSize = fraction(raw.tableNumberSize);
  if (!baseImageUrl || !baseImage || !tableNumberSize) {
    return null;
  }
  const areas: SpotlightEventMapArea[] = [];
  for (const item of Array.isArray(raw.areas) ? raw.areas : []) {
    const area = item && typeof item === 'object' ? (item as Raw) : null;
    const box = area ? parseBox(area) : null;
    const color = area ? str(area.color) : null;
    if (area && box && color && COLOR_RE.test(color)) {
      areas.push({
        ...box,
        shape: area.shape === 'ellipse' ? 'ellipse' : 'rect',
        color,
        opacity: Math.min(1, Math.max(0, finite(area.opacity) ?? 1)),
      });
    }
  }
  const labels: SpotlightEventMapLabel[] = [];
  for (const item of Array.isArray(raw.labels) ? raw.labels : []) {
    const label = item && typeof item === 'object' ? (item as Raw) : null;
    const box = label ? parseBox(label) : null;
    const text = label && typeof label.text === 'string' ? label.text.trim() : '';
    const fontSize = label ? fraction(label.fontSize) : null;
    if (box && text && fontSize) {
      labels.push({ ...box, text, fontSize, bold: label?.bold === true });
    }
  }
  const tableColor = str(raw.tableColor);
  return {
    baseImageUrl,
    baseImage,
    areas,
    labels,
    tableColor: tableColor && COLOR_RE.test(tableColor) ? tableColor : '#BFFEAC',
    tableNumberSize,
  };
}

export function parseSpotlightEventMap(value: unknown, baseUrl = ''): SpotlightEventMap | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Raw;
  const imageUrl = resolveUrl(raw.imageUrl, baseUrl);
  const imageWidth = finite(raw.imageWidth);
  const imageHeight = finite(raw.imageHeight);
  if (!imageUrl || !imageWidth || imageWidth <= 0 || !imageHeight || imageHeight <= 0) {
    return null;
  }
  const tables = Array.isArray(raw.tables)
    ? raw.tables.map(parseMapTable).filter((item): item is SpotlightEventMapTable => item != null)
    : [];
  const known = new Set(tables.map((table) => table.id));
  const vendors = Array.isArray(raw.vendors)
    ? raw.vendors
        .map((item) => parseMapVendor(item, known, baseUrl))
        .filter((item): item is SpotlightEventMapVendor => item != null)
    : [];
  return {
    eventId: str(raw.eventId) ?? '',
    imageUrl,
    imageWidth,
    imageHeight,
    tables,
    vendors,
    tags: strings(raw.tags),
    updatedAt: str(raw.updatedAt),
    vector: parseMapVector(raw.vector, baseUrl),
  };
}

export const mockSpotlightEventMap: SpotlightEventMap = {
  eventId: 'hawaii-2026-10',
  imageUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map-image',
  imageWidth: 1000,
  imageHeight: 2000,
  tables: [
    { id: 'A1', block: 'A', number: 1, x: 0.1, y: 0.8, width: 0.04, height: 0.02 },
    { id: 'A2', block: 'A', number: 2, x: 0.15, y: 0.8, width: 0.04, height: 0.02 },
    { id: 'C14', block: 'C', number: 14, x: 0.5, y: 0.6, width: 0.02, height: 0.04 },
    { id: 'FOOD1', block: 'FOOD', number: 1, x: 0.5, y: 0.4, width: 0.02, height: 0.04 },
  ],
  vendors: [
    {
      id: 'aloha-puddin',
      name: 'Aloha Puddin',
      location: '1',
      tableIds: ['FOOD1'],
      tags: ['Food'],
      instagram: null,
      logoUrl: null,
    },
    {
      id: 'dokidoki-collectibles',
      name: 'DokiDokiCollectibles',
      location: 'A1-A2',
      tableIds: ['A1', 'A2'],
      tags: ['Pokémon', 'Graded'],
      instagram: 'dokidokicollectibles',
      logoUrl: null,
    },
    {
      id: 'main-street-cards',
      name: 'Main Street Cards',
      location: 'C14',
      tableIds: ['C14'],
      tags: ['One Piece', 'Sealed'],
      instagram: 'mainstreetcards',
      logoUrl: null,
    },
  ],
  tags: ['Pokémon', 'Graded', 'One Piece', 'Sealed', 'Food'],
  updatedAt: '2026-10-15T23:50:00Z',
  vector: null,
};
