import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import { TabBarBackdrop } from '@/components/tab-pager/tab-bar-backdrop';
import { TAB_BAR_BACKDROP_BLUR_INTENSITY } from '@/lib/tab-bar-insets';

/**
 * Figma 5938:16991 "Bottom gradient", drawn by the pager on every non-Scan page:
 * 95pt, one 4px backdrop blur, white wash 70% -> clear at 93.684%.
 */
describe('TabBarBackdrop', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('iOS: ONE uniform blur under the white wash, 95pt from the bottom edge', () => {
    Platform.OS = 'ios';
    render(<TabBarBackdrop barHeight={96} />);
    const anchor = StyleSheet.flatten(screen.getByTestId('tab-bar-backdrop-fade').props.style);
    expect(anchor).toMatchObject({ bottom: 0, height: 95, position: 'absolute' });
    expect(anchor.opacity).toBeUndefined();
    // A single blur: stacked bands showed grey seams at their edges.
    expect(screen.getAllByTestId('tab-bar-backdrop-blur')).toHaveLength(1);
    expect(screen.getByTestId('tab-bar-backdrop-blur').props.intensity).toBe(TAB_BAR_BACKDROP_BLUR_INTENSITY);
  });

  it('Android: the wash only', () => {
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
