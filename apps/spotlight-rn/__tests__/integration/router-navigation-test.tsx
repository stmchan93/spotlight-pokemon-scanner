import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderAppRouter } from '../test-utils';

describe('mobile app routing', () => {
  it('boots into scan and navigates between portfolio and scan', async () => {
    renderAppRouter('/');

    // Scanner starts active — camera preview should be enabled
    await waitFor(() => {
      expect(screen.getByTestId('scanner-preview').props.accessibilityState?.disabled).toBe(false);
    });
    expect(screen.getByTestId('scanner-prompt').props.children).toBe('Tap inside frame to scan');
    expect(screen.getByTestId('scanner-tray')).toBeTruthy();

    // No bottom nav on scanner page
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();

    // Both pager slots are mounted simultaneously (real screens, not fake underlays)
    expect(screen.getByTestId('top-tabs-pager')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-mode-toggle-slabs'));
    expect(screen.getByTestId('scanner-slab-guide')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-mode-toggle-raw'));
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-slab-guide')).toBeNull();
    });

    // Press scanner back button — switches pager to portfolio
    fireEvent.press(screen.getByTestId('scanner-back-button'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    });
    // Bottom nav appears on portfolio page
    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({ selected: false });

    // Press scan tab in bottom nav — switches back to scanner
    fireEvent.press(screen.getByTestId('bottom-nav-scan'));

    await waitFor(() => {
      // Bottom nav disappears on scanner page
      expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    });
    expect(screen.getByTestId('scanner-prompt').props.children).toBe('Tap inside frame to scan');
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
  });

  it('opens the portfolio route with the portfolio page active', async () => {
    renderAppRouter('/portfolio');

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
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
