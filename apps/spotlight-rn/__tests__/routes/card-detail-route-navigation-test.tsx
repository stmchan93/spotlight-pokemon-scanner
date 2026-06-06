import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
  }),
}));

jest.mock('@/features/cards/screens/card-detail-screen', () => ({
  CardDetailScreen: ({
    cardId,
    onBack,
  }: {
    cardId: string;
    onBack: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');

    return (
      <>
        <Text>{cardId}</Text>
        <Pressable onPress={onBack} testID="card-detail-route-back" />
      </>
    );
  },
}));

import CardDetailRoute from '@/app/(stack)/cards/[cardId]';

describe('card detail route navigation', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockPush.mockReset();
    mockUseLocalSearchParams.mockReset();
  });

  it('wires back navigation through the route wrapper', () => {
    mockUseLocalSearchParams.mockReturnValue({
      cardId: 'mcdonalds25-21',
    });

    render(<CardDetailRoute />);

    fireEvent.press(screen.getByTestId('card-detail-route-back'));

    expect(mockBack).toHaveBeenCalled();
  });

});
