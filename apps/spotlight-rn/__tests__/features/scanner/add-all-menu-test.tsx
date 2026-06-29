import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { AddAllMenu } from '@/features/scanner/components/add-all-menu';

function Wrapper({ children }: PropsWithChildren) {
  return <SpotlightThemeProvider>{children}</SpotlightThemeProvider>;
}

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
    expect(screen.getByText('Wishlist')).toBeTruthy();
    expect(screen.getByText('Remove')).toBeTruthy();
  });

  it('fires onSelect with the matching action for each row', () => {
    const props = renderMenu();

    fireEvent.press(screen.getByTestId('add-all-menu-collection'));
    expect(props.onSelect).toHaveBeenCalledWith('collection');

    fireEvent.press(screen.getByTestId('add-all-menu-wishlist'));
    expect(props.onSelect).toHaveBeenCalledWith('wishlist');

    fireEvent.press(screen.getByTestId('add-all-menu-remove'));
    expect(props.onSelect).toHaveBeenCalledWith('remove');
  });

  it('fires onClose when the backdrop is pressed', () => {
    const props = renderMenu();

    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
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
