import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { LabelingSessionScreen } from '@/features/labeling/screens/labeling-session-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const mockBack = jest.fn();
const mockCanGoBack = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    canGoBack: mockCanGoBack,
    replace: mockReplace,
  }),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'UI Test User',
      email: 'ui-tests@spotlight.local',
      id: '00000000-0000-0000-0000-000000000001',
      labelerEnabled: true,
      providers: ['ui-tests'],
    },
  }),
}));

const searchResult = {
  id: 'mcdonalds25-21',
  cardId: 'mcdonalds25-21',
  name: 'Oshawott',
  cardNumber: '#21/25',
  setName: "McDonald's Collection 2021",
  imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
  marketPrice: 0.56,
  currencyCode: 'USD',
};

async function searchAndConfirmCard() {
  fireEvent.changeText(screen.getByTestId('labeler-search-input'), 'oshawott');

  await waitFor(() => {
    expect(screen.getByTestId('labeler-result-mcdonalds25-21')).toBeTruthy();
  });

  fireEvent.press(screen.getByTestId('labeler-result-mcdonalds25-21'));
  expect(screen.getByText('Confirm Card')).toBeTruthy();

  fireEvent.press(screen.getByTestId('labeler-confirm-card-button'));

  await waitFor(() => {
    expect(screen.getByText('Capture Front')).toBeTruthy();
  });
}

async function captureCurrentAngle(nextTitle: string | null) {
  await waitFor(() => {
    expect(screen.getByTestId('labeler-capture-button').props.disabled).not.toBe(true);
  });

  fireEvent.press(screen.getByTestId('labeler-capture-button'));

  if (nextTitle) {
    await waitFor(() => {
      expect(screen.getByText(nextTitle)).toBeTruthy();
    });
  }
}

describe('LabelingSessionScreen', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockCanGoBack.mockReset();
    mockReplace.mockReset();
    mockCanGoBack.mockReturnValue(true);
  });

  it('selects one card, captures four angles, uploads them, and completes the session', async () => {
    const createLabelingSession = jest.fn().mockResolvedValue({
      sessionID: 'session-1',
      cardID: 'mcdonalds25-21',
      status: 'capturing',
      createdAt: '2026-04-29T12:00:00.000Z',
    });
    const uploadLabelingSessionArtifact = jest.fn().mockResolvedValue({
      artifactID: 'artifact-1',
      sessionID: 'session-1',
      angleIndex: 0,
      angleLabel: 'front',
    });
    const completeLabelingSession = jest.fn().mockResolvedValue({
      sessionID: 'session-1',
      cardID: 'mcdonalds25-21',
      status: 'completed',
      createdAt: '2026-04-29T12:00:00.000Z',
      completedAt: '2026-04-29T12:01:00.000Z',
    });
    const abortLabelingSession = jest.fn().mockResolvedValue({
      sessionID: 'session-1',
      cardID: 'mcdonalds25-21',
      status: 'aborted',
      createdAt: '2026-04-29T12:00:00.000Z',
      abortedAt: '2026-04-29T12:01:00.000Z',
    });
    const spotlightRepository = createTestSpotlightRepository({
      abortLabelingSession,
      completeLabelingSession,
      createLabelingSession,
      searchCatalogCards: jest.fn().mockResolvedValue([searchResult]),
      uploadLabelingSessionArtifact,
    });

    renderWithProviders(<LabelingSessionScreen />, { spotlightRepository });

    await searchAndConfirmCard();
    const previewStyle = StyleSheet.flatten(screen.getByTestId('labeler-preview').props.style);
    const reticleStyle = StyleSheet.flatten(screen.getByTestId('labeler-reticle').props.style);
    expect(previewStyle).toMatchObject({
      height: reticleStyle.height,
      left: reticleStyle.left,
      position: 'absolute',
      top: reticleStyle.top,
      width: reticleStyle.width,
    });
    expect(screen.getByTestId('labeler-camera')).toBeTruthy();
    expect(screen.getByTestId('labeler-prompt')).toBeTruthy();

    await captureCurrentAngle('Capture Tilt left');
    await captureCurrentAngle('Capture Tilt right');
    await captureCurrentAngle('Capture Tilt forward');
    await captureCurrentAngle(null);

    await waitFor(() => {
      expect(screen.getByText('Review Angles')).toBeTruthy();
    });

    expect(screen.getByTestId('labeler-angle-front')).toBeTruthy();
    expect(screen.getByTestId('labeler-angle-tilt_left')).toBeTruthy();
    expect(screen.getByTestId('labeler-angle-tilt_right')).toBeTruthy();
    expect(screen.getByTestId('labeler-angle-tilt_forward')).toBeTruthy();
    expect(screen.getByTestId('labeler-retake-front')).toBeTruthy();

    fireEvent.press(screen.getByTestId('labeler-done-button'));

    await waitFor(() => {
      expect(screen.getByTestId('labeler-done-state')).toBeTruthy();
    });

    expect(createLabelingSession).toHaveBeenCalledWith({
      cardID: 'mcdonalds25-21',
      cardName: 'Oshawott',
      cardNumber: '#21/25',
      createdAt: expect.any(String),
      setName: "McDonald's Collection 2021",
    });
    expect(uploadLabelingSessionArtifact).toHaveBeenCalledTimes(4);
    expect(uploadLabelingSessionArtifact.mock.calls.map(([payload]) => payload.angleLabel)).toEqual([
      'front',
      'tilt_left',
      'tilt_right',
      'tilt_forward',
    ]);
    expect(uploadLabelingSessionArtifact.mock.calls[0][0]).toMatchObject({
      sessionID: 'session-1',
      sourceImage: {
        jpegBase64: 'bW9jay1zY2FuLWJhc2U2NA==',
      },
      normalizedImage: {
        height: 880,
        jpegBase64: 'bm9ybWFsaXplZC1zY2FuLWJhc2U2NA==',
        width: 630,
      },
    });
    expect(completeLabelingSession).toHaveBeenCalledWith('session-1', {
      completedAt: expect.any(String),
    });
    expect(abortLabelingSession).not.toHaveBeenCalled();
  });

  it('lets a captured angle be retaken before done', async () => {
    const spotlightRepository = createTestSpotlightRepository({
      searchCatalogCards: jest.fn().mockResolvedValue([searchResult]),
    });

    renderWithProviders(<LabelingSessionScreen />, { spotlightRepository });

    await searchAndConfirmCard();
    await captureCurrentAngle('Capture Tilt left');
    await captureCurrentAngle('Capture Tilt right');
    await captureCurrentAngle('Capture Tilt forward');
    await captureCurrentAngle(null);

    await waitFor(() => {
      expect(screen.getByText('Review Angles')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('labeler-retake-tilt_left'));

    await waitFor(() => {
      expect(screen.getByText('Capture Tilt left')).toBeTruthy();
    });
  });
});
