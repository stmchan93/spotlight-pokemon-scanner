import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { ScanBulkConfirmSheet } from '@/features/scanner/components/scan-bulk-confirm-sheet';

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

type SheetProps = Parameters<typeof ScanBulkConfirmSheet>[0];

function renderSheet(overrides?: Partial<SheetProps>) {
  const props: SheetProps = {
    visible: true,
    title: 'Add 3 items to Collections?',
    description: 'These items will be added to your Collections using their current scan details.',
    confirmLabel: 'Add All',
    confirmVariant: 'dark',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  render(<ScanBulkConfirmSheet {...props} />, { wrapper: Wrapper });
  return props;
}

// Mirrors __tests__/components/button-test.tsx: resolve the Pressable's possibly
// function style (it depends on the pressed state) and flatten it to a plain map.
function flattenPressableStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  return (StyleSheet.flatten(resolved as never) as Record<string, unknown>) ?? {};
}

describe('ScanBulkConfirmSheet', () => {
  it('renders the passed title, description, confirm, and cancel when visible', () => {
    renderSheet();

    expect(screen.getByTestId('scan-bulk-confirm-sheet-title')).toHaveTextContent(
      'Add 3 items to Collections?',
    );
    expect(screen.getByTestId('scan-bulk-confirm-sheet-description')).toHaveTextContent(
      'These items will be added to your Collections using their current scan details.',
    );
    expect(screen.getByTestId('scan-bulk-confirm-sheet-confirm')).toBeTruthy();
    expect(screen.getByText('Add All')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('fires onConfirm when the confirm button is pressed', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scan-bulk-confirm-sheet-confirm'));

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel when the cancel button is pressed', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scan-bulk-confirm-sheet-cancel'));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('fires onCancel when the backdrop is pressed', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('scan-bulk-confirm-sheet-backdrop'));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('resolves the confirm fill to red (#D93025) for the destructive variant', () => {
    renderSheet({ confirmVariant: 'destructive', confirmLabel: 'Remove' });

    const flattened = flattenPressableStyle(
      screen.getByTestId('scan-bulk-confirm-sheet-confirm').props.style,
    );
    // dangerStrong (#D93025) red fill.
    expect(flattened.backgroundColor).toBe('#D93025');
  });

  it('resolves the confirm fill to black (#1A1A1A) for the dark variant', () => {
    renderSheet({ confirmVariant: 'dark' });

    const flattened = flattenPressableStyle(
      screen.getByTestId('scan-bulk-confirm-sheet-confirm').props.style,
    );
    // gray900 (#1A1A1A) black fill.
    expect(flattened.backgroundColor).toBe('#1A1A1A');
  });
});
