import type { PropsWithChildren } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import {
  FloatingBottomNav,
  resolveFloatingBottomNavMetrics,
} from '../../../packages/design-system/src/components/floating-bottom-nav';
import { spotlightTheme } from '../../../packages/design-system/src/tokens';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

describe('FloatingBottomNav', () => {
  it('uses tighter scanner metrics than the default surface', () => {
    const defaultMetrics = resolveFloatingBottomNavMetrics({
      bottomInset: 0,
      surface: 'default',
      theme: spotlightTheme,
      windowWidth: 393,
    });
    const scannerMetrics = resolveFloatingBottomNavMetrics({
      bottomInset: 0,
      surface: 'scanner',
      theme: spotlightTheme,
      windowWidth: 393,
    });

    expect(scannerMetrics.shellWidth).toBeLessThan(defaultMetrics.shellWidth);
    expect(scannerMetrics.emphasizedPlateSize).toBeLessThan(defaultMetrics.emphasizedPlateSize);
    expect(scannerMetrics.regularPlateSize).toBe(scannerMetrics.emphasizedPlateSize);
    expect(defaultMetrics.regularPlateSize).toBe(defaultMetrics.emphasizedPlateSize);
    expect(scannerMetrics.horizontalPadding).toBeLessThan(defaultMetrics.horizontalPadding);
    expect(scannerMetrics.innerPaddingTop).toBeGreaterThan(scannerMetrics.innerPaddingBottom);
  });

  it('wires press handlers for both nav items', () => {
    const onOpenPortfolio = jest.fn();
    const onOpenScan = jest.fn();

    render(
      <FloatingBottomNav
        items={[
          {
            key: 'portfolio',
            label: 'Portfolio',
            icon: null,
            onPress: onOpenPortfolio,
            testID: 'bottom-nav-portfolio',
          },
          {
            key: 'scan',
            emphasized: true,
            label: 'Scan',
            icon: null,
            onPress: onOpenScan,
            selected: true,
            testID: 'bottom-nav-scan',
          },
        ]}
        surface="scanner"
      />, {
        wrapper: Providers,
      }
    );

    fireEvent.press(screen.getByTestId('bottom-nav-portfolio'));
    fireEvent.press(screen.getByTestId('bottom-nav-scan'));

    expect(onOpenPortfolio).toHaveBeenCalledTimes(1);
    expect(onOpenScan).toHaveBeenCalledTimes(1);
  });

  it('marks the selected item explicitly when scan is emphasized but inactive', () => {
    render(
      <FloatingBottomNav
        items={[
          {
            key: 'portfolio',
            label: 'Portfolio',
            icon: null,
            onPress: jest.fn(),
            selected: true,
            testID: 'bottom-nav-portfolio',
          },
          {
            key: 'scan',
            emphasized: true,
            label: 'Scan',
            icon: null,
            onPress: jest.fn(),
            testID: 'bottom-nav-scan',
          },
        ]}
      />, {
        wrapper: Providers,
      }
    );

    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({
      selected: false,
    });
  });
});
