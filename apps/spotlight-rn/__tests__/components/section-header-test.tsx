import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SectionHeader } from '@spotlight/design-system';

import { renderWithProviders } from '../test-utils';

describe('SectionHeader', () => {
  it('keeps the chevron slot dimensions fixed across expanded states', () => {
    const { rerender } = renderWithProviders(
      <SectionHeader
        expanded={false}
        onPress={jest.fn()}
        testID="portfolio-header"
        title="Inventory"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('portfolio-header-chevron-slot').props.style)).toMatchObject({
      height: 16,
      width: 16,
    });
    expect(StyleSheet.flatten(screen.getByTestId('portfolio-header-chevron-glyph').props.style)).toMatchObject({
      height: 14,
      width: 14,
    });

    rerender(
      <SectionHeader
        expanded
        onPress={jest.fn()}
        testID="portfolio-header"
        title="Inventory"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('portfolio-header-chevron-slot').props.style)).toMatchObject({
      height: 16,
      width: 16,
    });
    expect(StyleSheet.flatten(screen.getByTestId('portfolio-header-chevron-glyph').props.style)).toMatchObject({
      height: 14,
      width: 14,
    });
  });
});
