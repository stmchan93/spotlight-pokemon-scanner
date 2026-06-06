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
    cardType: 'pokemon_en' as const,
    onSelectCardType: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  render(<ScanningForSheet {...props} />, { wrapper: Wrapper });
  return props;
}

describe('ScanningForSheet', () => {
  it('renders the SCANNING FOR header and no condition (Graded/Ungraded) controls', () => {
    renderSheet();

    expect(screen.getByText('SCANNING FOR')).toBeTruthy();
    // Grading moved to the PDP — the scanner sheet no longer offers a condition.
    expect(screen.queryByText('Graded')).toBeNull();
    expect(screen.queryByText('Ungraded')).toBeNull();
    expect(screen.queryByTestId('scanning-for-sheet-condition-graded')).toBeNull();
    expect(screen.queryByTestId('scanning-for-sheet-condition-ungraded')).toBeNull();
  });

  it('selects an EN/JP card type', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-jp'));
    expect(props.onSelectCardType).toHaveBeenCalledWith('pokemon_jp');

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-en'));
    expect(props.onSelectCardType).toHaveBeenCalledWith('pokemon_en');
  });

  it('reflects the selected card type via the radio accessibility state', () => {
    renderSheet({ cardType: 'pokemon_jp' });

    expect(
      screen.getByTestId('scanning-for-sheet-type-pokemon-jp').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      screen.getByTestId('scanning-for-sheet-type-pokemon-en').props.accessibilityState,
    ).toMatchObject({ selected: false });
  });

  it('renders disabled "Coming Soon" rows for unshipped games', () => {
    renderSheet();

    // Each unshipped game shows a Coming Soon tag…
    expect(screen.getAllByText('Coming Soon').length).toBe(6);
    // …and the rows are not interactive (no radio control / testID).
    expect(screen.getByText('Lorcana')).toBeTruthy();
    expect(screen.getByText('Magic: The Gathering')).toBeTruthy();
    expect(screen.getByText('Yu-Gi-Oh')).toBeTruthy();
    expect(screen.queryByTestId('scanning-for-sheet-type-lorcana')).toBeNull();
  });

  it('closes when the backdrop is pressed', () => {
    const props = renderSheet();
    fireEvent.press(screen.getByTestId('scanning-for-sheet-backdrop'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
