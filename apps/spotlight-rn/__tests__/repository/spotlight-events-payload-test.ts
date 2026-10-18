import {
  parseSpotlightEventMap,
  parseSpotlightEventsPayload,
} from '../../../../packages/api-client/src/spotlight/spotlight-events';

const BASE = 'https://api.example.com/';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pomona-2026-12',
    title: 'Spotlight at the Pomona Fairplex',
    shortTitle: 'Spotlight Pomona',
    venue: 'Fairplex',
    city: 'Pomona, CA',
    address: '1101 W McKinley Ave, Pomona, CA',
    latitude: 34.08,
    longitude: -117.76,
    startDate: '2026-12-05',
    endDate: '2026-12-06',
    timezone: 'America/Los_Angeles',
    openTime: '10:00',
    closeTime: '17:00',
    tableCount: 300,
    categories: ['Pokemon', 'Sports'],
    about: 'Big show.',
    flyerUrl: '/api/v1/events/pomona-2026-12/flyer.jpg',
    ticketUrl: 'https://tickets.example.com/pomona',
    shareUrl: 'https://example.com/e/pomona',
    featured: true,
    accentColor: '#FFB000',
    status: 'upcoming',
    ...overrides,
  };
}

function parseOne(overrides: Record<string, unknown> = {}, baseUrl = BASE) {
  const { items } = parseSpotlightEventsPayload({ items: [row(overrides)] }, baseUrl);
  expect(items).toHaveLength(1);
  return items[0];
}

describe('parseSpotlightEventsPayload', () => {
  it('parses a full row and resolves a relative flyerUrl against the base', () => {
    const event = parseOne();
    expect(event).toMatchObject({
      id: 'pomona-2026-12',
      shortTitle: 'Spotlight Pomona',
      flyerUrl: 'https://api.example.com/api/v1/events/pomona-2026-12/flyer.jpg',
      ticketUrl: 'https://tickets.example.com/pomona',
      shareUrl: 'https://example.com/e/pomona',
      openTime: '10:00',
      closeTime: '17:00',
      tableCount: 300,
      accentColor: '#FFB000',
      featured: true,
      status: 'upcoming',
    });
  });

  it('keeps absolute http(s) flyer urls and drops other schemes', () => {
    expect(parseOne({ flyerUrl: 'https://cdn.example.com/f.jpg' }).flyerUrl).toBe('https://cdn.example.com/f.jpg');
    expect(parseOne({ flyerUrl: 'file:///etc/passwd' }).flyerUrl).toBeNull();
  });

  it('drops rows missing an id, a title or a valid start date', () => {
    const { items } = parseSpotlightEventsPayload(
      {
        items: [
          row({ id: 'keep' }),
          row({ id: '' }),
          row({ id: 'no-title', title: '  ' }),
          row({ id: 'bad-date', startDate: '12/05/2026' }),
          row({ id: 'bad-end', endDate: 'soon' }),
          null,
          'nope',
        ],
      },
      BASE,
    );
    expect(items.map((item) => item.id)).toEqual(['keep']);
  });

  it('defaults a missing endDate to the start date', () => {
    const event = parseOne({ endDate: undefined });
    expect(event.endDate).toBe('2026-12-05');
  });

  it('nulls malformed colors and times', () => {
    const event = parseOne({ accentColor: 'orange', openTime: '10am', closeTime: '5:00' });
    expect(event.accentColor).toBeNull();
    expect(event.openTime).toBeNull();
    expect(event.closeTime).toBeNull();
    expect(parseOne({ accentColor: '#FFF' }).accentColor).toBeNull();
  });

  it('drops non-https ticket and share links', () => {
    const event = parseOne({ ticketUrl: 'javascript:alert(1)', shareUrl: 'ftp://example.com' });
    expect(event.ticketUrl).toBeNull();
    expect(event.shareUrl).toBeNull();
    // A relative ticket link is not resolved like the flyer is.
    expect(parseOne({ ticketUrl: '/tickets' }).ticketUrl).toBeNull();
  });

  it('falls back to the full title when shortTitle is absent', () => {
    expect(parseOne({ shortTitle: undefined }).shortTitle).toBe('Spotlight at the Pomona Fairplex');
    expect(parseOne({ shortTitle: '' }).shortTitle).toBe('Spotlight at the Pomona Fairplex');
  });

  it('normalizes table counts, categories, status and featured', () => {
    expect(parseOne({ tableCount: 0 }).tableCount).toBeNull();
    expect(parseOne({ tableCount: 120.7 }).tableCount).toBe(120);
    expect(parseOne({ categories: ['Pokemon', 4, ' ', 'Lorcana'] }).categories).toEqual(['Pokemon', 'Lorcana']);
    expect(parseOne({ status: 'cancelled' }).status).toBe('upcoming');
    expect(parseOne({ featured: 'yes' }).featured).toBe(false);
    expect(parseOne({ latitude: '34.1' }).latitude).toBeNull();
  });

  it('returns an empty feed for non-object payloads', () => {
    expect(parseSpotlightEventsPayload(null)).toEqual({ items: [] });
    expect(parseSpotlightEventsPayload({ items: 'nope' })).toEqual({ items: [] });
  });
});

describe('pricing', () => {
  it('parses the optional pricing block and defaults to null', () => {
    expect(parseOne().pricing).toBeNull();
    expect(
      parseOne({
        pricing: {
          general: '$10 general',
          doorPrice: '$15 at the door',
          notes: ['VIP - $20', '', 4, 'Kids free'],
          disclaimer: 'All sales final.',
        },
      }).pricing,
    ).toEqual({
      general: '$10 general',
      doorPrice: '$15 at the door',
      notes: ['VIP - $20', 'Kids free'],
      disclaimer: 'All sales final.',
    });
    // A block with no headline price is as good as none.
    expect(parseOne({ pricing: { doorPrice: '$15' } }).pricing).toBeNull();
    expect(parseOne({ pricing: { general: '$10' } }).pricing).toEqual({
      general: '$10',
      doorPrice: null,
      notes: [],
      disclaimer: null,
    });
  });
});

describe('floorMapUrl', () => {
  it('resolves a relative floorMapUrl and defaults to null', () => {
    expect(parseOne({ floorMapUrl: '/api/v1/events/pomona-2026-12/map' }).floorMapUrl).toBe(
      'https://api.example.com/api/v1/events/pomona-2026-12/map',
    );
    expect(parseOne().floorMapUrl).toBeNull();
    expect(parseOne({ floorMapUrl: 'javascript:alert(1)' }).floorMapUrl).toBeNull();
  });
});

describe('parseSpotlightEventMap', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'hawaii-2026-10',
    imageUrl: '/api/v1/events/hawaii-2026-10/map-image',
    imageWidth: 1433,
    imageHeight: 2700,
    tables: [
      { id: 'C14', block: 'C', number: 14, x: 0.41, y: 0.62, width: 0.011, height: 0.017 },
      { id: 'C15', block: 'C', number: 15, x: 0.41, y: 0.64, width: 0.011, height: 0.017 },
      { id: 'BAD', x: 2, y: 0.1, width: 0.1, height: 0.1 },
      null,
    ],
    vendors: [
      {
        id: 'main-street-cards',
        name: 'Main Street Cards',
        location: 'C14-C15, Z9',
        tableIds: ['C14', 'C15', 'Z9'],
        tags: ['Pokémon', 'Graded'],
        instagram: '@mainstreetcards',
        logoUrl: '/api/v1/events/hawaii-2026-10/vendor-logos/main-street-cards?v=1',
      },
      { id: 'no-name' },
      { id: 'odd-ig', name: 'Odd IG', location: 'C14', tableIds: ['C14'], tags: [], instagram: 'https://evil' },
    ],
    tags: ['Pokémon', 'Graded'],
    updatedAt: '2026-10-15T23:50:00Z',
    ...overrides,
  });

  it('parses the map, resolving the image against the base and dropping malformed rows', () => {
    const map = parseSpotlightEventMap(payload(), BASE);
    expect(map).not.toBeNull();
    expect(map?.imageUrl).toBe('https://api.example.com/api/v1/events/hawaii-2026-10/map-image');
    expect(map?.tables.map((table) => table.id)).toEqual(['C14', 'C15']);
    expect(map?.vendors.map((vendor) => vendor.id)).toEqual(['main-street-cards', 'odd-ig']);
    // Unknown tables are dropped from a vendor; "@" is stripped; a non-handle is rejected.
    expect(map?.vendors[0]).toMatchObject({ tableIds: ['C14', 'C15'], instagram: 'mainstreetcards' });
    expect(map?.vendors[1].instagram).toBeNull();
    expect(map?.vendors[0].logoUrl).toBe(
      'https://api.example.com/api/v1/events/hawaii-2026-10/vendor-logos/main-street-cards?v=1',
    );
    expect(map?.vendors[1].logoUrl).toBeNull();
  });

  it('parses the drawable pieces, skipping bad rows, and falls back to null when the base image is missing', () => {
    const vector = {
      baseImageUrl: '/api/v1/events/hawaii-2026-10/map-base-image',
      baseImage: { x: 0.007, y: 0.002, width: 0.98, height: 0.99 },
      areas: [
        { shape: 'rect', x: 0.01, y: 0.02, width: 0.97, height: 0.1, color: '#FFE500', opacity: 0.7 },
        { shape: 'ellipse', x: 0.3, y: 0.08, width: 0.04, height: 0.02, color: '#BFFEAC' },
        { shape: 'rect', x: 0.1, y: 0.1, width: 0.1, height: 0.1, color: 'yellow' },
      ],
      labels: [
        { text: 'C', x: 0.4, y: 0.8, width: 0.03, height: 0.03, fontSize: 0.02, bold: true },
        { text: 'Food/\nDrink', x: 0.5, y: 0.5, width: 0.05, height: 0.02, fontSize: 0.009 },
        { text: '', x: 0.1, y: 0.1, width: 0.1, height: 0.1, fontSize: 0.01 },
      ],
      tableColor: '#BFFEAC',
      tableNumberSize: 0.0038,
    };
    const map = parseSpotlightEventMap(payload({ vector }), BASE);
    expect(map?.vector?.baseImageUrl).toBe('https://api.example.com/api/v1/events/hawaii-2026-10/map-base-image');
    expect(map?.vector?.areas).toHaveLength(2);
    expect(map?.vector?.areas[1]).toMatchObject({ shape: 'ellipse', opacity: 1 });
    expect(map?.vector?.labels.map((label) => [label.text, label.bold])).toEqual([['C', true], ['Food/\nDrink', false]]);

    expect(parseSpotlightEventMap(payload({ vector: { ...vector, baseImageUrl: null } }), BASE)?.vector).toBeNull();
    expect(parseSpotlightEventMap(payload(), BASE)?.vector).toBeNull();
  });

  it('rejects a payload without a usable image', () => {
    expect(parseSpotlightEventMap(payload({ imageUrl: null }), BASE)).toBeNull();
    expect(parseSpotlightEventMap(payload({ imageWidth: 0 }), BASE)).toBeNull();
    expect(parseSpotlightEventMap('nope', BASE)).toBeNull();
  });
});
