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

const back = jest.fn();
const push = jest.fn();

describe('NewPostScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, push });
    (createPost as jest.Mock).mockResolvedValue('post-1');
  });

  it('disables Post until there is a body', () => {
    renderWithProviders(<NewPostScreen />);

    expect(screen.getByTestId('new-post-submit')).toBeDisabled();

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), 'gm collectors');
    expect(screen.getByTestId('new-post-submit')).toBeEnabled();
  });

  it('does NOT autoFocus the body — the keyboard is raised after the sheet settles', () => {
    renderWithProviders(<NewPostScreen />);

    // Regression: `autoFocus` raised the keyboard DURING the form sheet's
    // presentation animation, so it appeared, the sheet re-laid-out, and it
    // appeared again — the "keyboard comes up twice and lags" report. Focus is
    // now driven by a timer against the ref (BODY_FOCUS_DELAY_MS) instead.
    expect(screen.getByTestId('new-post-body-input').props.autoFocus).toBeFalsy();
  });

  it('creates a text post and navigates back', async () => {
    renderWithProviders(<NewPostScreen />);

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), '  Pulled a holo!  ');
    fireEvent.press(screen.getByTestId('new-post-submit'));

    await waitFor(() => expect(createPost).toHaveBeenCalled());
    // Card attach is no longer a composer affordance — cardId is always null here.
    expect(createPost).toHaveBeenCalledWith({ body: 'Pulled a holo!', cardId: null });
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });

  it('does nothing when Post is pressed with an empty composer', () => {
    renderWithProviders(<NewPostScreen />);

    fireEvent.press(screen.getByTestId('new-post-submit'));
    expect(createPost).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('shows a note that posts are public (no privacy value is persisted)', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderWithProviders(<NewPostScreen />);

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), 'hello');
    fireEvent.press(screen.getByTestId('new-post-privacy'));

    // The Public chip is a static indicator — it explains visibility but never
    // feeds a value into createPost.
    expect(alertSpy).toHaveBeenCalledWith('Public post', expect.any(String));

    fireEvent.press(screen.getByTestId('new-post-submit'));
    expect(createPost).toHaveBeenCalledWith({ body: 'hello', cardId: null });

    alertSpy.mockRestore();
  });

  it('captures a photo from the camera and attaches it to the post', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker');
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///captured.jpg' }],
    });

    const uploadPostMedia = jest.fn().mockResolvedValue({ mediaId: 'media-1' });
    const repository = { ...createTestSpotlightRepository(), uploadPostMedia };

    renderWithProviders(<NewPostScreen />, { spotlightRepository: repository });

    fireEvent.changeText(screen.getByTestId('new-post-body-input'), 'Live from the show');
    fireEvent.press(screen.getByTestId('new-post-add-camera'));

    // The camera permission was requested and the captured image lands in the preview.
    await waitFor(() => expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalled());
    await screen.findByTestId('new-post-image-preview');

    fireEvent.press(screen.getByTestId('new-post-submit'));

    await waitFor(() => expect(createPost).toHaveBeenCalledWith({ body: 'Live from the show', cardId: null }));
    await waitFor(() => expect(uploadPostMedia).toHaveBeenCalledWith('post-1', expect.any(ArrayBuffer)));
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));

    global.fetch = originalFetch;
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
