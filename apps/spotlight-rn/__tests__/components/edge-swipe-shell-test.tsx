import { screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { TopTabsPager } from '@/components/top-tabs-pager';
import { renderWithProviders } from '../test-utils';

describe('TopTabsPager', () => {
  it('renders both slots simultaneously', () => {
    renderWithProviders(
      <TopTabsPager
        portfolioSlot={<Text testID="portfolio-content">Portfolio</Text>}
        renderScannerSlot={() => <Text testID="scanner-content">Scanner</Text>}
      />,
    );

    expect(screen.getByTestId('portfolio-content')).toBeTruthy();
    expect(screen.getByTestId('scanner-content')).toBeTruthy();
    expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();
  });

  it('starts on the scanner page with no bottom nav', () => {
    renderWithProviders(
      <TopTabsPager
        portfolioSlot={<Text testID="portfolio-content">Portfolio</Text>}
        renderScannerSlot={() => <Text testID="scanner-content">Scanner</Text>}
      />,
    );

    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
  });
});
