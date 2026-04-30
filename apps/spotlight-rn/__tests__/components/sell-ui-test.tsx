import { screen, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SellStatusOverlay } from '@/features/sell/components/sell-ui';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderOverlay(
  state: 'processing' | 'success',
  testIDPrefix: string,
  title: string,
  headline: string,
  detail: string,
) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <SellStatusOverlay
          detail={detail}
          headline={headline}
          state={state}
          testIDPrefix={testIDPrefix}
          title={title}
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('SellStatusOverlay', () => {
  it('renders a full-bleed yellow processing screen', () => {
    renderOverlay('processing', 'single-sell', 'Processing sale', 'Selling $12.50', 'Locking in the sale.');

    expect(screen.getByTestId('single-sell-status-screen')).toBeTruthy();
    expect(screen.getByText('Processing sale')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-status-screen').props.style)).toMatchObject({
      backgroundColor: '#FEE333',
    });
  });

  it('renders the success confirmation copy for bulk sell', () => {
    renderOverlay('success', 'bulk-sell', 'Congrats!', 'Batch sale confirmed', '3 cards sold for $18.50.');

    expect(screen.getByTestId('bulk-sell-status-screen')).toBeTruthy();
    expect(screen.getByText('Congrats!')).toBeTruthy();
    expect(screen.getByText('Batch sale confirmed')).toBeTruthy();
  });
});
