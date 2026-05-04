import {
  shouldSetRecentCaptureTrayShellResponder,
  shouldSetRecentCaptureTrayVerticalResponder,
} from '@/features/scanner/recent-capture-tray-gesture';

describe('recent capture tray gesture', () => {
  it('claims clearly vertical drags for tray expansion/collapse', () => {
    expect(shouldSetRecentCaptureTrayVerticalResponder({
      dx: 2,
      dy: -16,
    })).toBe(true);
  });

  it('ignores horizontal swipes so row actions can still own them', () => {
    expect(shouldSetRecentCaptureTrayVerticalResponder({
      dx: -20,
      dy: 6,
    })).toBe(false);
  });

  it('lets the collapsed tray shell capture upward drags', () => {
    expect(shouldSetRecentCaptureTrayShellResponder({
      dx: 0,
      dy: -18,
    }, {
      isTopLevelSwipeEnabled: true,
      isTrayExpanded: false,
      scrollOffsetY: 0,
    })).toBe(true);
  });

  it('lets the expanded tray shell capture downward drags only when scrolled to top', () => {
    expect(shouldSetRecentCaptureTrayShellResponder({
      dx: 0,
      dy: 18,
    }, {
      isTopLevelSwipeEnabled: true,
      isTrayExpanded: true,
      scrollOffsetY: 0,
    })).toBe(true);

    expect(shouldSetRecentCaptureTrayShellResponder({
      dx: 0,
      dy: 18,
    }, {
      isTopLevelSwipeEnabled: true,
      isTrayExpanded: true,
      scrollOffsetY: 24,
    })).toBe(false);
  });
});
