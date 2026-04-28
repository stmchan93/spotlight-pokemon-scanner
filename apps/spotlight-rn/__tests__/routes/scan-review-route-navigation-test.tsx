import { fireEvent, screen } from '@testing-library/react-native';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
  }),
}));

import ScanReviewRoute from '@/app/(modal)/cards/[cardId]/scan-review';
import {
  clearScanCandidateReviewSessions,
  saveScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';

import { renderWithProviders } from '../test-utils';

describe('scan review modal route navigation', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockPush.mockReset();
    mockUseLocalSearchParams.mockReset();
    clearScanCandidateReviewSessions();
  });

  it('dismisses back to card detail and pushes a real card route when a candidate is chosen', async () => {
    const scanReviewId = saveScanCandidateReviewSession({
      id: 'scan-review-oshawott',
      selectedCardId: 'mcdonalds25-21',
      normalizedImageDimensions: { height: 880, width: 630 },
      normalizedImageUri: 'file:///tmp/normalized-scan.jpg',
      sourceImageCrop: {
        height: 1000,
        width: 660,
        x: 210,
        y: 460,
      },
      sourceImageDimensions: { height: 1080, width: 1920 },
      sourceImageRotationDegrees: 0,
      sourceImageUri: 'file:///tmp/source-scan.jpg',
      candidates: [
        {
          id: 'mcdonalds25-21-candidate',
          cardId: 'mcdonalds25-21',
          name: 'Oshawott',
          cardNumber: '#21/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          marketPrice: 0.56,
          currencyCode: 'USD',
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `similar-${index}`,
          cardId: `similar-${index}`,
          name: `Similar Card ${index + 1}`,
          cardNumber: `#${index + 1}/99`,
          setName: 'Candidate Set',
          imageUrl: `https://cdn.spotlight.test/similar-${index}.png`,
          marketPrice: index + 1,
          currencyCode: 'USD',
        })),
      ],
    });

    mockUseLocalSearchParams.mockReturnValue({
      cardId: 'mcdonalds25-21',
      scanReviewId,
    });

    renderWithProviders(<ScanReviewRoute />);

    expect(await screen.findByText('10 cards found')).toBeTruthy();
    expect(screen.getByTestId('detail-scan-source-image').props.source).toEqual({
      uri: 'file:///tmp/normalized-scan.jpg',
    });

    fireEvent.press(screen.getByTestId('detail-scan-candidate-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);

    mockBack.mockClear();
    fireEvent.press(screen.getByTestId('detail-scan-candidate-0'));

    expect(mockBack).toHaveBeenCalledTimes(0);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]',
      params: {
        cardId: 'similar-0',
        scanReviewId,
      },
    });
  });
});
