import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Collection } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CollectionPickerSheet } from '@/features/portfolio/components/collection-picker-sheet';

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

const MAIN: Collection = {
  id: 'collection:main',
  name: 'Main Collection',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  cardCount: 12,
  totalValue: 1450.12,
  isDefault: true,
};

const GRAILS: Collection = {
  id: 'collection:grails',
  name: 'Gengar Only',
  sortOrder: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  cardCount: 3,
  totalValue: 1450.12,
  isDefault: false,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof CollectionPickerSheet>> = {}) {
  const props = {
    activeCollectionID: MAIN.id,
    allTotals: { cardCount: 15, totalValue: 2900.24 },
    collections: [MAIN, GRAILS],
    formatValue: (value: number) => `$${value.toFixed(2)}`,
    onClose: jest.fn(),
    onCreateCollection: jest.fn(async () => {}),
    onSelectCollection: jest.fn(),
    visible: true,
    ...overrides,
  };
  render(<CollectionPickerSheet {...props} />, { wrapper: Wrapper });
  return props;
}

describe('CollectionPickerSheet', () => {
  it('lists the All row and every collection with its value', () => {
    renderSheet();

    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.getByText('All Collection')).toBeTruthy();
    expect(screen.getByText('$2900.24')).toBeTruthy();
    expect(screen.getByText('Main Collection')).toBeTruthy();
    expect(screen.getByText('Gengar Only')).toBeTruthy();
  });

  it('selects a collection and closes', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-collection:grails'));

    expect(props.onSelectCollection).toHaveBeenCalledWith('collection:grails');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('selects the aggregate from the All row', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-all'));

    expect(props.onSelectCollection).toHaveBeenCalledWith('all');
  });

  it('ADD opens the New Collection form, and CREATE stays disabled until it is named', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));

    expect(screen.getByText('New Collection')).toBeTruthy();
    // Pressing CREATE with an empty name must not create anything.
    fireEvent.press(screen.getByTestId('collection-picker-sheet-create'));
    expect(props.onCreateCollection).not.toHaveBeenCalled();
  });

  it('creates the collection with a trimmed name and closes', async () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
    fireEvent.changeText(screen.getByTestId('collection-picker-sheet-name-input'), '  Grails  ');
    fireEvent.press(screen.getByTestId('collection-picker-sheet-create'));

    await waitFor(() => {
      expect(props.onCreateCollection).toHaveBeenCalledWith('Grails');
    });
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  it('keeps the typed name and stays open when creating fails', async () => {
    const props = renderSheet({
      onCreateCollection: jest.fn(async () => {
        throw new Error('offline');
      }),
    });

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
    fireEvent.changeText(screen.getByTestId('collection-picker-sheet-name-input'), 'Grails');
    fireEvent.press(screen.getByTestId('collection-picker-sheet-create'));

    expect(await screen.findByTestId('collection-picker-sheet-error')).toBeTruthy();
    // Losing what they typed would be the worst possible failure here.
    expect(screen.getByTestId('collection-picker-sheet-name-input').props.value).toBe('Grails');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('goes back to the list from the form instead of closing the sheet', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
    fireEvent.press(screen.getByTestId('collection-picker-sheet-back'));

    expect(screen.getByText('Collection')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('insets the header on the same 16pt gutter as the rows and centers the title', () => {
    renderSheet();

    // Regression: SheetHeader ships with NO horizontal padding, so a caller that
    // forgets to pass one gets a back chevron flush against the screen edge and
    // an ADD label clipped off the right. Walk up from the chevron to find the
    // padded container.
    type StyledNode = { parent: StyledNode | null; props: Record<string, unknown> };
    let node: StyledNode | null = screen.getByTestId(
      'collection-picker-sheet-back',
    ) as unknown as StyledNode;
    let gutter: number | undefined;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const flat = StyleSheet.flatten(node.props?.style as never) as { paddingHorizontal?: number };
      if (flat?.paddingHorizontal != null) {
        gutter = flat.paddingHorizontal;
        break;
      }
      node = node.parent;
    }
    expect(gutter).toBe(16);

    // Figma 3377:3133 centers "Collection" rather than left-packing it after the
    // chevron, which is what align="leading" (the SheetHeader default) does.
    const title = StyleSheet.flatten(screen.getByText('Collection').props.style) as {
      textAlign?: string;
    };
    expect(title.textAlign).toBe('center');
  });

  it('does NOT render the deferred rename/hide/delete controls', () => {
    // v1 is create + switch. The Figma rows carry eye/pencil/trash icons that
    // nothing is wired to yet — shipping them dead would be worse than omitting
    // them, so this pins their absence.
    renderSheet();

    expect(screen.queryByLabelText('Rename collection')).toBeNull();
    expect(screen.queryByLabelText('Delete collection')).toBeNull();
    expect(screen.queryByLabelText('Hide collection')).toBeNull();
  });
});
