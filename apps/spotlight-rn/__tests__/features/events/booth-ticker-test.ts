import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import { MAX_TICKER_ITEMS, buildBoothTickerItems } from '@/features/events/booth-ticker';

const NOW = Date.parse('2026-10-31T20:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const VENDORS = [
  { id: 'island', name: 'Island Slabs' },
  { id: 'vintage', name: 'Mock Vintage' },
  { id: 'test', name: 'Test Vendor Slabs' },
];

function post(id: string, vendorId: string, createdAt: string): BoothPost {
  return {
    id,
    authorId: 'u',
    author: null,
    body: null,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt,
    media: [],
    boothVendorId: vendorId,
  };
}

function claims(...entries: [string, string][]): Map<string, BoothClaim> {
  return new Map(
    entries.map(([vendorId, claimedAt]) => [vendorId, { vendorId, userId: `u-${vendorId}`, handle: null, claimedAt }]),
  );
}

describe('buildBoothTickerItems', () => {
  it('busy booths first, then posts and setups newest first, then browsing', () => {
    const items = buildBoothTickerItems({
      vendors: VENDORS,
      posts: [post('p1', 'island', minutesAgo(3))],
      claims: claims(['test', minutesAgo(12)]),
      hotVendorIds: ['vintage'],
      browsingNow: 42,
      now: NOW,
    });
    expect(items.map((item) => item.text)).toEqual([
      '🔥 Mock Vintage is busy right now',
      '📸 Island Slabs posted · 3m',
      '👋 Test Vendor Slabs set up their booth · 12m',
      '👀 42 people browsing',
    ]);
    expect(items.map((item) => item.vendorId)).toEqual(['vintage', 'island', 'test', null]);
  });

  it('one post line per vendor (the newest), and nothing older than a day', () => {
    const items = buildBoothTickerItems({
      vendors: VENDORS,
      posts: [
        post('older', 'island', minutesAgo(50)),
        post('newest', 'island', minutesAgo(5)),
        post('stale', 'vintage', minutesAgo(25 * 60)),
      ],
      claims: claims(['test', minutesAgo(30 * 60)]),
      hotVendorIds: [],
      browsingNow: null,
      now: NOW,
    });
    expect(items).toEqual([{ key: 'post:newest', text: '📸 Island Slabs posted · 5m', vendorId: 'island' }]);
  });

  it('skips vendors not on the map and a browsing count under 3', () => {
    const items = buildBoothTickerItems({
      vendors: VENDORS,
      posts: [post('p1', 'gone', minutesAgo(1))],
      claims: claims(['gone', minutesAgo(1)]),
      hotVendorIds: ['gone'],
      browsingNow: 2,
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('caps the list but keeps the browsing line', () => {
    const vendors = Array.from({ length: 20 }, (_, index) => ({ id: `v${index}`, name: `Vendor ${index}` }));
    const items = buildBoothTickerItems({
      vendors,
      posts: vendors.map((vendor, index) => post(`p${index}`, vendor.id, minutesAgo(index + 1))),
      claims: new Map(),
      hotVendorIds: [],
      browsingNow: 10,
      now: NOW,
    });
    expect(items).toHaveLength(MAX_TICKER_ITEMS);
    expect(items[0]?.vendorId).toBe('v0');
    expect(items.at(-1)?.key).toBe('browsing');
  });
});
