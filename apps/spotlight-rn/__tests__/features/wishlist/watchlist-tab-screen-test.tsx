import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { WatchlistTabScreen } from '@/features/wishlist/screens/watchlist-tab-screen';
import {
  MARKET_ANALYTICS_HREF,
  WATCHLIST_HREF,
  parseWatchlistPageTabParam,
} from '@/lib/watchlist-tab';

const mockWatchlistPage = jest.fn();
const mockMarketPage = jest.fn();

// The two pages have their own suites; here they are stand-ins that record
// what the host hands them.
jest.mock('@/features/wishlist/screens/wishlist-screen', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    WatchlistPage: (props: Record<string, unknown>) => {
      mockWatchlistPage(props);
      return <MockText testID="stub-watchlist-page">watchlist page</MockText>;
    },
  };
});

jest.mock('@/features/market/screens/market-analytics-page', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    MarketAnalyticsPage: (props: Record<string, unknown>) => {
      mockMarketPage(props);
      return <MockText testID="stub-market-page">market page</MockText>;
    },
  };
});

const mockAssistantContext = jest.fn();
jest.mock('@/features/assistant/page-context/assistant-page-context', () => ({
  useAssistantPageContext: (extra: unknown) => mockAssistantContext(extra),
}));

const SAFE_AREA = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 59 },
};

function renderScreen(element: ReactElement) {
  return render(<SafeAreaProvider initialMetrics={SAFE_AREA}>{element}</SafeAreaProvider>);
}

describe('WatchlistTabScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the WATCHLIST · MARKET ANALYTICS rail, on WATCHLIST', () => {
    renderScreen(<WatchlistTabScreen />);
    const labels = screen.UNSAFE_getAllByType(Text)
      .filter((node) => typeof node.props.children === 'string')
      .map((node) => node.props.children as string);
    expect(labels).toEqual(expect.arrayContaining(['WATCHLIST', 'MARKET ANALYTICS']));
    expect(labels.some((label) => /wishlist/i.test(label))).toBe(false);
    expect(screen.getByTestId('watchlist-tab-tabs-tab-watchlist').props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
    expect(screen.getByTestId('stub-watchlist-page')).toBeTruthy();
    // Market Analytics mounts on first visit, not with the tab.
    expect(screen.queryByTestId('stub-market-page')).toBeNull();
    expect(screen.getByTestId('watchlist-tab-market-placeholder')).toBeTruthy();
  });

  it('hosts the watchlist as an embedded collapsible page', () => {
    renderScreen(<WatchlistTabScreen />);
    const props = mockWatchlistPage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.page).toEqual(expect.objectContaining({ onScroll: expect.anything() }));
    expect(props.scrollRef).toEqual(expect.objectContaining({ current: null }));
    expect(typeof props.onEditModeChange).toBe('function');
    expect(props.isActive).toBe(false); // no tab pager around it: not the live page
  });

  it('switches to MARKET ANALYTICS on tap and back again', () => {
    renderScreen(<WatchlistTabScreen />);
    fireEvent.press(screen.getByTestId('watchlist-tab-tabs-tab-market'));
    expect(screen.getByTestId('watchlist-tab-tabs-tab-market').props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
    expect(screen.getByTestId('stub-market-page')).toBeTruthy();
    const marketProps = mockMarketPage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(marketProps.assistantContextRef).toEqual(expect.objectContaining({ current: null }));
    expect(marketProps.testID).toBe('watchlist-tab-market-page');

    fireEvent.press(screen.getByTestId('watchlist-tab-tabs-tab-watchlist'));
    expect(screen.getByTestId('watchlist-tab-tabs-tab-watchlist').props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
    // Once visited, Market Analytics stays mounted.
    expect(screen.getByTestId('stub-market-page')).toBeTruthy();
  });

  it('opens on the page the route asks for, then lets the route clear it', () => {
    const onHandled = jest.fn();
    renderScreen(<WatchlistTabScreen onRequestedTabHandled={onHandled} requestedTab="market" />);
    expect(screen.getByTestId('watchlist-tab-tabs-tab-market').props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
    expect(screen.getByTestId('stub-market-page')).toBeTruthy();
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it('gives the assistant Market Analytics context only while that page is shown', () => {
    renderScreen(<WatchlistTabScreen />);
    const read = () => {
      const source = mockAssistantContext.mock.calls.at(-1)?.[0] as () => unknown;
      return source();
    };
    expect(read()).toBeNull();
    fireEvent.press(screen.getByTestId('watchlist-tab-tabs-tab-market'));
    const marketProps = mockMarketPage.mock.calls.at(-1)?.[0] as { assistantContextRef: { current: unknown } };
    act(() => {
      marketProps.assistantContextRef.current = { label: 'Market · Pokémon' };
    });
    expect(read()).toEqual({ label: 'Market · Pokémon' });
  });
});

describe('watchlist tab route contract', () => {
  it('points at the WATCHLIST tab and its MARKET ANALYTICS page', () => {
    expect(WATCHLIST_HREF).toBe('/wishlist');
    expect(MARKET_ANALYTICS_HREF).toBe('/wishlist?tab=market');
  });

  it('parses the tab param defensively', () => {
    expect(parseWatchlistPageTabParam('market')).toBe('market');
    expect(parseWatchlistPageTabParam(['Watchlist'])).toBe('watchlist');
    expect(parseWatchlistPageTabParam('wishlist')).toBe('watchlist');
    expect(parseWatchlistPageTabParam('collection')).toBeNull();
    expect(parseWatchlistPageTabParam(undefined)).toBeNull();
    expect(parseWatchlistPageTabParam(42)).toBeNull();
  });
});
