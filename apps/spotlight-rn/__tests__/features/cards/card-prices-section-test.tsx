import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { CardPricesSection } from '@/features/cards/components/card-prices-section';
import { buildGradeLadder, buildRawPriceRows } from '@/features/cards/grade-ladder';

import { renderWithProviders } from '../../test-utils';

const row = (key: string, label: string, currentPrice: number) => ({
  key,
  label,
  currentPrice,
  currencyCode: 'USD',
  points: [1, 2],
  trendPct: null,
});

const rawRows = buildRawPriceRows([
  row('normal|NM', 'Near Mint', 42),
  row('normal|MP', 'Moderately Played', 28),
]);
const ladder = buildGradeLadder(rawRows[0]!.row, [row('PSA|10|normal', 'PSA 10', 310), row('PSA|8|normal', 'PSA 8', 55)]);
const graders = [
  { grader: 'PSA', top: { grade: '10', price: 310 } },
  { grader: 'BGS', top: { grade: '10', price: 420 } },
];

describe('CardPricesSection', () => {
  it('renders RAW deltas, grader tabs and rungs (high → low, no bars, no hint) with chevrons, and reports taps', () => {
    const onPressRawRow = jest.fn();
    const onToggleRung = jest.fn();
    const onSelectGrader = jest.fn();
    renderWithProviders(
      <CardPricesSection
        graders={graders}
        ladder={ladder}
        onPressRawRow={onPressRawRow}
        onSelectGrader={onSelectGrader}
        onToggleRung={onToggleRung}
        rawRows={rawRows}
        selectedGrader="PSA"
      />,
    );

    expect(screen.getByTestId('detail-prices-raw-NM-delta')).toHaveTextContent('base');
    expect(screen.getAllByTestId('detail-prices-raw-NM-chevron').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^RAW$/)).toBeNull();
    expect(screen.queryByText(/GRADED/)).toBeNull();
    // Near Mint alone until the conditions toggle opens the rest.
    expect(screen.queryByTestId('detail-prices-raw-MP')).toBeNull();
    expect(screen.getByTestId('detail-prices-conditions-toggle')).toHaveTextContent('Show all conditions');
    fireEvent.press(screen.getByTestId('detail-prices-conditions-toggle'));
    expect(screen.getByTestId('detail-prices-conditions-toggle')).toHaveTextContent('Show less');
    expect(screen.getByTestId('detail-prices-raw-MP')).toHaveTextContent(/Mod\. Played/);
    expect(screen.getByTestId('detail-prices-raw-MP-delta')).toHaveTextContent('−$14.00');
    expect(screen.getAllByTestId('detail-prices-raw-MP-chevron').length).toBeGreaterThan(0);
    expect(screen.getByTestId('detail-prices-grader-PSA').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getAllByTestId(/^detail-prices-rung-[\d.]+$/).map((rung) => rung.props.testID))
      .toEqual(['detail-prices-rung-10', 'detail-prices-rung-8']);
    expect(screen.getByTestId('detail-prices-rung-10-delta')).toHaveTextContent('+$268');
    expect(screen.getByTestId('detail-prices-rung-10-multiple')).toHaveTextContent('7.4×');
    expect(screen.getAllByTestId('detail-prices-rung-10-chevron').length).toBeGreaterThan(0);
    expect(screen.getByTestId('detail-prices-rung-10').props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByTestId('detail-prices-hint')).toBeNull();
    expect(screen.queryByText('Tap any row to chart it')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-prices-raw-MP'));
    expect(onPressRawRow).toHaveBeenCalledWith(expect.objectContaining({ key: 'normal|MP' }));
    fireEvent.press(screen.getByTestId('detail-prices-rung-8'));
    expect(onToggleRung).toHaveBeenCalledWith(expect.objectContaining({ grade: '8', key: 'PSA|8|normal' }));
    fireEvent.press(screen.getByTestId('detail-prices-grader-BGS'));
    expect(onSelectGrader).toHaveBeenCalledTimes(1);
    expect(onSelectGrader).toHaveBeenCalledWith('BGS');

    fireEvent.press(screen.getByTestId('detail-prices-conditions-toggle'));
    expect(screen.queryByTestId('detail-prices-raw-MP')).toBeNull();
    expect(screen.getByTestId('detail-prices-conditions-toggle')).toHaveTextContent('Show all conditions');
  });

  it('renders the expanded content under the open rung only, with a down chevron', () => {
    renderWithProviders(
      <CardPricesSection
        expandedContent={<Text testID="comps">comps</Text>}
        expandedRowKey="PSA|8|normal"
        graders={graders}
        ladder={ladder}
        onPressRawRow={jest.fn()}
        onSelectGrader={jest.fn()}
        onToggleRung={jest.fn()}
        rawRows={rawRows}
        selectedGrader="PSA"
      />,
    );
    expect(screen.getByTestId('detail-prices-rung-8-expanded')).toContainElement(screen.getByTestId('comps'));
    expect(screen.queryByTestId('detail-prices-rung-10-expanded')).toBeNull();
    expect(screen.getByTestId('detail-prices-rung-8').props.accessibilityState).toMatchObject({ expanded: true });
  });

  it('without onToggleRung the graded rows are static: no chevron, nothing to expand', () => {
    renderWithProviders(
      <CardPricesSection
        expandedContent={<Text testID="comps">comps</Text>}
        expandedRowKey="PSA|10|normal"
        graders={graders}
        ladder={ladder}
        onPressRawRow={jest.fn()}
        onSelectGrader={jest.fn()}
        rawRows={rawRows}
        selectedGrader="PSA"
      />,
    );
    expect(screen.getByTestId('detail-prices-rung-10')).toBeTruthy();
    expect(screen.queryAllByTestId('detail-prices-rung-10-chevron')).toHaveLength(0);
    expect(screen.queryByTestId('comps')).toBeNull();
    expect(screen.getAllByTestId('detail-prices-raw-NM-chevron').length).toBeGreaterThan(0);
  });

  it('one priced grader: no header row (no label, no tabs, no top-grade line); no grader hides GRADED', () => {
    const { rerender } = renderWithProviders(
      <CardPricesSection
        graders={[graders[0]!]}
        ladder={ladder}
        onPressRawRow={jest.fn()}
        onSelectGrader={jest.fn()}
        onToggleRung={jest.fn()}
        rawRows={rawRows}
        selectedGrader="PSA"
      />,
    );
    expect(screen.getByTestId('detail-prices-graded')).not.toHaveTextContent(/GRADED/);
    expect(screen.getByTestId('detail-prices-rung-10')).toBeTruthy();
    expect(screen.queryByTestId('detail-prices-grader-PSA')).toBeNull();
    expect(screen.queryByTestId('detail-prices-top')).toBeNull();

    rerender(
      <CardPricesSection
        graders={[]}
        ladder={buildGradeLadder(null, [])}
        onPressRawRow={jest.fn()}
        onSelectGrader={jest.fn()}
        rawRows={rawRows}
        selectedGrader={null}
      />,
    );
    expect(screen.queryByTestId('detail-prices-graded')).toBeNull();
    expect(screen.getByTestId('detail-prices-raw-NM')).toBeTruthy();
  });
});
