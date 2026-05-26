import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { ScanningForSheet } from '@/features/scanner/components/scanning-for-sheet';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

function renderSheet(overrides?: Partial<Parameters<typeof ScanningForSheet>[0]>) {
  const props = {
    visible: true,
    condition: 'ungraded' as const,
    cardType: 'pokemon_en' as const,
    onSelectCondition: jest.fn(),
    onSelectCardType: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  render(<ScanningForSheet {...props} />, { wrapper: Wrapper });
  return props;
}

describe('ScanningForSheet', () => {
  it('selects a condition and a card type', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scanning-for-sheet-condition-graded'));
    expect(props.onSelectCondition).toHaveBeenCalledWith('graded');

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-jp'));
    expect(props.onSelectCardType).toHaveBeenCalledWith('pokemon_jp');
  });

  it('reflects the selected option via the radio accessibility state', () => {
    renderSheet({ condition: 'graded', cardType: 'pokemon_jp' });

    expect(
      screen.getByTestId('scanning-for-sheet-condition-graded').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      screen.getByTestId('scanning-for-sheet-condition-ungraded').props.accessibilityState,
    ).toMatchObject({ selected: false });
    expect(
      screen.getByTestId('scanning-for-sheet-type-pokemon-jp').props.accessibilityState,
    ).toMatchObject({ selected: true });
  });

  it('renders disabled "Coming Soon" rows for unshipped games', () => {
    renderSheet();

    // Each unshipped game shows a Coming Soon badge…
    expect(screen.getAllByText('Coming Soon').length).toBeGreaterThanOrEqual(6);
    // …and the rows are not selectable (no radio control / testID).
    expect(screen.getByText('Lorcana')).toBeTruthy();
    expect(screen.queryByTestId('scanning-for-sheet-type-lorcana')).toBeNull();
  });

  it('closes when the backdrop is pressed', () => {
    const props = renderSheet();
    fireEvent.press(screen.getByTestId('scanning-for-sheet-backdrop'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
