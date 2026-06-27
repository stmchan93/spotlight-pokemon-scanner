import { fireEvent, render, screen } from '@testing-library/react-native';

import { SheetDismissHandle } from '@/components/sheet-dismiss-handle';

describe('SheetDismissHandle', () => {
  // The downward-swipe path is wired through PanResponder gesture state, which
  // fireEvent can't faithfully drive; the tap contract below is the deterministic
  // guarantee. Swipe-to-dismiss is verified manually / in the design catalog.
  it('dismisses on a tap', () => {
    const onDismiss = jest.fn();
    render(<SheetDismissHandle onDismiss={onDismiss} testID="handle" />);

    fireEvent.press(screen.getByTestId('handle'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
