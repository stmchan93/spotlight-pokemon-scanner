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
    lane: { game: 'pokemon', language: 'english' } as const,
    onSelectLane: jest.fn(),
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

  it('selects an EN/JP Pokémon lane', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-jp'));
    expect(props.onSelectLane).toHaveBeenCalledWith({ game: 'pokemon', language: 'japanese' });

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-en'));
    expect(props.onSelectLane).toHaveBeenCalledWith({ game: 'pokemon', language: 'english' });
  });

  it('offers every shipped game as a real, selectable lane', () => {
    const props = renderSheet();

    expect(screen.getByText('One Piece EN')).toBeTruthy();
    expect(screen.getByText('Disney Lorcana')).toBeTruthy();
    expect(screen.getByText('Riftbound')).toBeTruthy();
    expect(screen.getByText('Gundam')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-onepiece'));
    expect(props.onSelectLane).toHaveBeenCalledWith({ game: 'onepiece', language: 'english' });

    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-gundam'));
    expect(props.onSelectLane).toHaveBeenCalledWith({ game: 'gundam', language: 'english' });
  });

  it('offers no EN/JP split for games with no Japanese catalog', () => {
    renderSheet();

    // Only Pokémon has per-language rows; every other game gets exactly one.
    expect(screen.queryByTestId('scanning-for-sheet-type-onepiece-jp')).toBeNull();
    expect(screen.queryByTestId('scanning-for-sheet-type-lorcana-jp')).toBeNull();
    expect(screen.queryByTestId('scanning-for-sheet-type-riftbound-jp')).toBeNull();
    expect(screen.queryByTestId('scanning-for-sheet-type-gundam-jp')).toBeNull();
    expect(screen.queryByText('One Piece JP')).toBeNull();
    // One Piece's EN-only index now WEARS the EN tag (user decision 2026-08-31)
    // without offering a language toggle.
    expect(screen.queryByText('One Piece EN')).not.toBeNull();
  });

  it('reflects the selected lane via the radio accessibility state', () => {
    renderSheet({ lane: { game: 'onepiece', language: 'english' } });

    expect(
      screen.getByTestId('scanning-for-sheet-type-onepiece').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      screen.getByTestId('scanning-for-sheet-type-pokemon-en').props.accessibilityState,
    ).toMatchObject({ selected: false });
    expect(
      screen.getByTestId('scanning-for-sheet-type-pokemon-jp').props.accessibilityState,
    ).toMatchObject({ selected: false });
  });

  it('renders disabled "Coming Soon" rows only for games we have no catalog for', () => {
    renderSheet();

    expect(screen.getAllByText('Coming Soon').length).toBe(3);
    expect(screen.getByText('Magic: The Gathering')).toBeTruthy();
    expect(screen.getByText('Sports')).toBeTruthy();
    expect(screen.getByText('Yu-Gi-Oh')).toBeTruthy();
    // …and the rows are not interactive (no radio control / testID).
    expect(screen.queryByTestId('scanning-for-sheet-type-yugioh')).toBeNull();
  });

  it('closes when the backdrop is pressed', () => {
    const props = renderSheet();
    fireEvent.press(screen.getByTestId('scanning-for-sheet-backdrop'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the drag handle is tapped', () => {
    const props = renderSheet();
    fireEvent.press(screen.getByTestId('scanning-for-sheet-handle'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
