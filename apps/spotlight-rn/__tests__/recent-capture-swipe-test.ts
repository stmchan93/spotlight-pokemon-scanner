import {
  recentCaptureActionCircleSize,
  recentCaptureActionGap,
  recentCaptureActionIconSize,
  recentCaptureActionRailPadding,
  recentCaptureActionRailRevealWidth,
} from '@/features/scanner/recent-capture-swipe';

// The recent-capture row's open/close gesture is owned by
// react-native-gesture-handler's <Swipeable> (see recent-capture-swipe-row.tsx),
// so the only thing left to pin down here is the action-rail geometry the
// Swipeable measures to decide its open offset (Figma 1511:4098 — circular
// Collection + Delete actions, 16px apart).
describe('recent capture swipe constants', () => {
  it('reveals enough width for both action groups, the gap, and edge padding', () => {
    // Two ~42px circles + the 16px inter-group gap + padding on each edge must
    // fit inside the revealed rail; guards against clipping the wider
    // "Collection" label.
    const minimumRailWidth =
      recentCaptureActionRailPadding * 2
      + recentCaptureActionCircleSize * 2
      + recentCaptureActionGap;
    expect(recentCaptureActionRailRevealWidth).toBeGreaterThanOrEqual(minimumRailWidth);
  });

  it('exposes positive geometry', () => {
    expect(recentCaptureActionCircleSize).toBeGreaterThan(0);
    expect(recentCaptureActionIconSize).toBeGreaterThan(0);
    expect(recentCaptureActionIconSize).toBeLessThanOrEqual(recentCaptureActionCircleSize);
    expect(recentCaptureActionGap).toBeGreaterThan(0);
    expect(recentCaptureActionRailRevealWidth).toBeGreaterThan(0);
  });
});
