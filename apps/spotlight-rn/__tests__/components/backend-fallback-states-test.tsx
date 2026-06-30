import { screen, waitFor } from '@testing-library/react-native';

import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';

import { renderWithProviders } from '../test-utils';

// PortfolioScreen's dashboard refresh is gated on activePage='portfolio'.
// Default context value is 'scanner', so isolated test renders must override.
const portfolioTabsContext = {
  activePage: 'portfolio' as const,
  chartScrubLockRef: { current: false },
  collectionEditing: false,
  setCollectionEditing: () => {},
};

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
      <TabsPageContext.Provider value={portfolioTabsContext}>
        <PortfolioScreen />
      </TabsPageContext.Provider>,
      { spotlightRepository: repository },
    );

    // Portfolio shell uses a centered "Collection" title in the redesign.
    expect(await screen.findByTestId('portfolio-header-title')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Loading Ekalight...')).toBeNull();
    });
    // The dashboard now retries once on transport failure with a ~1.2s backoff,
    // so the error card surfaces later than findByText's 1s default allows.
    expect(
      await screen.findByText('Could not load your backend data', {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText('backend offline')).toBeTruthy();
  });

  it('renders the inventory backend error state instead of a fake empty collection on load failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('backend offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenEntry={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Could not load your backend data')).toBeTruthy();
    expect(screen.getByText('backend offline')).toBeTruthy();
    expect(screen.queryByText('Loading your inventory...')).toBeNull();
  });
});
