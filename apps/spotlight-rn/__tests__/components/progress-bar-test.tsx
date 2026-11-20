import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ProgressBar, SpotlightThemeProvider, clampProgress, colors } from '@spotlight/design-system';

function renderBar(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('ProgressBar', () => {
  it('fills to the value on a token track and reports a percent', () => {
    renderBar(<ProgressBar testID="bar" value={0.62} />);
    const track = screen.getByTestId('bar');
    const fill = screen.getByTestId('bar-fill');
    expect(StyleSheet.flatten(track.props.style)).toMatchObject({
      backgroundColor: colors.gray200,
      borderCurve: 'continuous',
      height: 6,
    });
    expect(StyleSheet.flatten(fill.props.style)).toMatchObject({
      backgroundColor: colors.purple500,
      width: '62%',
    });
    expect(track.props.accessibilityValue).toEqual({ max: 100, min: 0, now: 62 });
  });

  it('has small and neutral variants', () => {
    renderBar(<ProgressBar size="sm" testID="bar" tone="neutral" value={1} />);
    expect(StyleSheet.flatten(screen.getByTestId('bar').props.style).height).toBe(4);
    expect(StyleSheet.flatten(screen.getByTestId('bar-fill').props.style).backgroundColor).toBe(colors.gray900);
  });

  it('clamps out-of-range values', () => {
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(2)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
  });
});
