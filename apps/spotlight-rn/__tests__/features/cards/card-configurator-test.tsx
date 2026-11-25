import { screen, within } from '@testing-library/react-native';

import { CardConfigurator } from '@/features/cards/components/card-configurator';

import { renderWithProviders } from '../../test-utils';

describe('CardConfigurator variant chips', () => {
  it('keeps a long printing name on one line (Android hid the second line)', () => {
    renderWithProviders(
      <CardConfigurator
        graders={['Raw']}
        languages={[]}
        onSelectGrader={jest.fn()}
        onSelectLanguage={jest.fn()}
        onSelectVariant={jest.fn()}
        selectedGrader="Raw"
        selectedLanguage="EN"
        selectedVariant="third"
        testID="configurator"
        variants={[
          { id: 'foil', label: 'Foil' },
          { id: 'third', label: 'Third Anniversary' },
        ] as never}
      />,
    );

    const label = within(screen.getByTestId('configurator-variant-third')).getByText('THIRD ANNIVERSARY');
    expect(label.props.numberOfLines).toBe(1);
  });

  it('hides the Grader row when given no graders (the PDP outside owned edit)', () => {
    renderWithProviders(
      <CardConfigurator
        graders={[]}
        languages={[]}
        onSelectGrader={jest.fn()}
        onSelectLanguage={jest.fn()}
        onSelectVariant={jest.fn()}
        selectedGrader="Raw"
        selectedLanguage="EN"
        selectedVariant={null}
        testID="configurator"
        variants={[]}
      />,
    );

    expect(screen.queryByText('GRADER')).toBeNull();
    expect(screen.queryByTestId('configurator-grader-Raw')).toBeNull();
  });
});
