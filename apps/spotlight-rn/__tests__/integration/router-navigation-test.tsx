import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderAppRouter } from '../test-utils';

describe('mobile app routing', () => {
  it('boots into scan and navigates between portfolio, scan, and sales history', async () => {
    renderAppRouter('/');

    expect(await screen.findByText('Tap anywhere to scan')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray')).toBeTruthy();
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
    expect(screen.getByTestId('scanner-back-button')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-mode-toggle-slabs'));
    expect(screen.getByTestId('scanner-slab-guide')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-mode-toggle-raw'));
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-slab-guide')).toBeNull();
    });

    fireEvent.press(screen.getByTestId('scanner-back-button'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    });
    expect(screen.getByTestId('bottom-nav-portfolio').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('bottom-nav-scan').props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(screen.getByTestId('bottom-nav-scan'));

    await waitFor(() => {
      expect(screen.getByText('Tap anywhere to scan')).toBeTruthy();
    });
  });

  it('renders the sales-history route directly', async () => {
    renderAppRouter('/sales-history');

    expect(await screen.findByText('All Transactions')).toBeTruthy();
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
