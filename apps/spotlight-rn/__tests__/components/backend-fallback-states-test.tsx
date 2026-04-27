import { screen, waitFor } from '@testing-library/react-native';

import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

import { AddToCollectionScreen } from '@/features/collection/screens/add-to-collection-screen';
import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';

import { renderWithProviders } from '../test-utils';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (body === undefined) {
        return '';
      }

      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  } as Response;
}

describe('backend-backed fallback states', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('renders a backend error card instead of pretending the portfolio is empty when requests fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('backend offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    renderWithProviders(
      <PortfolioScreen onOpenSalesHistory={jest.fn()} />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Track value, inventory, and latest transactions in one place.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Loading Loooty...')).toBeNull();
    });
    expect(screen.getByText('Could not load your backend data')).toBeTruthy();
    expect(screen.getByText('backend offline')).toBeTruthy();
  });

  it('renders the inventory backend error state instead of a fake empty collection on load failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('backend offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenBulkSell={jest.fn()}
        onOpenEntry={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Could not load your backend data')).toBeTruthy();
    expect(screen.getByText('backend offline')).toBeTruthy();
    expect(screen.queryByText('Loading your inventory...')).toBeNull();
  });

  it('shows the load-error card for add-to-collection when the backend returns not found', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/missing-card/market-history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          points: [],
          availableVariants: [],
          availableConditions: [],
        });
      }

      if (url.includes('/api/v1/cards/missing-card')) {
        return jsonResponse(404, { error: 'missing' });
      }

      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    renderWithProviders(
      <AddToCollectionScreen cardId="missing-card" onClose={jest.fn()} />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Unable to load card')).toBeTruthy();
    expect(screen.getByText('Unable to load this card right now.')).toBeTruthy();
    expect(screen.getByTestId('add-to-collection-retry')).toBeTruthy();
  });
});
