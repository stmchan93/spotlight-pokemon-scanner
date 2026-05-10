import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SearchField } from '@spotlight/design-system';

import { renderWithProviders } from '../test-utils';

describe('SearchField', () => {
  it('renders the default variant with the existing 48px-min container', () => {
    renderWithProviders(
      <SearchField
        containerTestID="search-default"
        onChangeText={jest.fn()}
        placeholder="Search"
        value=""
      />,
    );

    const flattened = StyleSheet.flatten(screen.getByTestId('search-default').props.style);
    expect(flattened).toMatchObject({
      borderRadius: 16,
      borderWidth: 1,
      minHeight: 48,
      paddingHorizontal: 16,
    });
    expect(flattened.height).toBeUndefined();
  });

  it('renders the compact variant with the 32px height pill spec', () => {
    renderWithProviders(
      <SearchField
        containerTestID="search-compact"
        onChangeText={jest.fn()}
        placeholder="Search"
        size="compact"
        value=""
      />,
    );

    const flattened = StyleSheet.flatten(screen.getByTestId('search-compact').props.style);
    expect(flattened).toMatchObject({
      borderRadius: 999,
      borderWidth: 1,
      height: 32,
      paddingHorizontal: 8,
      paddingVertical: 7,
    });
    expect(flattened.minHeight).toBeUndefined();
  });
});
