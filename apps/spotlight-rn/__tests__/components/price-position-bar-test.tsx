import { render, screen, waitFor } from '@testing-library/react-native';

import { MockSpotlightRepository, type CardPriceTrendRow } from '@spotlight/api-client';
import { clampPercentile, PricePositionBar, pricePositionLabel, SpotlightThemeProvider } from '@spotlight/design-system';

import { CardPricePositionBar, pricePositionQueryForRow } from '@/features/cards/components/card-price-position';

function wrap(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

const row = (key: string, label = key): CardPriceTrendRow => ({
  key,
  label,
  currentPrice: 10,
  currencyCode: 'USD',
  points: [],
});

describe('pricePositionLabel', () => {
  it('reads percentile thirds, never a prediction', () => {
    expect(pricePositionLabel(0)).toBe('Cheaper than usual');
    expect(pricePositionLabel(33)).toBe('Cheaper than usual');
    expect(pricePositionLabel(34)).toBe('Mid-range');
    expect(pricePositionLabel(66)).toBe('Mid-range');
    expect(pricePositionLabel(67)).toBe('Pricier than usual');
    expect(pricePositionLabel(100)).toBe('Pricier than usual');
  });

  it('clamps out-of-range and non-finite percentiles', () => {
    expect(clampPercentile(-5)).toBe(0);
    expect(clampPercentile(140)).toBe(100);
    expect(clampPercentile(Number.NaN)).toBe(50);
  });
});

describe('PricePositionBar', () => {
  it('draws the label, ends, and a marker at the percentile', () => {
    wrap(<PricePositionBar detail="Past 3 months" highLabel="$90.00" lowLabel="$40.00" percentile={25} />);
    expect(screen.getByTestId('price-position-bar-label')).toHaveTextContent('Cheaper than usual');
    expect(screen.getByTestId('price-position-bar-low')).toHaveTextContent('$40.00');
    expect(screen.getByTestId('price-position-bar-high')).toHaveTextContent('$90.00');
    expect(screen.getByTestId('price-position-bar-detail')).toHaveTextContent('Past 3 months');
    expect(screen.getByTestId('price-position-bar-marker')).toHaveStyle({ left: '25%' });
    expect(screen.getByTestId('price-position-bar').props.accessibilityLabel)
      .toBe('Cheaper than usual. Low $40.00. High $90.00. Past 3 months');
  });

  it('takes a label override and drops the ends at sm', () => {
    wrap(<PricePositionBar highLabel="$9" label="Near its recent low" lowLabel="$1" percentile={4} size="sm" />);
    expect(screen.getByTestId('price-position-bar-label')).toHaveTextContent('Near its recent low');
    expect(screen.queryByTestId('price-position-bar-low')).toBeNull();
  });
});

describe('PDP price position', () => {
  it('maps raw and graded chart rows to the query', () => {
    expect(pricePositionQueryForRow('c1', 'Holofoil', 'raw', row('near_mint', 'Near Mint'))).toEqual({
      cardId: 'c1', variant: 'Holofoil', condition: 'near_mint', grader: null, grade: null,
    });
    expect(pricePositionQueryForRow('c1', null, 'graded', row('PSA 10'))).toEqual({
      cardId: 'c1', variant: null, condition: null, grader: 'PSA', grade: '10',
    });
    expect(pricePositionQueryForRow('c1', null, 'graded', row('BGS 9.5'))).toMatchObject({ grader: 'BGS', grade: '9.5' });
  });

  it('renders for the charted row and hides when there is no data', async () => {
    const repository = new MockSpotlightRepository();
    const spy = jest.spyOn(repository, 'getCardPricePosition');
    const view = wrap(
      <CardPricePositionBar cardId="sm7-1" mode="raw" repository={repository} row={row('near_mint')} variant={null} />,
    );
    expect(await screen.findByTestId('detail-price-position-label')).toBeTruthy();
    expect(spy).toHaveBeenCalledWith({ cardId: 'sm7-1', variant: null, condition: 'near_mint', grader: null, grade: null });
    expect(screen.getByTestId('detail-price-position-detail')).toHaveTextContent('Past 90 days');

    spy.mockResolvedValue(null);
    view.rerender(
      <SpotlightThemeProvider>
        <CardPricePositionBar cardId="sm7-1" mode="graded" repository={repository} row={row('PSA 10')} variant={null} />
      </SpotlightThemeProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('detail-price-position')).not.toBeOnTheScreen());
  });
});
