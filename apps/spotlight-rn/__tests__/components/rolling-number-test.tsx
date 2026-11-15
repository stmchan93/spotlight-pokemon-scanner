import { StyleSheet } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';

import { RollingNumber } from '../../../../packages/design-system/src/components/rolling-number';

const LINE_HEIGHT = 30;
const TEXT_STYLE = { fontSize: 24, lineHeight: LINE_HEIGHT };

// Strip glyphs are [9, 0..9, 0], so digit d sits at -(d + 1) * lineHeight.
function shownDigit(testID: string): number {
  const strip = screen.getByTestId(testID, { includeHiddenElements: true });
  const flat = StyleSheet.flatten(strip.props.style) as {
    transform: { translateY: number }[];
  };
  return -flat.transform[0].translateY / LINE_HEIGHT - 1;
}

// Step frame-by-frame so Animated's rAF loop runs to completion.
function settle() {
  for (let i = 0; i < 60; i += 1) {
    act(() => {
      jest.advanceTimersByTime(16);
    });
  }
}

describe('RollingNumber', () => {
  it('renders the value immediately on mount, with static separators', () => {
    render(<RollingNumber style={TEXT_STYLE} testID="n" value="$3,410.07" />);

    // Digits keyed from the right: d0 = cents units.
    expect(shownDigit('n-d0')).toBe(7);
    expect(shownDigit('n-d1')).toBe(0);
    expect(shownDigit('n-d2')).toBe(0);
    expect(shownDigit('n-d3')).toBe(1);
    expect(shownDigit('n-d4')).toBe(4);
    expect(shownDigit('n-d5')).toBe(3);
    expect(screen.getByText('$', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText(',', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText('.', { includeHiddenElements: true })).toBeTruthy();
  });

  it('exposes one text element labelled with the value', () => {
    render(<RollingNumber style={TEXT_STYLE} testID="n" value="$3,410.00" />);

    const root = screen.getByTestId('n');
    expect(root.props.accessible).toBe(true);
    expect(root.props.accessibilityRole).toBe('text');
    expect(screen.getByLabelText('$3,410.00')).toBe(root);
  });

  it('uses an explicit accessibilityLabel when given', () => {
    render(<RollingNumber accessibilityLabel="Balance $3,410" value="$3,410.00" />);

    expect(screen.getByLabelText('Balance $3,410')).toBeTruthy();
  });

  it('survives a width change and keeps digit identity from the right', () => {
    jest.useFakeTimers();
    try {
      const { rerender } = render(<RollingNumber style={TEXT_STYLE} testID="n" value="$999.00" />);

      rerender(<RollingNumber style={TEXT_STYLE} testID="n" value="$1,240.00" />);
      settle();

      // Existing columns roll on the native driver (not observable in jest);
      // the new leading column mounts directly at its digit.
      expect(screen.getByLabelText('$1,240.00')).toBeTruthy();
      expect(screen.getByTestId('n-d4', { includeHiddenElements: true })).toBeTruthy();
      expect(shownDigit('n-d5')).toBe(1);
      expect(screen.getByText(',', { includeHiddenElements: true })).toBeTruthy();

      rerender(<RollingNumber style={TEXT_STYLE} testID="n" value="$8.50" />);
      settle();
      expect(screen.getByLabelText('$8.50')).toBeTruthy();
      expect(screen.queryByTestId('n-d3', { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByText(',', { includeHiddenElements: true })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('snaps without animating when animate is false', () => {
    const { rerender } = render(
      <RollingNumber animate={false} style={TEXT_STYLE} testID="n" value="$10.00" />,
    );

    rerender(<RollingNumber animate={false} style={TEXT_STYLE} testID="n" value="$15.00" />);

    // No timers advanced: the new digit must already be in place.
    expect(shownDigit('n-d2')).toBe(5);
    expect(shownDigit('n-d3')).toBe(1);
  });
});
