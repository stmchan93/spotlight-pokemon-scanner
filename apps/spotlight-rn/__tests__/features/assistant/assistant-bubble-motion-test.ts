import {
  HOP_HEIGHT,
  hopHeight,
  leashAmount,
  lookDirection,
} from '@/features/assistant/components/assistant-bubble-motion';
import { pagerPageForPath } from '@/components/tab-pager/tab-pager-motion';

describe('assistant bubble motion', () => {
  it('pulls the leash with strip speed, capped at ±1', () => {
    expect(leashAmount(0, 393)).toBe(0);
    // Advancing a page in ~0.5s on a 393pt screen ≈ 786pt/s: a partial pull.
    expect(leashAmount(2, 393)).toBeGreaterThan(0.4);
    expect(leashAmount(2, 393)).toBeLessThan(0.7);
    expect(leashAmount(20, 393)).toBe(1);
    expect(leashAmount(-20, 393)).toBe(-1);
  });

  it('hops up to HOP_HEIGHT but never peaks above the destination band', () => {
    expect(hopHeight(600, 640, 100)).toBe(HOP_HEIGHT);
    // The scanner gap: from 620 to 520 with the band starting at 560 → peak room 10pt.
    expect(hopHeight(620, 520, 560)).toBe(10);
    expect(hopHeight(500, 500, 600)).toBe(0);
  });

  it('glances back toward the page it came from', () => {
    expect(lookDirection('/', '/search')).toBe(-1);
    expect(lookDirection('/social', '/events')).toBe(1);
    expect(lookDirection('/', '/cards/abc')).toBe(-1);
    expect(lookDirection('/cards/abc', '/')).toBe(1);
    expect(lookDirection('/scan', '/scan')).toBe(0);
  });

  it('maps tab paths to strip pages', () => {
    expect(['/', '/search', '/scan', '/events', '/social', '/wishlist'].map(pagerPageForPath)).toEqual([0, 1, 2, 3, 4, -1]);
  });
});
