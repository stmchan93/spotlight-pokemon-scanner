import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text } from 'react-native';

import { renderAppRouter } from '../test-utils';

function ScanTabStub() {
  return <Text testID="scan-tab-stub">scanner</Text>;
}

function WishlistTabStub() {
  return <Text testID="wishlist-stub-screen">wishlist</Text>;
}

describe('mobile app routing', () => {
  it('boots into Home, and reaches the Scanner tab', async () => {
    // The app opens on Home, the feed (`/social`), not the Scanner (user, 2026-11-16).
    const app = renderAppRouter('/', { '(tabs)/scan': ScanTabStub });

    await waitFor(() => {
      expect(app.getPathname()).toBe('/social');
    });
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

  it('reaches Wishlist as a tab route', async () => {
    // Wishlist was a PUSHED stack screen and is now a tab, so `/wishlist`
    // resolves inside (tabs). The three tests that used to live here covered the
    // custom bar's push/dismiss contract on that pushed screen — a contract that
    // no longer exists for Wishlist, since the tab navigator owns tab switching.
    //
    // That bar (`app-bottom-tab-bar`) has since been deleted outright — it had
    // no remaining call sites — so its duplicate-push guard is gone with it,
    // not relocated. This comment used to claim the guard was "still covered by
    // app-bottom-tab-bar's own tests"; there were never any such tests.
    const app = renderAppRouter('/wishlist', {
      // Stubbed for the same reason the pushed version was: this asserts the
      // ROUTE resolves inside (tabs), not the wishlist content.
      '(tabs)/wishlist': WishlistTabStub,
    });

    await waitFor(() => {
      expect(app.getPathname()).toBe('/wishlist');
    });
    expect(await screen.findByTestId('wishlist-stub-screen')).toBeTruthy();
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
  });

  it('redirects the legacy /portfolio and /you routes onto Collection', async () => {
    const app = renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    // Selected-tab state is UIKit's now, so the assertion that survives is that
    // the legacy paths still land on Collection — back at `/` since the feed
    // moved to `/social`, and NOT on the feed.
    expect(app.getPathname()).toBe('/');
  });

  it('redirects /you onto Collection rather than the feed', async () => {
    const app = renderAppRouter('/you');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
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
