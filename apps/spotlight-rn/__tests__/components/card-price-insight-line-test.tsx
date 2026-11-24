import { render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CardPriceInsightLine } from '@/features/cards/components/card-price-insight-line';

function renderLine(insight: React.ComponentProps<typeof CardPriceInsightLine>['insight']) {
  return render(
    <SpotlightThemeProvider>
      <CardPriceInsightLine insight={insight} />
    </SpotlightThemeProvider>,
  );
}

describe('CardPriceInsightLine', () => {
  it('shows the server sentence as accessible text', () => {
    renderLine({
      text: 'Up 18% in 30 days · near its 90-day high',
      facts: [{ kind: 'change_30d', value: 18 }, { kind: 'high_90d', value: 24.5 }],
    });
    const line = screen.getByTestId('detail-price-insight');
    expect(line.props.children).toBe('Up 18% in 30 days · near its 90-day high');
    expect(line.props.accessibilityLabel).toBe('Up 18% in 30 days · near its 90-day high');
  });

  it('renders nothing when there is no insight', () => {
    const { toJSON } = renderLine(null);
    expect(screen.queryByTestId('detail-price-insight')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('renders nothing for blank text', () => {
    renderLine({ text: '  ', facts: [] });
    expect(screen.queryByTestId('detail-price-insight')).toBeNull();
  });
});
