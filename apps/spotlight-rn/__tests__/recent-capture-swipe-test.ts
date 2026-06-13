import {
  recentCaptureActionRailRevealWidth,
  recentCaptureDeleteRevealWidth,
  recentCaptureFavoriteRevealWidth,
} from '@/features/scanner/recent-capture-swipe';

// The recent-capture row's open/close gesture is now owned by
// react-native-gesture-handler's <Swipeable> (see recent-capture-swipe-row.tsx),
// so the only thing left to pin down here is the action-rail geometry the
// Swipeable measures to decide its open offset.
describe('recent capture swipe constants', () => {
  it('keeps the action rail width = favorite + delete + 12px gap', () => {
    // Guards against silently widening the rail past the two visible pills
    // (favorite, delete) — Add lives at the bottom right of the tray item.
    expect(recentCaptureActionRailRevealWidth).toBe(
      recentCaptureFavoriteRevealWidth
      + recentCaptureDeleteRevealWidth
      + 12,
    );
  });

  it('exposes positive reveal widths', () => {
    expect(recentCaptureFavoriteRevealWidth).toBeGreaterThan(0);
    expect(recentCaptureDeleteRevealWidth).toBeGreaterThan(0);
  });
});
