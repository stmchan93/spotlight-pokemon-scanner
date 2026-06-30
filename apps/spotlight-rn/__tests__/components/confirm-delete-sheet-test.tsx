import { screen } from '@testing-library/react-native';

import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';

import { renderWithProviders } from '../test-utils';

describe('ConfirmDeleteSheet', () => {
  const baseProps = {
    visible: true,
    onClose: jest.fn(),
    onConfirm: jest.fn(),
  };

  it('says "1 item" for a single-copy entry (default)', () => {
    renderWithProviders(<ConfirmDeleteSheet {...baseProps} />);
    expect(screen.getByText(/about to delete 1 item/i)).toBeTruthy();
  });

  it('reflects the quantity for a multi-copy entry ("all N copies")', () => {
    renderWithProviders(<ConfirmDeleteSheet {...baseProps} quantity={2} />);
    // Regression: a qty-2 entry previously said "delete 1 item" even though the
    // delete removes the whole entry.
    expect(screen.getByText(/delete all 2 copies of this card/i)).toBeTruthy();
    expect(screen.queryByText(/delete 1 item/i)).toBeNull();
  });

  it('lets an explicit message override the quantity copy (e.g. bulk delete)', () => {
    renderWithProviders(
      <ConfirmDeleteSheet {...baseProps} quantity={5} message="Delete 3 selected items?" />,
    );
    expect(screen.getByText('Delete 3 selected items?')).toBeTruthy();
  });
});
