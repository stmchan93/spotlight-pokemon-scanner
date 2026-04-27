import { fireEvent, render, screen } from '@testing-library/react-native';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('expo-router', () => ({
  Stack: {
    Screen: () => null,
  },
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
  }),
}));

jest.mock('@/features/sell/screens/single-sell-screen', () => ({
  SingleSellScreen: ({
    entryId,
    onClose,
    onComplete,
  }: {
    entryId: string;
    onClose: () => void;
    onComplete: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');

    return (
      <>
        <Text>{entryId}</Text>
        <Pressable onPress={onClose} testID="single-sell-close-route" />
        <Pressable onPress={onComplete} testID="single-sell-complete-route" />
      </>
    );
  },
}));

jest.mock('@/features/sell/screens/bulk-sell-screen', () => ({
  BulkSellScreen: ({
    entryIds,
    onClose,
    onComplete,
  }: {
    entryIds: string[];
    onClose: () => void;
    onComplete: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');

    return (
      <>
        <Text>{entryIds.join(',')}</Text>
        <Pressable onPress={onClose} testID="bulk-sell-close-route" />
        <Pressable onPress={onComplete} testID="bulk-sell-complete-route" />
      </>
    );
  },
}));

import BulkSellRoute from '@/app/(sheet)/sell/batch';
import SingleSellRoute from '@/app/(sheet)/sell/[entryId]';

describe('sell sheet route navigation', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockReplace.mockReset();
    mockUseLocalSearchParams.mockReset();
  });

  it('returns single sell completion to the portfolio page', () => {
    mockUseLocalSearchParams.mockReturnValue({ entryId: 'entry-2' });

    render(<SingleSellRoute />);

    fireEvent.press(screen.getByTestId('single-sell-complete-route'));

    expect(mockReplace).toHaveBeenCalledWith('/portfolio');
  });

  it('returns batch sell completion to the portfolio page', () => {
    mockUseLocalSearchParams.mockReturnValue({ entryIds: 'entry-1,entry-2' });

    render(<BulkSellRoute />);

    fireEvent.press(screen.getByTestId('bulk-sell-complete-route'));

    expect(mockReplace).toHaveBeenCalledWith('/portfolio');
  });
});
