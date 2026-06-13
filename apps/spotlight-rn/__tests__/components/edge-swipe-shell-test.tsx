import { screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { TopTabsPager } from '@/components/top-tabs-pager';
import { renderWithProviders } from '../test-utils';

// TopTabsPager (and the AppBottomTabBar it renders) reach for expo-router's
// useFocusEffect / useRouter, which need a navigation context this unit render
// doesn't provide. Run the focus effect as a plain effect and stub the router.
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: jest.fn(),
      canGoBack: jest.fn(() => false),
      push: jest.fn(),
      replace: jest.fn(),
    }),
  };
});

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

  it('can start on the portfolio page explicitly', () => {
    renderWithProviders(
      <TopTabsPager
        initialPage="portfolio"
        portfolioSlot={<Text testID="portfolio-content">Portfolio</Text>}
        renderScannerSlot={() => <Text testID="scanner-content">Scanner</Text>}
      />,
    );

    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({ selected: false });
  });
});
