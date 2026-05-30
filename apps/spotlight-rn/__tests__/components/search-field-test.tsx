import { fireEvent, screen } from '@testing-library/react-native';
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

  it('renders the compact variant with the 44px height pill spec', () => {
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
      height: 44,
      paddingHorizontal: 8,
      paddingVertical: 7,
    });
    expect(flattened.minHeight).toBeUndefined();
  });

  describe("surface='muted'", () => {
    it('renders without a border (borderWidth: 0)', () => {
      renderWithProviders(
        <SearchField
          containerTestID="search-muted"
          onChangeText={jest.fn()}
          placeholder="Search"
          surface="muted"
          value=""
        />,
      );

      const flattened = StyleSheet.flatten(screen.getByTestId('search-muted').props.style);
      expect(flattened.borderWidth).toBe(0);
    });

    it('renders the placeholder text and fires onChangeText', () => {
      const onChangeText = jest.fn();
      renderWithProviders(
        <SearchField
          containerTestID="search-muted"
          onChangeText={onChangeText}
          placeholder="Search your collection"
          surface="muted"
          value=""
        />,
      );

      const input = screen.getByPlaceholderText('Search your collection');
      expect(input).toBeTruthy();

      fireEvent.changeText(input, 'charizard');
      expect(onChangeText).toHaveBeenCalledWith('charizard');
    });

    it("renders the input at size='collection'", () => {
      renderWithProviders(
        <SearchField
          containerTestID="search-collection"
          onChangeText={jest.fn()}
          placeholder="Search"
          size="collection"
          surface="muted"
          value=""
        />,
      );

      const flattened = StyleSheet.flatten(screen.getByTestId('search-collection').props.style);
      // collection size enforces a 40px height.
      expect(flattened.height).toBe(40);
      expect(screen.getByPlaceholderText('Search')).toBeTruthy();
    });
  });
});
