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
  it('boots into the Home feed and navigates to the Scanner tab', async () => {
    // `/` is the FEED now. Collection held this route until Home took it, which
    // is the one assertion here worth being explicit about: booting the app
    // must land on the feed, not the collection.
    const app = renderAppRouter('/', { '(tabs)/scan': ScanTabStub });

    await waitFor(() => {
      expect(screen.getByTestId('feed-header')).toBeTruthy();
    });
    expect(screen.queryByTestId('portfolio-header-menu')).toBeNull();

    // The pager is gone: Collection and Scan are separate ROUTES now, not two
    // slots mounted side-by-side behind a translate.
    expect(screen.queryByTestId('top-tabs-pager')).toBeNull();

    act(() => {
      router.push('/scan');
    });

    // Scan is an ordinary TAB again. It was briefly a launcher that pushed a
    // full-screen /scan-camera route to keep the bar off the viewfinder; that
    // stranded users on a blank screen every time they backed out. The bar is
    // now hidden on this route instead (`hidden` on <NativeTabs>), so the
    // camera stays full-screen without anything being pushed.
    await waitFor(() => {
      expect(app.getPathname()).toBe('/scan');
    });
    expect(screen.getByTestId('scan-tab-stub')).toBeTruthy();
  });

  it('reaches Wishlist as a tab route', async () => {
    // Wishlist was a PUSHED stack screen and is now a tab, so `/wishlist`
    // resolves inside (tabs). The three tests that used to live here covered the
    // custom bar's push/dismiss contract on that pushed screen — a contract that
    // no longer exists for Wishlist, since UIKit owns tab switching.
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
    expect(screen.queryByTestId('top-tabs-pager')).toBeNull();
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
  });

  it('redirects the legacy /portfolio route onto the You tab', async () => {
    const app = renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    // Selected-tab state is UIKit's now, so the assertion that survives is
    // that the legacy path still lands on Collection — which is `/you` since
    // Home took the tabs root, NOT `/`.
    expect(app.getPathname()).toBe('/you');
  });

  it('serves Collection from the You tab', async () => {
    const app = renderAppRouter('/you');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    expect(app.getPathname()).toBe('/you');
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
