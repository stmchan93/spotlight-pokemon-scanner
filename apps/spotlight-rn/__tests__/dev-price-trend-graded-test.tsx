import { screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { createDevRepository, DEV_GRADED_CARD_ID } from '@/dev/dev-repository';

import { renderWithProviders } from './test-utils';

/*
  The dev screenshot route (`spotlight://dev/price-trend-graded`) renders the
  REAL PDP against the dev repository. What has to hold: the page opens on the
  PSA lane by itself (no owned slab, no tap), and the Price Trend block carries
  the whole PSA 10 → PSA 1 ladder under the eBay mark with the fixture prices.
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

  it('opens on the PSA lane and lists the PSA 10 → PSA 1 ladder with eBay branding', async () => {
    const spotlightRepository = await createDevRepository();
    renderWithProviders(
      <CardDetailScreen cardId={DEV_GRADED_CARD_ID} onBack={() => undefined} />,
      { spotlightRepository },
    );

    expect(await screen.findByTestId('detail-name')).toHaveTextContent('Darkrai & Cresselia LEGEND');
    await waitFor(() => {
      expect(screen.getByTestId('detail-configurator-grader-PSA').props.accessibilityState).toEqual({
        selected: true,
      });
    });

    expect(await screen.findByTestId('detail-price-trends-row-PSA|10|holofoil')).toBeTruthy();
    expect(screen.getByLabelText('eBay')).toBeTruthy();

    const rows = screen.getAllByTestId(/^detail-price-trends-row-PSA\|[\d.]+\|holofoil$/);
    expect(rows.map((row) => row.props.testID)).toEqual([
      '10', '9', '8.5', '8', '7', '6', '5', '4', '3', '2', '1.5', '1',
    ].map((grade) => `detail-price-trends-row-PSA|${grade}|holofoil`));

    expect(screen.getByTestId('detail-price-trends-price-PSA|10|holofoil')).toHaveTextContent('$4,357.28');
    expect(screen.getByTestId('detail-price-trends-price-PSA|8.5|holofoil')).toHaveTextContent('$1,665.46');
    expect(screen.getByTestId('detail-price-trends-price-PSA|1|holofoil')).toHaveTextContent('$1,825.00');
    // Graded rows are the accordion: collapsed chevrons, no raw-lane link chevron.
    // getAll: the icon mock repeats the testID on the Svg and its child.
    expect(screen.getAllByTestId('detail-price-trends-row-PSA|10|holofoil-chevron-closed').length).toBeGreaterThan(0);
    expect(screen.queryByTestId(/chevron-link$/)).toBeNull();
  });
});
