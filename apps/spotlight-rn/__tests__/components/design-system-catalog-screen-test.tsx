import { fireEvent, screen } from '@testing-library/react-native';

import { DesignSystemCatalogScreen } from '@/features/design-system/screens/design-system-catalog-screen';

import { renderWithProviders } from '../test-utils';

describe('DesignSystemCatalogScreen', () => {
  it('renders the shared token and primitive catalog for Claude-facing design review', () => {
    const onBack = jest.fn();

    renderWithProviders(<DesignSystemCatalogScreen onBack={onBack} />);

    expect(screen.getAllByText('Design System').length).toBeGreaterThan(0);
    expect(screen.getByText('Typography')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('Primitives')).toBeTruthy();
    expect(screen.getByText('Colors')).toBeTruthy();
    expect(screen.getByText('Spacing')).toBeTruthy();
    expect(screen.getByText('Font Families')).toBeTruthy();
    expect(screen.getByTestId('catalog-button-primary')).toBeTruthy();
    expect(screen.getByTestId('catalog-button-secondary')).toBeTruthy();
    expect(screen.getByTestId('catalog-button-ghost')).toBeTruthy();
    expect(screen.getByTestId('catalog-button-accessory')).toBeTruthy();
    expect(screen.getByTestId('catalog-icon-button')).toBeTruthy();
    expect(screen.getByTestId('catalog-pill-button')).toBeTruthy();
    expect(screen.getByTestId('catalog-search-field')).toBeTruthy();
    expect(screen.getByTestId('catalog-text-field')).toBeTruthy();
    expect(screen.getByTestId('catalog-segmented-control-inverted')).toBeTruthy();
    expect(screen.getByTestId('catalog-state-card-action')).toBeTruthy();

    fireEvent.press(screen.getByTestId('design-system-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
