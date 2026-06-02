import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SellBackdrop } from '@/features/sell/components/sell-ui';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderSellUI(node: React.ReactNode) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        {node}
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('SellBackdrop', () => {
  it('renders backdrop variants and only shows the image when provided', () => {
    const { rerender } = renderSellUI(<SellBackdrop imageUrl={null} />);

    expect(screen.getByTestId('sell-backdrop')).toBeTruthy();
    expect(screen.queryByTestId('sell-backdrop-image')).toBeNull();

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <SellBackdrop imageUrl="https://images.example/card.png" variant="bulk" />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    const imageStyle = StyleSheet.flatten(screen.getByTestId('sell-backdrop-image').props.style);
    expect(imageStyle).toMatchObject({ opacity: 0.4 });
  });
});
