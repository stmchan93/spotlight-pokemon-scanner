import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text } from 'react-native';

import { renderAppRouter } from '../test-utils';

function WishlistTabStub() {
  return <Text testID="wishlist-stub-screen">wishlist</Text>;
}

describe('mobile app routing', () => {
  it('boots into collection and navigates between the tabs', async () => {
    const app = renderAppRouter('/');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });

    // The pager is gone: Collection and Scan are separate ROUTES now, not two
    // slots mounted side-by-side behind a translate. Nothing should render it.
    expect(screen.queryByTestId('top-tabs-pager')).toBeNull();

    act(() => {
      router.push('/scan');
    });

    await waitFor(() => {
      expect(screen.getByTestId('scanner-prompt').props.children).toBe('Tap to scan');
    });
    expect(screen.getByTestId('scanner-tray')).toBeTruthy();

    // The scanner's back affordance returns to Collection.
    fireEvent.press(screen.getByTestId('scanner-back-button'));

    await waitFor(() => {
      expect(app.getPathname()).toBe('/');
    });
    expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
  });

  it('reaches Wishlist as a tab route', async () => {
    // Wishlist was a PUSHED stack screen and is now a tab, so `/wishlist`
    // resolves inside (tabs). The three tests that used to live here covered the
    // custom bar's push/dismiss contract on that pushed screen — a contract that
    // no longer exists for Wishlist, since UIKit owns tab switching. The
    // duplicate-push guard itself is still covered by app-bottom-tab-bar's own
    // tests, which is where it belongs.
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

  it('redirects the legacy /portfolio route onto the Collection tab', async () => {
    const app = renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    // Selected-tab state is UIKit's now, so the assertion that survives is
    // that the legacy path still lands on Collection.
    expect(app.getPathname()).toBe('/');
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
