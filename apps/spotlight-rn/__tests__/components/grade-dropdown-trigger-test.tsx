import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { GradeDropdownTrigger } from '@/features/cards/components/grade-dropdown-trigger';
import { OwnedEntryEditFields } from '@/features/cards/components/owned-entry-edit-fields';

import { renderWithProviders } from '../test-utils';

const LONG_LABELS = ['Moderately Played', 'Heavily Played', 'Near Mint', 'Damaged'];

function resolvedStyle(testID: string) {
  const node = screen.getByTestId(testID);
  const style = typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style;
  return StyleSheet.flatten(style) ?? {};
}

describe('GradeDropdownTrigger', () => {
  it.each(LONG_LABELS)('renders the full "%s" label in a content-sized chip', (label) => {
    renderWithProviders(
      <GradeDropdownTrigger color="#000" label={label} onPress={jest.fn()} testID="trigger" title="Condition" />,
    );

    expect(screen.getByText(label.toUpperCase())).toBeTruthy();

    const chip = resolvedStyle('trigger');
    expect(chip.width).toBeUndefined();
    expect(chip.height).toBeUndefined();
    expect(chip.maxWidth).toBe('100%');
    expect(chip.alignItems).toBe('center');
    expect(chip.borderCurve).toBe('continuous');

    // Only an over-wide label (320pt phones) may truncate, and then with an ellipsis.
    const text = screen.getByTestId('trigger-label');
    if (text.props.numberOfLines === 1) {
      expect(text.props.ellipsizeMode).toBe('tail');
    }
  });

  it('is the chip the PDP owned-copy edit fields render', () => {
    renderWithProviders(
      <OwnedEntryEditFields
        costBasisText=""
        gainLabel={null}
        gainPerUnit={null}
        gradeLabel="Moderately Played"
        gradeTitle="Condition"
        onChangeCostBasisText={jest.fn()}
        onDecrement={jest.fn()}
        onIncrement={jest.fn()}
        onOpenGradePicker={jest.fn()}
        quantity={1}
        testID="owned"
      />,
    );

    expect(screen.getByTestId('owned-grade-trigger-label').props.children).toBe('MODERATELY PLAYED');
    expect(resolvedStyle('owned-grade-trigger').width).toBeUndefined();
  });
});
