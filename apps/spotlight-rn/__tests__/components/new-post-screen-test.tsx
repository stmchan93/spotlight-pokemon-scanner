import { Alert } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { createPost } from '@/features/social/social-service';
import { NewPostScreen } from '@/features/social/screens/new-post-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  // NewPostScreen doesn't use useFocusEffect, but keep it defined so any
  // transitive import resolves.
  useFocusEffect: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
  createPost: jest.fn(),
}));

// Reuse-not-rebuild: the real catalog search is a heavy screen with its own data
// deps, so stub it to a single button that fires `onOpenCard` with a fixed card.
// The composer's own card-attach behavior (chip + cardId wiring) is what we test.
jest.mock('@/features/catalog/screens/catalog-search-screen', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    CatalogSearchScreen: ({
      onOpenCard,
    }: {
      onOpenCard: (result: { cardId: string; name: string; imageUrl: string; smallImageUrl: string | null }) => void;
    }) =>
      React.createElement(
        Pressable,
        {
          testID: 'stub-pick-card',
          onPress: () =>
            onOpenCard({
              cardId: 'card-123',
              name: 'Charizard',
              imageUrl: 'https://img.example/charizard.png',
              smallImageUrl: null,
            }),
        },
        React.createElement(Text, null, 'Pick Charizard'),
      ),
  };
});

const back = jest.fn();
const push = jest.fn();

describe('NewPostScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, push });
    (createPost as jest.Mock).mockResolvedValue('post-1');
  });

  it('disables Post until there is a body or a card', () => {
    renderWithProviders(<NewPostScreen />);

    expect(screen.getByTestId('new-post-submit')).toBeDisabled();

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), 'gm collectors');
    expect(screen.getByTestId('new-post-submit')).toBeEnabled();
  });

  it('creates a text post and navigates back', async () => {
    renderWithProviders(<NewPostScreen />);

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), '  Pulled a holo!  ');
    fireEvent.press(screen.getByTestId('new-post-submit'));

    await waitFor(() => expect(createPost).toHaveBeenCalled());
    expect(createPost).toHaveBeenCalledWith({ body: 'Pulled a holo!', cardId: null });
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });

  it('does nothing when Post is pressed with an empty composer', () => {
    renderWithProviders(<NewPostScreen />);

    fireEvent.press(screen.getByTestId('new-post-submit'));
    expect(createPost).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('attaches a picked card and posts with its cardId', async () => {
    renderWithProviders(<NewPostScreen />);

    fireEvent.press(screen.getByTestId('new-post-add-card'));
    fireEvent.press(await screen.findByTestId('stub-pick-card'));

    // The chip renders the attached card and the "Add card" affordance is gone.
    await waitFor(() => expect(screen.getByTestId('new-post-card-chip')).toBeTruthy());
    expect(screen.getByText('Charizard')).toBeTruthy();

    fireEvent.press(screen.getByTestId('new-post-submit'));
    await waitFor(() => expect(createPost).toHaveBeenCalled());
    expect(createPost).toHaveBeenCalledWith({ body: null, cardId: 'card-123' });
  });

  it('still completes the text post when the image upload fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker');
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg' }],
    });

    const uploadPostMedia = jest.fn().mockRejectedValue(new Error('media 500'));
    // The base test repository plus the not-yet-in-interface post-media uploader.
    const repository = { ...createTestSpotlightRepository(), uploadPostMedia };

    renderWithProviders(<NewPostScreen />, { spotlightRepository: repository });

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), 'Look at this pull');
    fireEvent.press(screen.getByTestId('new-post-add-image'));

    // Wait for the resized image to land in the preview.
    await screen.findByTestId('new-post-image-preview');

    fireEvent.press(screen.getByTestId('new-post-submit'));

    // The text post is created regardless of the image outcome...
    await waitFor(() => expect(createPost).toHaveBeenCalledWith({ body: 'Look at this pull', cardId: null }));
    // ...the upload was attempted and failed...
    await waitFor(() => expect(uploadPostMedia).toHaveBeenCalledWith('post-1', expect.any(ArrayBuffer)));
    // ...the failure is surfaced softly, and the composer still dismisses.
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Photo not attached', expect.any(String)),
    );
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));

    alertSpy.mockRestore();
    global.fetch = originalFetch;
  });
});
