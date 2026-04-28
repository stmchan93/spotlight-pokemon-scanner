import {
  clampRecentCaptureSwipeTranslate,
  recentCaptureDeleteRevealWidth,
  shouldCollapseRecentCaptureDeleteFromSwipe,
  shouldRevealRecentCaptureDeleteFromSwipe,
  shouldSetRecentCaptureSwipeResponder,
} from '@/features/scanner/recent-capture-swipe';

describe('recent capture swipe gestures', () => {
  it('starts only for rightward horizontal movement while closed', () => {
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 3 })).toBe(true);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 3 })).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 24 })).toBe(false);
  });

  it('starts only for leftward horizontal movement while open', () => {
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 3 }, true)).toBe(true);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: 24, dy: 3 }, true)).toBe(false);
    expect(shouldSetRecentCaptureSwipeResponder({ dx: -24, dy: 24 }, true)).toBe(false);
  });

  it('reveals the delete action after a committed right swipe', () => {
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: 80, dy: 4, vx: 0.1 })).toBe(true);
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: 32, dy: 4, vx: 0.8 })).toBe(true);
    expect(shouldRevealRecentCaptureDeleteFromSwipe({ dx: 40, dy: 4, vx: 0.1 })).toBe(false);
  });

  it('collapses the delete action after a committed left swipe', () => {
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: -48, dy: 4, vx: -0.1 })).toBe(true);
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: -24, dy: 4, vx: -0.6 })).toBe(true);
    expect(shouldCollapseRecentCaptureDeleteFromSwipe({ dx: -20, dy: 4, vx: -0.1 })).toBe(false);
  });

  it('clamps the reveal distance in both closed and open states', () => {
    expect(clampRecentCaptureSwipeTranslate(-12)).toBe(0);
    expect(clampRecentCaptureSwipeTranslate(40)).toBe(40);
    expect(clampRecentCaptureSwipeTranslate(140)).toBe(recentCaptureDeleteRevealWidth);
    expect(clampRecentCaptureSwipeTranslate(-40, true)).toBe(recentCaptureDeleteRevealWidth - 40);
    expect(clampRecentCaptureSwipeTranslate(-140, true)).toBe(0);
    expect(clampRecentCaptureSwipeTranslate(16, true)).toBe(recentCaptureDeleteRevealWidth);
  });
});
