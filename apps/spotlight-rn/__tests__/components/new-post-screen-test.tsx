import { Alert, StyleSheet } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { createPost } from '@/features/social/social-service';
import {
  NewPostScreen,
  keyboardLift,
  resolveComposerInsets,
} from '@/features/social/screens/new-post-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

/*
  The composer guards against losing an unwritten post via `usePreventRemove`,
  which needs a real navigator. Mocking the two hooks keeps these tests free of
  a NavigationContainer AND makes the guard directly assertable: `preventRemove`
  records whether it was armed on each render.
*/
const mockPreventRemove = jest.fn();
const mockDispatch = jest.fn();
jest.mock('@react-navigation/native', () => ({
  // Spread the real module: expo-router's testing-library needs
  // `createNavigatorFactory` from it, and a wholesale replacement breaks the
  // suite's router harness.
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ dispatch: mockDispatch }),
  usePreventRemove: (enabled: boolean, callback: unknown) =>
    mockPreventRemove(enabled, callback),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useNavigation: jest.fn(),
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

  it('opens with the keyboard DOWN, exactly as Figma 3147:10814 draws it', () => {
    renderWithProviders(<NewPostScreen />);

    // The sheet and the keyboard are two animations competing for the same
    // height, so raising the keyboard on open made the sheet visibly arrive in
    // two stages. No delay fixes that — the design simply has no keyboard on
    // open: placeholder visible, all three chips visible, POST disabled. The
    // keyboard belongs to the moment the author taps the field.
    expect(screen.getByTestId('new-post-body-input').props.autoFocus).toBeFalsy();

    // Nothing may schedule focus behind the scenes either.
    expect(screen.getByTestId('new-post-body-input').props.value).toBe('');
    expect(screen.getByPlaceholderText("What's on your mind?")).toBeTruthy();

    // The full opening state is on screen — not hidden behind a keyboard.
    expect(screen.getByTestId('new-post-privacy')).toBeTruthy();
    expect(screen.getByTestId('new-post-add-image')).toBeTruthy();
    expect(screen.getByTestId('new-post-add-camera')).toBeTruthy();
    expect(screen.getByTestId('new-post-submit')).toBeDisabled();
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

    // The preview is the photo and a remove button — nothing else. It used to
    // carry a moderation note under it, which spent a line of the composer
    // explaining a review step the author cannot act on.
    expect(screen.queryByText(/reviewed before others can see it/i)).toBeNull();

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
  it('offers no drag affordance, because there is no drag to dismiss', () => {
    renderWithProviders(<NewPostScreen />);

    // The composer is a full-page modal with `gestureEnabled: false` on both
    // platforms. A grabber over a surface you cannot drag is a lie about the
    // controls the screen has.
    expect(screen.queryByTestId('sheet-header-handle')).toBeNull();
  });

  /*
    There is no draft persistence behind this screen, so every removal has to be
    intercepted: what is typed and attached only exists here. The gesture that
    used to make this urgent is gone (full-page modal, no swipe on either
    platform), which leaves the X button and Android's hardware back — both
    deliberate, both still unrecoverable if they were a mis-tap.

    The other half of this is the guard NOT firing when it shouldn't: a
    successful post dismisses the screen while the body is still populated, and
    re-arming inside that window resurrects the composer (see 'a successful post
    never re-arms the discard guard').
  */
  describe('closing and posting', () => {
    /*
      There is NO discard confirmation any more, deliberately — see the long note
      in `new-post-screen.tsx` where the guard used to be. It existed to protect
      against a form sheet's drag-to-dismiss firing over the text field; that
      gesture is gone, so the only exits left are the X button and hardware back,
      both deliberate presses.

      `usePreventRemove` is still mocked at the top of this file rather than
      removed: it asserts the screen never quietly re-registers a guard.
    */
    /** Whether the screen registered a remove-guard on any render. */
    function guardEverArmed(): boolean {
      return mockPreventRemove.mock.calls.some((call) => Boolean(call[0]));
    }

    it('never registers a remove-guard, however much has been typed', async () => {
      renderWithProviders(<NewPostScreen />);
      const input = await screen.findByTestId('new-post-body-input');

      fireEvent.changeText(input, 'Just pulled a Charizard');

      expect(guardEverArmed()).toBe(false);
    });

    it('posts without raising any confirmation', async () => {
      /*
        THE REGRESSION TEST, and it outlived the guard it was written for.

        `isSubmitting` used to be reset in a `finally` the instant the post
        succeeded — with `body` still populated, so the guard re-armed DURING
        the ~500ms native dismissal `router.back()` had just started. That
        re-render reaches `NativeStackView` with `preventNativeDismiss={true}`
        mid-animation, `RNSScreen.mm`'s `viewDidDisappear` takes the PREVENT
        branch and calls `updateContainer`, and the composer comes BACK.

        The guard is gone now, but the state machine that keeps `submitState`
        terminal on success is what stops that re-render — so this still pins
        the fix, and it also pins that posting is silent.
      */
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      renderWithProviders(<NewPostScreen />);
      const input = await screen.findByTestId('new-post-body-input');

      fireEvent.changeText(input, 'Pulled a Charizard');
      fireEvent.press(screen.getByTestId('new-post-submit'));

      await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
      // Let every remaining microtask (and any state it sets) flush.
      await waitFor(() => expect(createPost).toHaveBeenCalledTimes(1));

      // No dialog on the way out — not the old discard prompt, not anything.
      expect(alertSpy).not.toHaveBeenCalled();
      expect(guardEverArmed()).toBe(false);
      // POST stays disabled while the screen slides away, instead of flicking
      // back to an inviting button.
      expect(screen.getByTestId('new-post-submit')).toBeDisabled();

      alertSpy.mockRestore();
    });

    it('a failed post leaves the composer usable', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (createPost as jest.Mock).mockResolvedValueOnce(null);

      renderWithProviders(<NewPostScreen />);
      const input = await screen.findByTestId('new-post-body-input');

      fireEvent.changeText(input, 'Pulled a Charizard');
      fireEvent.press(screen.getByTestId('new-post-submit'));

      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith("Couldn't post", expect.any(String)),
      );
      // Nothing was published, so nothing may dismiss...
      expect(back).not.toHaveBeenCalled();
      // ...and the author can try again.
      expect(screen.getByTestId('new-post-submit')).toBeEnabled();

      alertSpy.mockRestore();
    });

    it('a thrown createPost is surfaced, not swallowed', async () => {
      /*
        Pins the `catch`. `handleSubmit` is fired as `void handleSubmit()`, so
        before this a throw vanished into an unhandled rejection and only the
        `finally` un-stuck the button. With the `finally` gone, an uncaught
        throw would strand the composer at 'submitting' forever, leaving POST
        permanently disabled with the author's text trapped behind it.
      */
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (createPost as jest.Mock).mockRejectedValueOnce(new Error('network down'));

      renderWithProviders(<NewPostScreen />);
      const input = await screen.findByTestId('new-post-body-input');

      fireEvent.changeText(input, 'Pulled a Charizard');
      fireEvent.press(screen.getByTestId('new-post-submit'));

      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith("Couldn't post", expect.any(String)),
      );
      expect(back).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('new-post-submit')).toBeEnabled());

      alertSpy.mockRestore();
    });
  });

  /*
    THE COMPOSER PAYS ITS OWN SAFE AREA, and these pin that it really does.

    This screen used to be wrapped in `react-native-safe-area-context`'s native
    `SafeAreaView` with `edges={['top','bottom','left','right']}`. Inside an iOS
    `fullScreenModal` that view pays NOTHING: `RNCSafeAreaViewComponentView`
    finds its provider by walking the NATIVE `superview` chain, and a modal is a
    separately presented `UIViewController`, so the chain never reaches the root
    `RNCSafeAreaProviderComponentView` and the lookup falls back to `self`. The
    header landed under the Dynamic Island and the POST button sat one
    home-indicator strip inside the keyboard, because `keyboardLift` subtracted
    an inset that nothing had actually paid.

    `src/app/(sheet)/_layout.tsx` hit the identical bug (its back button drew on
    top of the clock) and worked around it with a nested `SafeAreaProvider`.
    Here the padding is applied directly instead, so the number the container
    pays and the number `keyboardLift` subtracts are literally the same
    variable.
  */
  describe('safe-area insets', () => {
    it('pads its own root view rather than trusting SafeAreaView', () => {
      renderWithProviders(<NewPostScreen />);

      // The harness mounts a SafeAreaProvider with the iPhone metrics
      // (top 59 / bottom 34) — those must appear as REAL padding on the
      // composer's own root, not be delegated to a native view that silently
      // resolves them to zero inside a modal.
      const root = StyleSheet.flatten(screen.getByTestId('new-post').props.style);
      expect(root.paddingTop).toBe(59);
      expect(root.paddingBottom).toBe(34);
    });

    it('falls back to the window metrics when the live inset reads zero', () => {
      // The failure mode this whole change exists for: a presented modal
      // reporting no inset at all. `initialWindowMetrics` is captured natively
      // from the WINDOW at startup, so it still carries the notch.
      expect(
        resolveComposerInsets(
          { bottom: 0, left: 0, right: 0, top: 0 },
          { bottom: 34, left: 0, right: 0, top: 59 },
        ),
      ).toEqual({ bottom: 34, left: 0, right: 0, top: 59 });
    });

    it('keeps the live inset when it is the larger of the two', () => {
      // Rotation, a taller status bar, a split-view width — the live provider
      // is still the more current number whenever it has one.
      expect(
        resolveComposerInsets(
          { bottom: 34, left: 21, right: 21, top: 59 },
          { bottom: 34, left: 0, right: 0, top: 59 },
        ),
      ).toEqual({ bottom: 34, left: 21, right: 21, top: 59 });
    });

    it('tolerates absent window metrics', () => {
      // `initialWindowMetrics` is null on web and under the test renderer.
      expect(resolveComposerInsets({ bottom: 34, left: 0, right: 0, top: 59 }, null)).toEqual({
        bottom: 34,
        left: 0,
        right: 0,
        top: 59,
      });
    });

    it('never returns a negative inset', () => {
      expect(
        resolveComposerInsets({ bottom: -8, left: 0, right: 0, top: -8 }, null),
      ).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
    });
  });

  /*
    The footer's lift is arithmetic over two numbers the two platforms define
    differently, which is exactly the kind of thing that gets "simplified" back
    into a bug. See `keyboardLift`'s own comment for the citation.
  */
  describe('keyboardLift', () => {
    it('subtracts the safe-area inset on iOS, which the keyboard frame overlaps', () => {
      expect(keyboardLift(300, 34, 'ios')).toBe(266);
    });

    it('does NOT subtract on Android, where the reported height already excludes the nav bar', () => {
      // ReactRootView.java:922 — `int height = imeInsets.bottom - barInsets.bottom;`
      // The reported height is measured ABOVE the navigation bar, while
      // SafeAreaView pays that bar separately. Subtracting here under-lifts by
      // exactly one nav bar (~24pt gesture, ~48pt three-button) and buries the
      // POST button.
      expect(keyboardLift(300, 48, 'android')).toBe(300);
      expect(keyboardLift(300, 48, 'android')).not.toBe(252);
    });

    it('lifts nothing when the keyboard is down', () => {
      expect(keyboardLift(0, 34, 'ios')).toBe(0);
      expect(keyboardLift(0, 48, 'android')).toBe(0);
    });

    /*
      THE CONTRACT, stated as the invariant the screen actually needs.

      `bottomInset` is the padding the composer's own root View applies — it is
      the same `safeArea.bottom` passed to both, not an inset some other
      component may or may not have paid. The footer's bottom edge therefore
      sits `bottomInset + lift` above the screen's bottom edge, and that total
      is what has to clear the keyboard.
    */
    it('lands the footer exactly on the keyboard on iOS', () => {
      // iOS reports the keyboard in SCREEN coordinates, so it already covers
      // the home-indicator strip: total clearance == the keyboard height.
      const bottomInset = 34;
      expect(bottomInset + keyboardLift(300, bottomInset, 'ios')).toBe(300);
    });

    it('clears the nav bar AND the keyboard on Android', () => {
      // ReactRootView.java:922 reports the height ABOVE the nav bar, so the
      // total is the keyboard PLUS the bar the padding pays separately.
      const bottomInset = 48;
      expect(bottomInset + keyboardLift(300, bottomInset, 'android')).toBe(348);
    });

    it('still holds the footer off the home indicator with the keyboard down', () => {
      // Lift is zero, so the padding alone is the clearance.
      const bottomInset = 34;
      expect(bottomInset + keyboardLift(0, bottomInset, 'ios')).toBe(34);
    });
  });
});