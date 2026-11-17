import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import { TabBarBackdrop } from '@/components/tab-pager/tab-bar-backdrop';
import { TAB_BAR_BLUR_BANDS, TAB_BAR_BLUR_OVERHANG, tabBarBlurHeight } from '@/lib/tab-bar-insets';

/**
 * The blur under the floating tab bar, drawn by the pager on every non-Scan
 * page. iOS: a PROGRESSIVE blur (real blur, never a white wash). Android: the
 * white fade, since expo-blur cannot blur page content there without a native
 * blur target.
 */
describe('TabBarBackdrop', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('reaches 24pt above the bar, short of a FAB resting 28pt above it', () => {
    expect(TAB_BAR_BLUR_OVERHANG).toBe(24);
    expect(tabBarBlurHeight(96)).toBe(120);
  });

  it('steps from faint and tall to strong and short, so it is strongest at the bottom edge', () => {
    const fractions = TAB_BAR_BLUR_BANDS.map((band) => band.heightFraction);
    const intensities = TAB_BAR_BLUR_BANDS.map((band) => band.intensity);
    expect(fractions[0]).toBe(1);
    expect([...fractions].sort((a, b) => b - a)).toEqual(fractions);
    expect([...intensities].sort((a, b) => a - b)).toEqual(intensities);
  });

  it('draws real blur bands on iOS, anchored to the bottom edge, with no white fade', () => {
    Platform.OS = 'ios';
    render(<TabBarBackdrop barHeight={96} />);
    const anchor = StyleSheet.flatten(screen.getByTestId('tab-bar-backdrop-blur').props.style);
    expect(anchor).toMatchObject({ bottom: 0, height: 120, position: 'absolute' });
    expect(anchor.opacity).toBeUndefined();
    const bands = screen.getAllByTestId('tab-bar-backdrop-band');
    expect(bands).toHaveLength(TAB_BAR_BLUR_BANDS.length);
    expect(bands.map((band) => band.props.intensity)).toEqual(TAB_BAR_BLUR_BANDS.map((band) => band.intensity));
    expect(bands.map((band) => StyleSheet.flatten(band.props.style).height)).toEqual(
      TAB_BAR_BLUR_BANDS.map((band) => 120 * band.heightFraction),
    );
    expect(screen.queryByTestId('tab-bar-backdrop-fade')).toBeNull();
  });

  it('keeps the white fade on Android', () => {
    Platform.OS = 'android';
    render(<TabBarBackdrop barHeight={87} />);
    expect(screen.getByTestId('tab-bar-backdrop-fade')).toBeTruthy();
    expect(screen.queryByTestId('tab-bar-backdrop-blur')).toBeNull();
  });

  it('draws nothing while the bar is hidden', () => {
    Platform.OS = 'ios';
    render(<TabBarBackdrop barHeight={0} />);
    expect(screen.queryByTestId('tab-bar-backdrop-blur')).toBeNull();
    expect(screen.queryByTestId('tab-bar-backdrop-fade')).toBeNull();
  });
});
