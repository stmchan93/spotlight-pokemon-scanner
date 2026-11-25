import { screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { createDevRepository, DEV_GRADED_CARD_ID } from '@/dev/dev-repository';

import { renderWithProviders } from './test-utils';

/*
  The dev screenshot route (`spotlight://dev/price-trend-graded`) renders the
  REAL PDP against the dev repository. What has to hold: the page opens on the
  PSA lane by itself (no owned slab, no tap), and the GRADED VALUE ladder
  PRICES card carries every PSA grade with the fixture prices.
*/

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// The placeholder PNGs live under the app's `assets/`, which jest's `@/` alias
// (src-only) cannot reach; the rewrite is cosmetic here, so pass URLs through.
jest.mock('@/dev/dev-fixtures', () => ({
  devImageUriForUrl: (url: string) => url,
}));

describe('CardDetailScreen graded dev route', () => {
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({
      replace: jest.fn(),
      push: jest.fn(),
      back: jest.fn(),
      dismissTo: jest.fn(),
    });
    clearCardDetailCache();
  });

  afterEach(() => {
    clearCardDetailCache();
  });

  it('opens on the PSA lane and lists PSA 10 → PSA 1 under PRICES', async () => {
    const spotlightRepository = await createDevRepository();
    renderWithProviders(
      <CardDetailScreen cardId={DEV_GRADED_CARD_ID} onBack={() => undefined} />,
      { spotlightRepository },
    );

    expect(await screen.findByTestId('detail-name')).toHaveTextContent('Darkrai & Cresselia LEGEND');
    // The chart opens on the PSA lane.
    await waitFor(() => {
      expect(within(screen.getByTestId('detail-price-chart-grader-chip')).getByText('PSA')).toBeTruthy();
    });

    // PRICES lists every PSA grade high → low, priced from the fixture.
    expect(await screen.findByTestId('detail-prices-rung-10')).toBeTruthy();
    expect(screen.queryByTestId('detail-price-trends')).toBeNull();

    const rungs = screen.getAllByTestId(/^detail-prices-rung-[\d.]+$/);
    expect(rungs.map((rung) => rung.props.testID)).toEqual([
      '10', '9', '8.5', '8', '7', '6', '5', '4', '3', '2', '1.5', '1',
    ].map((grade) => `detail-prices-rung-${grade}`));

    expect(screen.getByTestId('detail-prices-rung-10')).toHaveTextContent(/\$4,357\.28/);
    expect(screen.getByTestId('detail-prices-rung-8.5')).toHaveTextContent(/\$1,665\.46/);
    expect(screen.getByTestId('detail-prices-rung-1')).toHaveTextContent(/\$1,825\.00/);
  });
});
