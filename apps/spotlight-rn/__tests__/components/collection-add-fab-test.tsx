import { fireEvent, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

describe('CollectionAddFab', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push });
  });

  it('renders at the bottom-right of the screen with default testID', () => {
    renderWithProviders(<CollectionAddFab />);

    const fab = screen.getByTestId('collection-add-fab');
    expect(fab).toBeTruthy();

    const flattened = StyleSheet.flatten(
      typeof fab.props.style === 'function'
        ? fab.props.style({ pressed: false })
        : fab.props.style,
    );
    expect(flattened.position).toBe('absolute');
    expect(flattened.right).toBe(16);
    // bottom is computed off insets + theme layout, just assert it's a number.
    expect(typeof flattened.bottom).toBe('number');
  });

  it("navigates to /catalog/search on press by default", () => {
    renderWithProviders(<CollectionAddFab />);

    fireEvent.press(screen.getByTestId('collection-add-fab'));
    expect(push).toHaveBeenCalledWith('/catalog/search');
  });

  it('calls the custom onPress prop when provided (does not navigate)', () => {
    const onPress = jest.fn();
    renderWithProviders(<CollectionAddFab onPress={onPress} />);

    fireEvent.press(screen.getByTestId('collection-add-fab'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
