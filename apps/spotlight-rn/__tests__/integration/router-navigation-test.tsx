import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { renderAppRouter } from '../test-utils';

// Stands in for the pushed Wishlist stack screen. What these tests exercise is
// the shared tab-bar contract pushed screens use (`activeKey="portfolio"
// dismissToTabs`) plus the router history — not the wishlist content itself.
function WishlistRouteStub() {
  return (
    <View style={{ flex: 1 }}>
      <Text testID="wishlist-stub-screen">wishlist</Text>
      <AppBottomTabBar activeKey="portfolio" dismissToTabs />
    </View>
  );
}

describe('mobile app routing', () => {
  it('boots into collection and navigates between portfolio and scan', async () => {
    renderAppRouter('/');

    // Collection is the landing tab — bottom nav shows with portfolio selected.
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({ selected: false });

    // Both pager slots are mounted simultaneously (real screens, not fake underlays)
    expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();

    // Press scan tab in bottom nav — switches to the scanner page.
    fireEvent.press(screen.getByTestId('bottom-nav-scan'));

    await waitFor(() => {
      // Bottom nav disappears on scanner page
      expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    });
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
    expect(screen.getByTestId('scanner-prompt').props.children).toBe('Tap to scan');
    expect(screen.getByTestId('scanner-tray')).toBeTruthy();

    // Press scanner back button — switches pager back to portfolio.
    fireEvent.press(screen.getByTestId('scanner-back-button'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });
    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
  });

  it('keeps the wishlist screen in history when Scan is opened from its tab bar', async () => {
    const app = renderAppRouter('/', { '(stack)/wishlist/index': WishlistRouteStub });

    await waitFor(() => {
      expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();
    });

    act(() => {
      router.push('/wishlist');
    });

    expect(await screen.findByTestId('wishlist-stub-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/wishlist');

    // Scan tab on the pushed wishlist screen (the covered tabs root may also
    // mount a tab bar, so target the last-mounted one). It must PUSH the tabs
    // route — not dismiss back to it — so the wishlist screen stays in history.
    const scanTabs = screen.getAllByTestId('bottom-nav-scan');
    fireEvent.press(scanTabs[scanTabs.length - 1]);

    await waitFor(() => {
      expect(app.getPathname()).toBe('/');
    });
    expect(app.getSearchParams()).toEqual({ page: 'scanner' });

    // Going back (iOS back-swipe / Android back) lands on the wishlist screen
    // the user scanned from, not on the tabs root's Collection page.
    act(() => {
      router.back();
    });

    await waitFor(() => {
      expect(app.getPathname()).toBe('/wishlist');
    });
  });

  it('returns to the wishlist screen via the scanner back button', async () => {
    const app = renderAppRouter('/', { '(stack)/wishlist/index': WishlistRouteStub });

    await waitFor(() => {
      expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();
    });

    act(() => {
      router.push('/wishlist');
    });
    expect(await screen.findByTestId('wishlist-stub-screen')).toBeTruthy();

    const scanTabs = screen.getAllByTestId('bottom-nav-scan');
    fireEvent.press(scanTabs[scanTabs.length - 1]);

    await waitFor(() => {
      expect(app.getPathname()).toBe('/');
    });

    // Two pager instances are mounted now (tabs root + the pushed scan route);
    // the visible scanner is the last-mounted one.
    const backButtons = screen.getAllByTestId('scanner-back-button');
    fireEvent.press(backButtons[backButtons.length - 1]);

    await waitFor(() => {
      expect(app.getPathname()).toBe('/wishlist');
    });
  });

  it('a rapid double-tap on the Wishlist tab pushes it only once (no duplicate Back returns to)', async () => {
    const app = renderAppRouter('/', { '(stack)/wishlist/index': WishlistRouteStub });

    await waitFor(() => {
      expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();
    });

    // Hammer the Wishlist tab from the tabs root before the push transition
    // settles. Only the first tap should navigate — the rest are coalesced.
    const wishlistTab = screen.getByTestId('bottom-nav-wishlist');
    fireEvent.press(wishlistTab);
    fireEvent.press(wishlistTab);
    fireEvent.press(wishlistTab);

    expect(await screen.findByTestId('wishlist-stub-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/wishlist');

    // A single Back must leave Wishlist entirely. A duplicate push would leave a
    // second /wishlist underneath, so Back would land on Wishlist again.
    act(() => {
      router.back();
    });

    await waitFor(() => {
      expect(app.getPathname()).toBe('/');
    });
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
  });

  it('opens the portfolio route with the portfolio page active', async () => {
    renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();
    });

    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({ selected: false });
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
      expect(screen.queryByText('Edit Sale Price')).toBeNull();
    });
  });
});
