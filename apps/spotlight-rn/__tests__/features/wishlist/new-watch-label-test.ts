import { isNewWatch } from '@/features/wishlist/screens/wishlist-screen';

describe('isNewWatch', () => {
  const now = Date.parse('2026-09-24T20:00:00Z');

  it('treats a watch from the last day as new, whatever its points', () => {
    expect(isNewWatch({ favoritedAt: '2026-09-24T08:00:00Z', sinceWatchedPoints: [1.17, 1.17] }, now)).toBe(true);
  });

  it('treats an older watch with fewer than two points as new', () => {
    expect(isNewWatch({ favoritedAt: '2026-09-20T08:00:00Z', sinceWatchedPoints: [217.25] }, now)).toBe(true);
  });

  it('keeps the trend for an older watch with a real series, flat or not', () => {
    expect(isNewWatch({ favoritedAt: '2026-06-30T08:00:00Z', sinceWatchedPoints: [43.08, 43.08, 43.08] }, now)).toBe(false);
    expect(isNewWatch({ favoritedAt: '2026-09-20T08:00:00Z', sinceWatchedPoints: [10, 12] }, now)).toBe(false);
  });
});
