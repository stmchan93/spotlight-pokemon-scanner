import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Modal } from 'react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { AddAllMenu } from '@/features/scanner/components/add-all-menu';

function Wrapper({ children }: PropsWithChildren) {
  return <SpotlightThemeProvider>{children}</SpotlightThemeProvider>;
}

// The exit animation's completion hops back to JS on a microtask (worklets mock).
const flushExit = () => act(async () => {});

function renderMenu(overrides?: Partial<Parameters<typeof AddAllMenu>[0]>) {
  const props = {
    visible: true,
    anchor: { x: 16, y: 80, width: 96, height: 32 },
    onSelect: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  render(<AddAllMenu {...props} />, { wrapper: Wrapper });
  return props;
}

describe('AddAllMenu', () => {
  it('renders the three option rows when visible', () => {
    renderMenu();

    expect(screen.getByTestId('add-all-menu-collection')).toBeTruthy();
    expect(screen.getByTestId('add-all-menu-wishlist')).toBeTruthy();
    expect(screen.getByTestId('add-all-menu-remove')).toBeTruthy();
    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.getByText('Watchlist')).toBeTruthy();
    // Bulk row is CLEAR (swipe-to-Delete is the single-row action); it opens
    // the same "Clear all scans?" confirm the tray header does.
    expect(screen.getByText('Clear')).toBeTruthy();
  });

  it.each(['collection', 'wishlist', 'remove'] as const)(
    'fires onSelect(%s) once after the exit animation',
    async (action) => {
      const props = renderMenu();

      fireEvent.press(screen.getByTestId(`add-all-menu-${action}`));
      expect(props.onSelect).not.toHaveBeenCalled();
      await flushExit();
      expect(props.onSelect).toHaveBeenCalledTimes(1);
      expect(props.onSelect).toHaveBeenCalledWith(action);
      expect(props.onClose).not.toHaveBeenCalled();
    },
  );

  it('ignores further taps while the menu is animating out', async () => {
    const props = renderMenu();

    fireEvent.press(screen.getByTestId('add-all-menu-collection'));
    fireEvent.press(screen.getByTestId('add-all-menu-wishlist'));
    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
    await flushExit();

    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith('collection');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('closes once on Android back (onRequestClose)', async () => {
    const props = renderMenu();

    const modal = screen.UNSAFE_getByType(Modal);
    fireEvent(modal, 'requestClose');
    fireEvent(modal, 'requestClose');
    await flushExit();

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose exactly once when the backdrop is pressed', async () => {
    const props = renderMenu();

    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
    await flushExit();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not visible', () => {
    renderMenu({ visible: false });

    expect(screen.queryByTestId('add-all-menu')).toBeNull();
    expect(screen.queryByTestId('add-all-menu-collection')).toBeNull();
  });

  it('falls back to a top-left position when there is no anchor', () => {
    renderMenu({ anchor: null });

    // Still renders the rows with a null anchor (no crash on missing measure).
    expect(screen.getByTestId('add-all-menu-collection')).toBeTruthy();
  });
});
