import {
  PULL_DOWN_DISMISS_DISTANCE,
  PULL_DOWN_DISMISS_VELOCITY,
  isScrollAtTop,
  pullDownOffset,
  pullDownTouchDecision,
  shouldDismissPullDown,
} from '@/lib/pull-down-dismiss';

const base = {
  dx: 0,
  dy: 0,
  keyboardVisible: false,
  nativeTopZone: 140,
  startY: 400,
  startedAtTop: true,
};

describe('pullDownTouchDecision', () => {
  it('waits inside the slop', () => {
    expect(pullDownTouchDecision({ ...base, dy: 4, dx: 2 })).toBe('wait');
  });

  it('activates on a downward drag mid-screen when content is at the top', () => {
    expect(pullDownTouchDecision({ ...base, dy: 14, dx: 3 })).toBe('activate');
  });

  it('fails when the content was scrolled down at touch-down', () => {
    expect(pullDownTouchDecision({ ...base, dy: 40, startedAtTop: false })).toBe('fail');
  });

  it('leaves the native top zone to the native swipe', () => {
    expect(pullDownTouchDecision({ ...base, dy: 40, startY: 100 })).toBe('fail');
  });

  it('works in the top zone when there is no native swipe (Android)', () => {
    expect(pullDownTouchDecision({ ...base, dy: 40, nativeTopZone: 0, startY: 100 })).toBe('activate');
  });

  it('fails on horizontal and upward drags', () => {
    expect(pullDownTouchDecision({ ...base, dx: 20, dy: 12 })).toBe('fail');
    expect(pullDownTouchDecision({ ...base, dx: -20, dy: 2 })).toBe('fail');
    expect(pullDownTouchDecision({ ...base, dy: -15 })).toBe('fail');
  });

  it('closes the keyboard instead of the page when it is up', () => {
    expect(pullDownTouchDecision({ ...base, dy: 20, keyboardVisible: true })).toBe('dismiss-keyboard');
  });
});

describe('shouldDismissPullDown', () => {
  it('dismisses past the distance threshold', () => {
    expect(shouldDismissPullDown(PULL_DOWN_DISMISS_DISTANCE, 0)).toBe(true);
    expect(shouldDismissPullDown(PULL_DOWN_DISMISS_DISTANCE - 1, 0)).toBe(false);
  });

  it('dismisses a fast downward flick from a short pull', () => {
    expect(shouldDismissPullDown(40, PULL_DOWN_DISMISS_VELOCITY)).toBe(true);
  });

  it('ignores a fast flick that barely moved', () => {
    expect(shouldDismissPullDown(10, PULL_DOWN_DISMISS_VELOCITY * 2)).toBe(false);
  });

  it('springs back when flicked back up, even past the threshold', () => {
    expect(shouldDismissPullDown(200, -PULL_DOWN_DISMISS_VELOCITY)).toBe(false);
  });
});

describe('helpers', () => {
  it('pullDownOffset follows the finger and never goes above 0', () => {
    expect(pullDownOffset(55)).toBe(55);
    expect(pullDownOffset(-30)).toBe(0);
  });

  it('isScrollAtTop treats overscroll and ~0 as the top', () => {
    expect(isScrollAtTop(-12)).toBe(true);
    expect(isScrollAtTop(0.3)).toBe(true);
    expect(isScrollAtTop(4)).toBe(false);
  });
});
