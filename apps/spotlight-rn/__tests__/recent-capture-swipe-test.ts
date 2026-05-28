import {
  clampRecentCaptureSwipeTranslate,
  recentCaptureActionRailRevealWidth,
  recentCaptureDeleteCloseDistanceThreshold,
  recentCaptureDeleteCloseVelocityThreshold,
  recentCaptureDeleteDistanceThreshold,
  recentCaptureDeleteRevealWidth,
  recentCaptureDeleteVelocityThreshold,
  recentCaptureFavoriteRevealWidth,
  shouldCollapseRecentCaptureDeleteFromSwipe,
  shouldRevealRecentCaptureDeleteFromSwipe,
  shouldSetRecentCaptureSwipeResponder,
} from '@/features/scanner/recent-capture-swipe';

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

  it('exposes positive reveal widths and thresholds', () => {
    expect(recentCaptureFavoriteRevealWidth).toBeGreaterThan(0);
    expect(recentCaptureDeleteRevealWidth).toBeGreaterThan(0);
    expect(recentCaptureDeleteDistanceThreshold).toBeGreaterThan(0);
    expect(recentCaptureDeleteVelocityThreshold).toBeGreaterThan(0);
    expect(recentCaptureDeleteCloseDistanceThreshold).toBeGreaterThan(0);
    expect(recentCaptureDeleteCloseVelocityThreshold).toBeGreaterThan(0);
  });
});

describe('recent capture swipe gestures', () => {
  it('starts only for leftward horizontal movement while closed', () => {
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 3 })).toBe(true);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 3 })).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 24 })).toBe(false);
  });

  it('rejects swipes that barely cross the directional threshold while closed', () => {
    // dx must be < -10 to claim the responder while closed.
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -10, dy: 0 })).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -11, dy: 0 })).toBe(true);
  });

  it('starts only for rightward horizontal movement while open', () => {
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 3 }, true)).toBe(true);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 3 }, true)).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 24 }, true)).toBe(false);
  });

  it('rejects swipes that barely cross the directional threshold while open', () => {
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 10, dy: 0 }, true)).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 11, dy: 0 }, true)).toBe(true);
  });

  it('reveals the delete action after a committed left swipe', () => {
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: -80, dy: 4, vx: -0.1 })).toBe(true);
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: -32, dy: 4, vx: -0.8 })).toBe(true);
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: -40, dy: 4, vx: -0.1 })).toBe(false);
  });

  it('refuses to reveal if the gesture is not predominantly horizontal', () => {
    // dy dominates -> shouldSetRecentCaptureSwipeResponder returns false.
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: -120, dy: 120, vx: -2 })).toBe(false);
  });

  it('collapses the delete action after a committed right swipe', () => {
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: 48, dy: 4, vx: 0.1 })).toBe(true);
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: 24, dy: 4, vx: 0.6 })).toBe(true);
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: 20, dy: 4, vx: 0.1 })).toBe(false);
  });

  it('refuses to collapse if the gesture is not predominantly horizontal', () => {
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: 120, dy: 120, vx: 2 })).toBe(false);
  });

  it('clamps the reveal distance in both closed and open states', () => {
    expect(clampRecentCaptureSwipeTranslate(12)).toBe(0);
    expect(clampRecentCaptureSwipeTranslate(0)).toBe(0);
    expect(clampRecentCaptureSwipeTranslate(-40)).toBe(-40);
    // Past the rail width while closed clamps to -railWidth.
    expect(clampRecentCaptureSwipeTranslate(-(recentCaptureActionRailRevealWidth + 50))).toBe(
      -recentCaptureActionRailRevealWidth,
    );
    // Exactly at the rail width returns -railWidth.
    expect(clampRecentCaptureSwipeTranslate(-recentCaptureActionRailRevealWidth)).toBe(
      -recentCaptureActionRailRevealWidth,
    );
    // Opening from already-open: small right swipe partially closes.
    expect(clampRecentCaptureSwipeTranslate(40, true)).toBe(
      -recentCaptureActionRailRevealWidth + 40,
    );
    // Large right swipe while open clamps to 0 (fully closed).
    // (snap-to-zero is handled by Math.min(0, ...) on the upper bound.)
    expect(clampRecentCaptureSwipeTranslate(recentCaptureActionRailRevealWidth + 100, true)).toBe(0);
    // Negative dx while already open should not exceed the rail width.
    expect(clampRecentCaptureSwipeTranslate(-16, true)).toBe(-recentCaptureActionRailRevealWidth);
  });
});
