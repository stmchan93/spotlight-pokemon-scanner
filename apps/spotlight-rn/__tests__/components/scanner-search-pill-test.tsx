import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

import { ScannerSearchPill } from '@/features/scanner/components/scanner-search-pill';

/*
  `jest.setup` forces `isLiquidGlassAvailable()` to false, so this is the scrim
  path — Android and every non-iOS-26 device. That is the one worth pinning: it
  is what almost everyone sees, and it is invisible while developing on an iOS 26
  simulator.
*/
describe('ScannerSearchPill', () => {
  it('reads as a search field, not a button, and says what it searches', () => {
    render(<ScannerSearchPill onPress={jest.fn()} testID="pill" />);

    // The whole point of replacing the magnifier bubble: a bare icon reads as
    // "some action", a labelled field reads as "search, and here is where you
    // would type".
    expect(screen.getByText('Search Cards')).toBeTruthy();
    expect(screen.getByTestId('pill').props.accessibilityLabel).toBe('Search Cards');
  });

  it('takes the rest of the toolbar row', () => {
    render(<ScannerSearchPill onPress={jest.fn()} testID="pill" />);

    const style = StyleSheet.flatten(
      screen.getByTestId('pill').props.style as never,
    ) as Record<string, unknown>;
    // `flex: 1` is what makes it fill the width beside the back button, which is
    // how the frame draws it.
    expect(style.flex).toBe(1);
  });

  it('falls back to the scanner chrome scrim, level with the other controls', () => {
    render(<ScannerSearchPill onPress={jest.fn()} testID="pill" />);

    const style = StyleSheet.flatten(
      screen.getByTestId('pill-surface').props.style as never,
    ) as Record<string, unknown>;
    // Same token as the EN/JP pill and the tray chips, so the scanner's chrome
    // is one material rather than several near-identical greys.
    expect(style.backgroundColor).toBe(colors.scannerChromeFill);
    // 40, so it sits level with the compact back bubble beside it.
    expect(style.height).toBe(40);
  });

  it('opens search when pressed', () => {
    const onPress = jest.fn();
    render(<ScannerSearchPill onPress={onPress} testID="pill" />);

    fireEvent.press(screen.getByTestId('pill'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
