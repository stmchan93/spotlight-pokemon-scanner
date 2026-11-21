import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

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

  it('has a 20pt radius-8 size on a purple100 track (set page header)', () => {
    renderBar(<ProgressBar size="lg" testID="bar" track="accent" value={0.5} />);
    expect(StyleSheet.flatten(screen.getByTestId('bar').props.style)).toMatchObject({
      backgroundColor: colors.purple100,
      borderCurve: 'continuous',
      borderRadius: 8,
      height: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('bar-fill').props.style)).toMatchObject({
      backgroundColor: colors.purple500,
      borderRadius: 8,
    });
  });

  it('draws a two-tone label: dark over the track, white clipped to the fill', () => {
    renderBar(<ProgressBar label="45%" size="lg" testID="bar" track="accent" value={0.45} />);
    const dark = screen.getByTestId('bar-label');
    expect(dark).toHaveTextContent('45%');
    expect(StyleSheet.flatten(dark.props.style).color).toBe(colors.gray900);
    // The white copy needs the track width to align with the dark one.
    expect(screen.queryByTestId('bar-label-on-fill')).toBeNull();
    fireEvent(screen.getByTestId('bar'), 'layout', { nativeEvent: { layout: { height: 20, width: 320, x: 0, y: 0 } } });
    const light = screen.getByTestId('bar-label-on-fill');
    expect(light).toHaveTextContent('45%');
    expect(StyleSheet.flatten(light.props.style).color).toBe(colors.gray0);
    const fill = screen.getByTestId('bar-fill');
    // White copy lives inside the clipping fill, laid out at the full track width.
    expect(within(fill).getByTestId('bar-label-on-fill')).toBeTruthy();
    expect(screen.UNSAFE_root.findAll((node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as ViewStyle)?.width === 320).length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(fill.props.style)).toMatchObject({
      overflow: 'hidden',
      width: '45%',
    });
  });

  it('renders no label by default', () => {
    renderBar(<ProgressBar testID="bar" value={0.5} />);
    expect(screen.queryByTestId('bar-label')).toBeNull();
  });

  it('clamps out-of-range values', () => {
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(2)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
  });
});
