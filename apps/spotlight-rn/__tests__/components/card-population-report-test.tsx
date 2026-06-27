import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import type { CardPopulation } from '@spotlight/api-client';

import { CardPopulationReport } from '@/features/cards/components/card-population-report';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

const POPULATION: CardPopulation = {
  PSA: { totalPopulation: 12000, gemRate: 20.83, grades: { '10': 2500, '9': 9500 } },
  BGS: { totalPopulation: 1830, gemRate: 7.1, grades: { '10': 100, '9.5': 730 } },
};

function renderReport(props: React.ComponentProps<typeof CardPopulationReport>) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <CardPopulationReport {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('CardPopulationReport', () => {
  it('renders the selected grader’s grade distribution as a "<GRADER> Population Report: <total>" cell row', () => {
    renderReport({ population: POPULATION, grader: 'PSA', testID: 'pop' });

    expect(screen.getByText('PSA Population Report: 12,000')).toBeTruthy();
    // Highest grade first, with comma-formatted counts in horizontal cells.
    expect(screen.getByTestId('pop-grade-10')).toBeTruthy();
    expect(screen.getByTestId('pop-grade-9')).toBeTruthy();
    expect(screen.getByText('2,500')).toBeTruthy();
    expect(screen.getByText('9,500')).toBeTruthy();
  });

  it('switches the report when the grader changes (dynamic by grading company)', () => {
    const { rerender } = renderReport({ population: POPULATION, grader: 'PSA', testID: 'pop' });
    expect(screen.getByText('PSA Population Report: 12,000')).toBeTruthy();

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <CardPopulationReport population={POPULATION} grader="BGS" testID="pop" />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.queryByText('PSA Population Report: 12,000')).toBeNull();
    expect(screen.getByText('BGS Population Report: 1,830')).toBeTruthy();
    expect(screen.getByTestId('pop-grade-9.5')).toBeTruthy();
  });

  it('renders nothing for the raw lane or a grader without population', () => {
    // Raw lane → no report.
    renderReport({ population: POPULATION, grader: 'Raw', testID: 'pop' });
    expect(screen.queryByTestId('pop')).toBeNull();
    expect(screen.queryByText(/Population Report/)).toBeNull();

    // Grader the card has no synced population for → no report.
    renderReport({ population: POPULATION, grader: 'CGC', testID: 'pop' });
    expect(screen.queryByTestId('pop')).toBeNull();

    // No population at all → no report.
    renderReport({ population: null, grader: 'PSA', testID: 'pop' });
    expect(screen.queryByTestId('pop')).toBeNull();
  });
});
