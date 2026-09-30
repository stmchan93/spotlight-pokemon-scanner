import { screen } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { SectionHeader, colors, textStyles } from '@spotlight/design-system';

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

  it('compact size uses Title-small, a captionMedium count on the title baseline, and a centred accessory', () => {
    renderWithProviders(
      <SectionHeader
        countText="5 listings caught"
        size="compact"
        testID="deals-header"
        title="Deals"
        titleAccessory={<View testID="deals-dot" />}
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('deals-header-title').props.style)).toMatchObject({
      fontSize: 17,
    });
    expect(StyleSheet.flatten(screen.getByTestId('deals-header-count').props.style)).toMatchObject({
      color: colors.gray600,
      fontFamily: textStyles.captionMedium.fontFamily,
      fontSize: textStyles.captionMedium.fontSize,
    });
    expect(StyleSheet.flatten(screen.getByTestId('deals-header-title').props.style)).toMatchObject({
      fontFamily: textStyles.titleSmall.fontFamily,
    });
    expect(StyleSheet.flatten(screen.getByTestId('deals-header-title-row').props.style)).toMatchObject({
      alignItems: 'baseline',
    });
    // Non-text accessory has no baseline, so its slot centres it.
    let slot = screen.getByTestId('deals-dot').parent;
    while (slot && !slot.props.style) {
      slot = slot.parent;
    }
    expect(StyleSheet.flatten(slot?.props.style)).toMatchObject({ alignSelf: 'center' });
  });

  it('omits the accessory slot when there is no accessory', () => {
    renderWithProviders(<SectionHeader countText="1" size="compact" testID="deals-header" title="Deals" titleAccessory={null} />);

    // Title and count only — no empty centred slot between them.
    expect(screen.getByTestId('deals-header-title-row').children).toHaveLength(2);
  });

  it('default size keeps the display title and a centred row', () => {
    renderWithProviders(<SectionHeader countText="3" testID="inv" title="Inventory" />);

    expect(StyleSheet.flatten(screen.getByTestId('inv-title').props.style)).toMatchObject({ fontSize: 25 });
    expect(StyleSheet.flatten(screen.getByTestId('inv-title-row').props.style)).toMatchObject({
      alignItems: 'center',
    });
  });
});
