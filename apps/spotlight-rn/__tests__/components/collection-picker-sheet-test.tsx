import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Keyboard, StyleSheet } from 'react-native';
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
  hidden: false,
};

const GRAILS: Collection = {
  id: 'collection:grails',
  name: 'Gengar Only',
  sortOrder: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  cardCount: 3,
  totalValue: 1450.12,
  isDefault: false,
  hidden: false,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof CollectionPickerSheet>> = {}) {
  const props = {
    activeCollectionID: MAIN.id,
    allTotals: { cardCount: 15, totalValue: 2900.24 },
    collections: [MAIN, GRAILS],
    formatValue: (value: number) => `$${value.toFixed(2)}`,
    onClose: jest.fn(),
    onCreateCollection: jest.fn(async () => {}),
    onDismissed: jest.fn(),
    onRenameCollection: jest.fn(async () => {}),
    onToggleHidden: jest.fn(),
    onRequestDelete: jest.fn(),
    onSelectCollection: jest.fn(),
    visible: true,
    ...overrides,
  };
  const view = render(<CollectionPickerSheet {...props} />, { wrapper: Wrapper });
  return { ...props, rerender: (next: Partial<typeof props>) =>
    view.rerender(<CollectionPickerSheet {...props} {...next} />) };
}

describe('CollectionPickerSheet', () => {
  it('lists the All row and every collection with its value', () => {
    renderSheet();

    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.getByText('All Collections')).toBeTruthy();
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

  it('treats the All row as a readout, not a scope — tapping it selects nothing', () => {
    // The aggregate is informational: a REAL collection is always the active
    // one, so the row reports the un-scoped total but is not a destination.
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-all'));

    expect(props.onSelectCollection).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
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

    // Figma 3368:2567 centers "Collection" rather than left-packing it after the
    // chevron.
    const title = StyleSheet.flatten(screen.getByText('Collection').props.style) as {
      textAlign?: string;
    };
    expect(title.textAlign).toBe('center');

    // And it is centered on the SHEET, not between the accessories: the title
    // sits in an absolutely-positioned slot spanning the row, so the wider
    // "CREATE" label on the next step can't shove it off-centre. Walk up to that
    // slot the same way as the gutter above.
    let titleNode: StyledNode | null = screen.getByText('Collection') as unknown as StyledNode;
    let slotPosition: string | undefined;
    for (let depth = 0; depth < 6 && titleNode; depth += 1) {
      const flat = StyleSheet.flatten(titleNode.props?.style as never) as { position?: string };
      if (flat?.position === 'absolute') {
        slotPosition = flat.position;
        break;
      }
      titleNode = titleNode.parent;
    }
    expect(slotPosition).toBe('absolute');
  });

  it('renames from the row without closing the sheet', async () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-collection:grails-rename'));

    // The form opens prefilled — renaming starts from the current name.
    expect(screen.getByText('Rename Collection')).toBeTruthy();
    expect(screen.getByTestId('collection-picker-sheet-name-input').props.value).toBe('Gengar Only');

    fireEvent.changeText(screen.getByTestId('collection-picker-sheet-name-input'), 'Grails');
    fireEvent.press(screen.getByTestId('collection-picker-sheet-create'));

    await waitFor(() => {
      expect(props.onRenameCollection).toHaveBeenCalledWith('collection:grails', 'Grails');
    });
    // Renaming returns to the list rather than closing — seeing the new name is
    // the confirmation.
    await waitFor(() => {
      expect(screen.getByText('Collection')).toBeTruthy();
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('toggles hidden from the row', () => {
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-collection:grails-hide'));

    expect(props.onToggleHidden).toHaveBeenCalledWith(GRAILS);
  });

  it('asks the host to confirm a delete rather than deleting directly', () => {
    // Deleting takes the collection's CARDS with it, so the sheet must never be
    // the thing that performs it — the host owns the confirm.
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-row-collection:grails-delete'));

    expect(props.onRequestDelete).toHaveBeenCalledWith(GRAILS);
  });

  it('shows a delete button on every row while more than one collection exists', () => {
    renderSheet();

    expect(screen.getByTestId('collection-picker-sheet-row-collection:main-delete')).toBeTruthy();
    expect(screen.getByTestId('collection-picker-sheet-row-collection:grails-delete')).toBeTruthy();
  });

  it('offers no delete on the last remaining collection', () => {
    // A real collection must always exist to hold new adds — the backend
    // refuses to delete the last one, so the sheet doesn't offer it.
    renderSheet({ collections: [MAIN] });

    expect(screen.getByTestId('collection-picker-sheet-row-collection:main')).toBeTruthy();
    expect(
      screen.queryByTestId('collection-picker-sheet-row-collection:main-delete'),
    ).not.toBeOnTheScreen();
    // The other row actions stay — only the trash is withheld.
    expect(screen.getByTestId('collection-picker-sheet-row-collection:main-rename')).toBeTruthy();
    expect(screen.getByTestId('collection-picker-sheet-row-collection:main-hide')).toBeTruthy();
  });

  it('does NOT render a reorder handle — nothing persists an order yet', () => {
    // The Figma row carries a drag handle, but no endpoint stores an order, so
    // it stays out rather than shipping as a control that does nothing.
    renderSheet();

    expect(screen.queryByLabelText(/reorder/i)).toBeNull();
    expect(screen.queryByTestId('collection-picker-sheet-row-collection:grails-reorder')).toBeNull();
  });

  it('drops the keyboard on the way out of the naming step', async () => {
    // The naming field focuses itself, so closing from that step used to leave
    // the modal to tear down with the keyboard still up — and the Collection
    // list underneath reacts to keyboard frames it has no business reacting to.
    // Every exit has to resign first.
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    const props = renderSheet();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
    expect(screen.getByTestId('collection-picker-sheet-name-input')).toBeTruthy();
    dismiss.mockClear();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-backdrop'));

    expect(dismiss).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it('reports its dismissal exactly once, and only after it has closed', async () => {
    // The host opens the delete confirm off this signal: a second modal cannot
    // present while this one is still up, so firing early is the bug it exists
    // to prevent.
    const props = renderSheet();
    expect(props.onDismissed).not.toHaveBeenCalled();

    await act(async () => {
      props.rerender({ visible: false });
    });

    await waitFor(() => {
      expect(props.onDismissed).toHaveBeenCalledTimes(1);
    });
  });

  it('mutes a hidden collection and offers to count it again', () => {
    renderSheet({ collections: [MAIN, { ...GRAILS, hidden: true }] });

    // Hidden means "don't count this", not "hide it away" — the row is still
    // listed and still selectable so it can be un-hidden.
    expect(screen.getByText('Gengar Only')).toBeTruthy();
    expect(
      screen.getByLabelText('Count Gengar Only toward your total'),
    ).toBeTruthy();
  });
});
