import { eventGradientStops, mixWithWhite } from '@/features/events/event-accent';

describe('event accent gradient', () => {
  it('mixes a colour toward white', () => {
    expect(mixWithWhite('#FFB005', 0)).toBe('#FFB005');
    expect(mixWithWhite('#FFB005', 1)).toBe('#FFFFFF');
    expect(mixWithWhite('#000000', 0.5)).toBe('#808080');
  });

  it('reproduces the Figma stops for the yellow event (5882:12595)', () => {
    // #FFB005 -> #FFC23C (30%) -> #FFD780 (60%) -> white; the 30% stop rounds within one unit.
    expect(eventGradientStops('#FFB005')).toEqual([
      { offset: 0, color: '#FFB005' },
      { offset: 0.3, color: '#FFC13C' },
      { offset: 0.6, color: '#FFD780' },
      { offset: 1, color: '#FFFFFF' },
    ]);
  });
});
