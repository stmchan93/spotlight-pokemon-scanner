import { Alert, Keyboard, Platform, StyleSheet } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { isHandleAvailable } from '@/features/auth/auth-service';
import { EditProfileScreen } from '@/features/profile/screens/edit-profile-screen';
import { useAuth } from '@/providers/auth-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// The shared jest.setup.ts iconoir mock only allowlists a subset of icon names;
// this screen also uses Camera / NavArrowRight, so extend the mock here.
jest.mock('iconoir-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const make = (name: string) => {
    const Component = (props: Record<string, unknown>) =>
      React.createElement(View, { ...props, testID: props.testID ?? `iconoir-${name}` });
    Component.displayName = `MockIconoir(${name})`;
    return Component;
  };
  return {
    Camera: make('camera'),
    Check: make('check'),
    NavArrowLeft: make('nav-arrow-left'),
    NavArrowRight: make('nav-arrow-right'),
  };
});

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

// Keep ProfileUpdateError real (the screen instanceof-checks it); stub only the
// network probe.
jest.mock('@/features/auth/auth-service', () => ({
  ...jest.requireActual('@/features/auth/auth-service'),
  isHandleAvailable: jest.fn().mockResolvedValue(true),
}));

describe('EditProfileScreen', () => {
  const back = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks wipes calls but keeps implementations, so re-arm the default.
    (isHandleAvailable as jest.Mock).mockResolvedValue(true);

    (useRouter as jest.Mock).mockReturnValue({ back, push: jest.fn() });
    (useAuth as jest.Mock).mockReturnValue({
      currentUser: {
        avatarURL: null,
        bio: 'Collector of holos',
        displayName: 'Ash',
        handle: 'ash',
        id: 'user-1',
        location: 'Pallet Town',
        socialLink: 'https://example.com',
      },
      updateProfile,
    });
  });

  it('renders the four field placeholders and the Save/Cancel actions', () => {
    renderWithProviders(<EditProfileScreen />);

    expect(screen.getByPlaceholderText('Enter Profile Name')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter Social Link')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter Location')).toBeTruthy();
    expect(screen.getByPlaceholderText('Tell us about you...')).toBeTruthy();

    expect(screen.getByTestId('edit-profile-save')).toBeTruthy();
    expect(screen.getByTestId('edit-profile-cancel')).toBeTruthy();
    expect(screen.getByText('SAVE')).toBeTruthy();
    expect(screen.getByText('CANCEL')).toBeTruthy();
  });

  it('prefills the form from the current user', () => {
    renderWithProviders(<EditProfileScreen />);

    expect(screen.getByDisplayValue('Ash')).toBeTruthy();
    expect(screen.getByDisplayValue('https://example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('Pallet Town')).toBeTruthy();
    expect(screen.getByDisplayValue('Collector of holos')).toBeTruthy();

    // A filled field also floats its label above the value (Figma 3083:9800).
    expect(screen.getByText('Profile Name')).toBeTruthy();
    expect(screen.getByText('Social Link')).toBeTruthy();
    expect(screen.getByText('Location')).toBeTruthy();
  });

  it('navigates back when Cancel is pressed', () => {
    renderWithProviders(<EditProfileScreen />);

    fireEvent.press(screen.getByTestId('edit-profile-cancel'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  // Saving used to normalise, so anything unopenable persisted as '' — type
  // `instagram`, press SAVE, field comes back blank.
  it('saves a non-link social value verbatim instead of clearing it', async () => {
    renderWithProviders(<EditProfileScreen />);

    fireEvent.changeText(screen.getByPlaceholderText('Enter Social Link'), 'instagram');
    fireEvent.press(screen.getByTestId('edit-profile-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile.mock.calls[0][0].socialLink).toBe('instagram');
  });

  it('still stores a real link, trimmed, exactly as typed', async () => {
    renderWithProviders(<EditProfileScreen />);

    fireEvent.changeText(screen.getByPlaceholderText('Enter Social Link'), '  instagram.com/ash  ');
    fireEvent.press(screen.getByTestId('edit-profile-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    // Trimmed and bounded, but NOT rewritten to `https://…` — the scheme is added
    // when the link is opened, not when it is stored.
    expect(updateProfile.mock.calls[0][0].socialLink).toBe('instagram.com/ash');
  });

  // The red caption under this field is gone for good: it re-validated on every
  // keystroke, so a half-typed URL was told off for not being finished.
  it('never shows an error while the link is being typed', () => {
    renderWithProviders(<EditProfileScreen />);

    const field = screen.getByPlaceholderText('Enter Social Link');
    for (const partial of ['i', 'inst', 'instagram', 'instagram.c']) {
      fireEvent.changeText(field, partial);
      expect(screen.queryByTestId('edit-profile-social-problem')).toBeNull();
    }
  });

  it('stays open and does not dismiss when the save fails', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    updateProfile.mockRejectedValueOnce(new Error('write failed'));

    renderWithProviders(<EditProfileScreen />);

    fireEvent.press(screen.getByTestId('edit-profile-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    // The whole point of the fix: a failed write is surfaced, not swallowed, and
    // the screen does NOT close as though it saved.
    expect(alert).toHaveBeenCalledWith('Could not save', expect.any(String));
    expect(back).not.toHaveBeenCalled();

    alert.mockRestore();
  });

  describe('cover photo', () => {
    // These pin the bug this feature shipped with: the cover camera badge used
    // to be a "Coming soon" alert — a picker that never opened, no upload, and
    // nothing persisted — while the avatar badge beside it worked.
    const originalFetch = global.fetch;

    function stubImageFetch() {
      global.fetch = jest.fn(async () => ({
        arrayBuffer: async () => new ArrayBuffer(8),
      })) as unknown as typeof fetch;
    }

    function pickCoverImage() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ImagePicker = require('expo-image-picker');
      (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: 'file:///picked-cover.jpg' }],
      });
      return ImagePicker;
    }

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('opens the picker, uploads the cover, and shows it in the banner', async () => {
      stubImageFetch();
      const ImagePicker = pickCoverImage();
      const uploadProfileCover = jest
        .fn()
        .mockResolvedValue({ coverUrl: 'https://cdn.test/covers/user-1.jpg' });
      const repository = { ...createTestSpotlightRepository(), uploadProfileCover };

      renderWithProviders(<EditProfileScreen />, { spotlightRepository: repository });

      fireEvent.press(screen.getByTestId('edit-profile-cover-camera'));

      await waitFor(() => expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalled());
      await waitFor(() =>
        expect(uploadProfileCover).toHaveBeenCalledWith(expect.any(ArrayBuffer)),
      );
      // The picked cover renders straight away, optimistically, exactly like the
      // avatar does — no save round trip needed to see it.
      await screen.findByTestId('edit-profile-cover-image');
    });

    it('does NOT crop the banner square (iOS allowsEditing forces 1:1)', async () => {
      stubImageFetch();
      const ImagePicker = pickCoverImage();
      const repository = {
        ...createTestSpotlightRepository(),
        uploadProfileCover: jest.fn().mockResolvedValue({ coverUrl: 'https://cdn.test/c.jpg' }),
      };

      renderWithProviders(<EditProfileScreen />, { spotlightRepository: repository });
      fireEvent.press(screen.getByTestId('edit-profile-cover-camera'));

      await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalled());
      const options = (ImagePicker.launchImageLibraryAsync as jest.Mock).mock.calls[0][0];
      // expo-image-picker's `aspect` is Android-only and iOS's editor crops
      // SQUARE, so a wide banner must not go through the built-in editor.
      expect(options.allowsEditing).toBe(false);
      expect(options).not.toHaveProperty('aspect');
    });

    it('persists the uploaded cover URL on save', async () => {
      stubImageFetch();
      pickCoverImage();
      const repository = {
        ...createTestSpotlightRepository(),
        uploadProfileCover: jest
          .fn()
          .mockResolvedValue({ coverUrl: 'https://cdn.test/covers/user-1.jpg' }),
      };

      renderWithProviders(<EditProfileScreen />, { spotlightRepository: repository });

      fireEvent.press(screen.getByTestId('edit-profile-cover-camera'));
      await screen.findByTestId('edit-profile-cover-image');

      fireEvent.press(screen.getByTestId('edit-profile-save'));

      await waitFor(() => expect(updateProfile).toHaveBeenCalled());
      const patch = updateProfile.mock.calls[0][0];
      expect(patch.coverURL).toContain('https://cdn.test/covers/user-1.jpg');
    });

    it('OMITS coverURL from the patch when the user never picked one', async () => {
      renderWithProviders(<EditProfileScreen />);

      fireEvent.press(screen.getByTestId('edit-profile-save'));

      await waitFor(() => expect(updateProfile).toHaveBeenCalled());
      // `cover_url` is the newest column: sending it on every ordinary save
      // would fail the WHOLE write on any environment that has not run the
      // cover migration yet.
      expect(updateProfile.mock.calls[0][0]).not.toHaveProperty('coverURL');
    });

    it('tells the user when the cover upload fails instead of silently doing nothing', async () => {
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      stubImageFetch();
      pickCoverImage();
      const repository = {
        ...createTestSpotlightRepository(),
        uploadProfileCover: jest.fn().mockRejectedValue(new Error('cover 503')),
      };

      renderWithProviders(<EditProfileScreen />, { spotlightRepository: repository });

      fireEvent.press(screen.getByTestId('edit-profile-cover-camera'));

      await waitFor(() =>
        expect(alert).toHaveBeenCalledWith('Could not update photo', expect.any(String)),
      );
      expect(screen.queryByTestId('edit-profile-cover-image')).toBeNull();

      alert.mockRestore();
    });

    it('prefills the banner from the saved cover on the current user', () => {
      (useAuth as jest.Mock).mockReturnValue({
        currentUser: {
          avatarURL: null,
          coverURL: 'https://cdn.test/covers/saved.jpg',
          displayName: 'Ash',
          id: 'user-1',
        },
        updateProfile,
      });

      renderWithProviders(<EditProfileScreen />);

      expect(screen.getByTestId('edit-profile-cover-image')).toBeTruthy();
    });
  });

  describe('handle field (removed)', () => {
    it('no longer renders a handle field or availability check', () => {
      renderWithProviders(<EditProfileScreen />);

      expect(screen.queryByTestId('edit-profile-handle-input')).toBeNull();
      expect(screen.queryByTestId('edit-profile-handle-status')).toBeNull();
      // The saved handle isn't prefilled anywhere either…
      expect(screen.queryByDisplayValue('ash')).toBeNull();
      // …and nothing probes availability now that there's nothing to claim.
      expect(isHandleAvailable).not.toHaveBeenCalled();
    });

    it('OMITS handle from the patch so saving never releases the account handle', async () => {
      renderWithProviders(<EditProfileScreen />);

      fireEvent.press(screen.getByTestId('edit-profile-save'));

      await waitFor(() => expect(updateProfile).toHaveBeenCalled());
      // `updateProfile` writes any key that is present, so a `handle: null` here
      // would drop the user's @handle on every profile save. The key must be
      // absent, not null.
      const patch = updateProfile.mock.calls[0][0];
      expect(patch).not.toHaveProperty('handle');
      expect(back).toHaveBeenCalled();
    });
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    THE REPORTED BUG: "the keyboard covers the bio field on Android"
    ───────────────────────────────────────────────────────────────────────────
    The form was wrapped in a `KeyboardAvoidingView` with
    `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`, and
    `behavior={undefined}` is a literal passthrough — the component renders a
    plain View and avoids nothing. That was survivable while Android resized the
    window for the IME, but this app builds with `edgeToEdgeEnabled=true`
    (android/gradle.properties), under which the window is NEVER resized: the app
    draws behind the IME and consumes the inset itself. So Android had no
    keyboard avoidance at all and the keyboard drew straight over the bio field.

    The fix shrinks the scroll viewport to the top of the keyboard, which is also
    what makes Android's own `ScrollView.onSizeChanged` bring the focused field
    into the space that is left.

    The number is the thing that gets re-derived wrong, so it is asserted here:
    the reserved strip is the keyboard PLUS the navigation bar, because
    `ReactRootView.java:922` computes `imeInsets.bottom - barInsets.bottom` and
    hands JS a height that excludes the bar the safe-area inset pays separately.
    See `src/lib/keyboard-insets.ts`.
  */
  describe('keyboard avoidance', () => {
    const keyboardHandlers = new Map<string, (event: unknown) => void>();

    /** The avoider's own bottom padding — what the form reserves for the keyboard. */
    function avoiderPadding(): number | undefined {
      return StyleSheet.flatten(
        screen.getByTestId('edit-profile-keyboard-avoider').props.style,
      ).paddingBottom;
    }

    function stubKeyboard() {
      keyboardHandlers.clear();
      jest
        .spyOn(Keyboard, 'addListener')
        .mockImplementation((event: string, handler: (payload: never) => void) => {
          keyboardHandlers.set(event, handler as (payload: unknown) => void);
          return { remove: () => keyboardHandlers.delete(event) } as never;
        });
    }

    async function raiseKeyboard(height: number) {
      const show = Array.from(keyboardHandlers.entries()).find(([event]) =>
        event.toLowerCase().includes('show'),
      );
      expect(show).toBeDefined();
      await act(async () => {
        show?.[1]({ endCoordinates: { height } });
      });
    }

    async function dropKeyboard() {
      const hide = Array.from(keyboardHandlers.entries()).find(([event]) =>
        event.toLowerCase().includes('hide'),
      );
      expect(hide).toBeDefined();
      await act(async () => {
        hide?.[1]({ endCoordinates: { height: 0 } });
      });
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('on Android', () => {
      beforeEach(() => {
        jest.replaceProperty(Platform, 'OS', 'android');
        stubKeyboard();
      });

      it('reserves the keyboard AND the navigation bar under it', async () => {
        renderWithProviders(<EditProfileScreen />);

        // Nothing reserved before the keyboard arrives — the sticky action bar
        // owns the bottom of the screen at rest.
        expect(avoiderPadding() ?? 0).toBe(0);

        await raiseKeyboard(300);

        // 300 reported + the 34 bottom inset the harness publishes. NOT 300:
        // the reported height is measured ABOVE the nav bar (ReactRootView.java
        // :922), so stopping at 300 leaves the field a nav bar short and the
        // keyboard still over it.
        expect(avoiderPadding()).toBe(334);
      });

      it('gives the form back the whole screen when the keyboard goes down', async () => {
        renderWithProviders(<EditProfileScreen />);

        await raiseKeyboard(300);
        expect(avoiderPadding()).toBe(334);

        await dropKeyboard();
        // Back to zero, so the sticky action bar is not left floating above a
        // strip of nothing.
        expect(avoiderPadding()).toBe(0);
      });
    });

    describe('on iOS', () => {
      beforeEach(() => {
        stubKeyboard();
      });

      it('leaves the lifting to the KeyboardAvoidingView, and pays nothing itself', () => {
        renderWithProviders(<EditProfileScreen />);

        // iOS avoidance is the platform component's job (`behavior="padding"`)
        // and already worked. The screen must not start adding a second,
        // competing padding on top of it — so it does not even subscribe to the
        // keyboard here, and there is no height for it to apply.
        expect(screen.getByTestId('edit-profile-keyboard-avoider')).toBeTruthy();
        // The only subscriptions are the KeyboardAvoidingView's own `will` pair.
        // The screen's Android-only `did` listeners are absent, so there is no
        // second height for it to pad with.
        expect(Array.from(keyboardHandlers.keys()).sort()).toEqual([
          'keyboardWillHide',
          'keyboardWillShow',
        ]);
        expect(avoiderPadding() ?? 0).toBe(0);
      });
    });
  });
});
