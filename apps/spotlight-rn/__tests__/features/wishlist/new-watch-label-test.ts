import { hasWatchTrend, isNewWatch } from '@/features/wishlist/screens/wishlist-screen';

describe('isNewWatch', () => {
  const now = Date.parse('2026-09-24T20:00:00Z');

  it('treats a watch from the last day as new, whatever its points', () => {
    expect(isNewWatch({ favoritedAt: '2026-09-24T08:00:00Z' }, now)).toBe(true);
  });

  it('never labels an older watch, even one still short of two points', () => {
    expect(isNewWatch({ favoritedAt: '2026-09-20T08:00:00Z' }, now)).toBe(false);
    expect(isNewWatch({ favoritedAt: null }, now)).toBe(false);
  });

  it('keeps the trend for an older watch with a real series, flat or not', () => {
    expect(isNewWatch({ favoritedAt: '2026-06-30T08:00:00Z' }, now)).toBe(false);
    expect(isNewWatch({ favoritedAt: '2026-09-20T08:00:00Z' }, now)).toBe(false);
  });
});

describe('hasWatchTrend', () => {
  const now = Date.parse('2026-09-24T20:00:00Z');

  it('shows the trend once a watch is past its first day with two prices', () => {
    expect(hasWatchTrend({ favoritedAt: '2026-09-20T08:00:00Z', sinceWatchedPoints: [10, 12] }, now)).toBe(true);
  });

  it('hides it on the first day and while a thin card has one price', () => {
    expect(hasWatchTrend({ favoritedAt: '2026-09-24T08:00:00Z', sinceWatchedPoints: [10, 12] }, now)).toBe(false);
    expect(hasWatchTrend({ favoritedAt: '2026-09-20T08:00:00Z', sinceWatchedPoints: [217.25] }, now)).toBe(false);
    expect(hasWatchTrend({ favoritedAt: '2026-09-20T08:00:00Z' }, now)).toBe(false);
  });
});
