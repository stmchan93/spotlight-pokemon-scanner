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
    onOpenScanCandidateReview,
  }: {
    cardId: string;
    onBack: () => void;
    onOpenScanCandidateReview?: (scanReviewId: string) => void;
  }) => {
    const { Pressable, Text } = require('react-native');

    return (
      <>
        <Text>{cardId}</Text>
        <Pressable onPress={onBack} testID="card-detail-route-back" />
        <Pressable
          onPress={() => onOpenScanCandidateReview?.('scan-review-oshawott')}
          testID="card-detail-open-scan-review"
        />
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

  it('opens scan review as a real modal route', () => {
    mockUseLocalSearchParams.mockReturnValue({
      cardId: 'mcdonalds25-21',
      scanReviewId: 'scan-review-oshawott',
    });

    render(<CardDetailRoute />);

    fireEvent.press(screen.getByTestId('card-detail-open-scan-review'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]/scan-review',
      params: {
        cardId: 'mcdonalds25-21',
        scanReviewId: 'scan-review-oshawott',
      },
    });
  });

});
