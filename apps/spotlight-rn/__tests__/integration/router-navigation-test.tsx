import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text } from 'react-native';

import { renderAppRouter } from '../test-utils';

function ScanTabStub() {
  return <Text testID="scan-tab-stub">scanner</Text>;
}

function SearchTabStub() {
  return <Text testID="search-tab-stub">search</Text>;
}

describe('mobile app routing', () => {
  it('boots into Home, and reaches the Scanner tab', async () => {
    // The app opens on Home (`/`, the collection), not the Scanner (user, 2026-11-16).
    const app = renderAppRouter('/', { '(tabs)/scan': ScanTabStub });

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-title')).toBeTruthy();
    });
    expect(app.getPathname()).toBe('/');
    expect(screen.getByTestId('tab-pager')).toBeTruthy();

    act(() => {
      router.push('/scan');
    });

    // Scan is an ordinary TAB. It was briefly a launcher that pushed a
    // full-screen /scan-camera route to keep the bar off the viewfinder; that
    // stranded users on a blank screen every time they backed out. Nothing is
    // pushed: the pager's bar turns into the scanner bar on this page.
    await waitFor(() => {
      expect(app.getPathname()).toBe('/scan');
    });
    expect(screen.getByTestId('scan-tab-stub')).toBeTruthy();
  });

  it('reaches Search as a tab route', async () => {
    const app = renderAppRouter('/search', { '(tabs)/search': SearchTabStub });

    await waitFor(() => {
      expect(app.getPathname()).toBe('/search');
    });
    expect(await screen.findByTestId('search-tab-stub')).toBeTruthy();
  });

  // WATCHLIST is a bottom tab again (Figma 6775:16938), at its internal route
  // name `/wishlist`, so old links and pushes already sent land on it.
  it('opens /wishlist as the WATCHLIST tab, on its WATCHLIST page', async () => {
    const app = renderAppRouter('/wishlist');

    await waitFor(() => {
      expect(app.getPathname()).toBe('/wishlist');
    });
    await waitFor(() => {
      expect(screen.getByTestId('watchlist-tab-tabs-tab-watchlist').props.accessibilityState)
        .toEqual(expect.objectContaining({ selected: true }));
    });
  });

  // `/wishlist?tab=market` selects MARKET ANALYTICS, then clears the param so
  // the same link works again.
  it('opens /wishlist?tab=market on MARKET ANALYTICS', async () => {
    const app = renderAppRouter('/wishlist');
    await waitFor(() => {
      expect(screen.getByTestId('watchlist-tab-tabs-tab-watchlist')).toBeTruthy();
    });

    act(() => {
      router.push('/wishlist?tab=market');
    });

    await waitFor(() => {
      expect(screen.getByTestId('watchlist-tab-tabs-tab-market').props.accessibilityState)
        .toEqual(expect.objectContaining({ selected: true }));
    });
    await waitFor(() => {
      expect(app.getSearchParams().tab).toBeUndefined();
    });
    expect(app.getPathname()).toBe('/wishlist');
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
  });

  it('redirects the legacy /portfolio and /you routes onto Collection', async () => {
    const app = renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-title')).toBeTruthy();
    });
    // Selected-tab state is UIKit's now, so the assertion that survives is that
    // the legacy paths still land on Collection — back at `/` since the feed
    // moved to `/social`, and NOT on the feed.
    expect(app.getPathname()).toBe('/');
  });

  it('redirects /you onto Collection rather than the feed', async () => {
    const app = renderAppRouter('/you');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-title')).toBeTruthy();
    });
    expect(app.getPathname()).toBe('/');
  });

  it('serves the feed from the Social tab', async () => {
    const app = renderAppRouter('/social');

    await waitFor(() => {
      expect(screen.getByTestId('feed-header')).toBeTruthy();
    });
    expect(app.getPathname()).toBe('/social');
  });

  it('renders the labeler session route directly', async () => {
    renderAppRouter('/labeling/session');

    expect(await screen.findByText('Label Session')).toBeTruthy();
    expect(screen.getByTestId('labeler-search-input')).toBeTruthy();
  });

  it('does not render tab chrome on card detail stack routes', async () => {
    renderAppRouter('/cards/mcdonalds25-21');

    expect(await screen.findByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
  });

  it('opens the sale edit popup from the sales-history route', async () => {
    renderAppRouter('/sales-history');

    fireEvent.press(await screen.findByTestId('sales-card-sale-1'));

    expect(screen.getByText('Edit Sale Price')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('edit-sale-price-input'), '12');
    fireEvent.press(screen.getByTestId('edit-sale-confirm'));

    await waitFor(() => {
      expect(screen.queryByText('Edit Sale Price')).not.toBeOnTheScreen();
    });
  });
});
