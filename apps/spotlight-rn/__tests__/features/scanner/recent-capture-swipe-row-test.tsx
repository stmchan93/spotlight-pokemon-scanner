import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { RecentCaptureSwipeRow } from '@/features/scanner/screens/recent-capture-swipe-row';

describe('RecentCaptureSwipeRow', () => {
  it('closes the rail when its recycled cell starts showing another scan', () => {
    const onRailChange = jest.fn();
    const props = {
      onActionRailVisibilityChange: onRailChange,
      onAddToCollection: jest.fn(),
      onDelete: jest.fn(),
      testID: 'row',
    };
    const { rerender } = render(
      <RecentCaptureSwipeRow {...props} actionRailKey="scan-a"><Text>A</Text></RecentCaptureSwipeRow>,
    );
    fireEvent.press(screen.getByTestId('row-reveal-actions', { includeHiddenElements: true }));
    expect(screen.getByTestId('row-delete-button', { includeHiddenElements: true }).props.accessibilityState)
      .toMatchObject({ disabled: false });
    expect(onRailChange).toHaveBeenLastCalledWith('scan-a', true);

    rerender(<RecentCaptureSwipeRow {...props} actionRailKey="scan-b"><Text>B</Text></RecentCaptureSwipeRow>);

    expect(onRailChange).toHaveBeenCalledWith('scan-a', false);
    expect(onRailChange).not.toHaveBeenCalledWith('scan-b', true);
    expect(screen.getByTestId('row-delete-button', { includeHiddenElements: true }).props.accessibilityState)
      .toMatchObject({ disabled: true });
  });
});
