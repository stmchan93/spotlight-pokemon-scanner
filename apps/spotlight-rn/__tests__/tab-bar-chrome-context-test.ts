import { nextCollapsed } from '@/contexts/tab-bar-chrome-context';

describe('nextCollapsed', () => {
  it('collapses when scrolling down past the collapse threshold', () => {
    // From offset 100 → 200 (clearly past COLLAPSE_OFFSET of 48) while expanded.
    expect(nextCollapsed(100, 200, false)).toBe(true);
  });

  it('expands when scrolling up past the delta threshold', () => {
    // From offset 200 → 100 while collapsed.
    expect(nextCollapsed(200, 100, true)).toBe(false);
  });

  it('keeps the current state for tiny sub-threshold deltas', () => {
    // 4px move (< MIN_DELTA of 6) holds whatever state we were in.
    expect(nextCollapsed(100, 104, true)).toBe(true);
    expect(nextCollapsed(100, 104, false)).toBe(false);
    expect(nextCollapsed(100, 96, true)).toBe(true);
    expect(nextCollapsed(100, 96, false)).toBe(false);
  });

  it('forces expanded near the very top of the content', () => {
    // Offset < TOP_FORCE_EXPANDED_OFFSET (16) → always expanded regardless of state/direction.
    expect(nextCollapsed(40, 8, true)).toBe(false);
    expect(nextCollapsed(0, 4, true)).toBe(false);
  });

  it('does not collapse on a downward scroll that stays within the top region', () => {
    // Scrolling down from 20 → 40 (delta 20, but next offset still < COLLAPSE_OFFSET of 48)
    // holds the prior state rather than collapsing.
    expect(nextCollapsed(20, 40, false)).toBe(false);
  });
});
