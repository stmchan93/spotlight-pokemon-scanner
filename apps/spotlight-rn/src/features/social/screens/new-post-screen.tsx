import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, Globe, MediaImage, NavArrowDown, Xmark } from 'iconoir-react-native';

import { Avatar, Button, IconButton, SheetHeader, Text, useSpotlightTheme } from '@spotlight/design-system';

import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { keyboardLift } from '@/lib/keyboard-insets';
import { loadNativeImagePicker } from '@/lib/native-image-picker';
import { createPost } from '@/features/social/social-service';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

// Max post length. Mirrors the backend `posts.body` guard; the counter warns as
// the author approaches it and `maxLength` hard-stops at it.
const BODY_MAX_LENGTH = 500;

// Post images are downscaled to this width before upload — enough for a
// full-bleed feed image without shipping a multi-megabyte original.
const POST_IMAGE_WIDTH = 1080;

// NOTE ON FOCUS — the composer deliberately does NOT focus its body on open.
//
// Figma 3147:10814 is the opening state, and it has no keyboard: the placeholder
// "What's on your mind?" in gray/600, all three control chips, and a disabled
// gray/400 POST button are all visible. The keyboard belongs to the moment the
// author taps the field, not to the moment the sheet appears.
//
// Auto-focusing fought the sheet in every form it was tried. `autoFocus` raised
// the keyboard mid-presentation, so it appeared, the sheet re-laid-out, and it
// appeared again. A 300ms timer still fired mid-animation (an iOS form-sheet
// presentation takes ~500ms). Waiting for the navigator's `transitionEnd` fixed
// the double-raise but simply moved the problem: the sheet animated to its
// detent, then the keyboard arrived and UIKit resized the sheet to accommodate
// it — a visible two-stage open.
//
// There is no delay that fixes this, because the keyboard and the sheet are two
// animations competing for the same height. Not raising the keyboard on open
// removes the competition entirely AND matches the design.

// ---------------------------------------------------------------------------
// Feed refresh signal
// ---------------------------------------------------------------------------
// Screens that show posts stay mounted behind pushed routes and tabs. Rather
// than reload on every focus (returning from a PDP shouldn't refetch), a write
// that changes what those lists should contain — publishing a post, reposting —
// bumps this counter, and each screen reloads on focus when the counter has
// moved since the last time IT looked.
//
// A COUNTER, NOT A READ-AND-CLEAR FLAG. There is more than one consumer (the
// feed and the owner's Portfolio → Activity), and with a one-shot boolean
// whichever regained focus first swallowed the signal and the other kept
// serving its stale list forever. That is precisely the "I reposted but it
// isn't in my Activity" bug: the repost happened on the feed, so the feed ate
// the flag. Every consumer now sees every signal.
let feedRefreshVersion = 0;

/** Mark post lists as needing a reload the next time each regains focus. */
export function signalFeedNeedsRefresh(): void {
  feedRefreshVersion += 1;
}

/** The current signal version. Consumers compare it against their own last-seen. */
export function getFeedRefreshVersion(): number {
  return feedRefreshVersion;
}

/**
 * The safe-area insets this screen pays for itself.
 *
 * WHY THIS EXISTS INSTEAD OF A `SafeAreaView`.
 *
 * The composer used to be wrapped in `react-native-safe-area-context`'s native
 * `SafeAreaView` with all four `edges`. Inside an iOS `fullScreenModal` that
 * component pays NOTHING, and the reason is in its source:
 * `RNCSafeAreaViewComponentView.findNearestProvider` walks the NATIVE
 * `superview` chain looking for the `RNCSafeAreaProviderComponentView`. A
 * `fullScreenModal` is a separately presented `UIViewController`
 * (`RNSScreenStack.mm:576` — `presentViewController:`), so its view is no
 * longer a native descendant of the root React tree: the walk falls off the end
 * and returns `self`. What it then reads is observed exactly once, and the only
 * change notification it subscribes to (`RNCSafeAreaDidChange`) is posted by
 * providers — never by `self` — so a zero read is permanent.
 *
 * `src/app/(sheet)/_layout.tsx` hit the identical bug on the identical
 * presentation ("Search Cards put its back button on top of the clock despite
 * asking for `edges: ['top']`") and worked around it with a nested
 * `SafeAreaProvider`. This screen is a single route with no group layout to
 * hang one off, and — more usefully — `keyboardLift` below needs to subtract
 * the very inset the container paid. Applying it here as explicit padding makes
 * those two the SAME NUMBER instead of an assumption about a native component.
 *
 * ANDROID WAS NEVER BROKEN, and this does not change what it computes.
 * `SafeAreaUtils.kt`'s `getSafeAreaInsets` derives from `view.rootView`'s
 * `rootWindowInsets` — the WINDOW, reachable whether or not a provider is —
 * and re-checks it on every `onPreDraw`, so Android both found the right number
 * and self-corrected. The values below are those same window insets.
 *
 * `live` is the root provider's insets (React context crosses the native modal
 * boundary, so the hook keeps working where the native view does not).
 * `window` is `initialWindowMetrics` — read from native constants at startup
 * and describing the WINDOW, so it carries the real notch/home-indicator
 * regardless of what a presented view controller reports. Taking the larger per
 * edge means neither source being wrong can under-pad; this is the same
 * distrust of a live inset as `scanner-screen.tsx`'s `trayBottomInset`.
 */
export function resolveComposerInsets(
  live: EdgeInsets,
  window: EdgeInsets | null | undefined,
): EdgeInsets {
  const resolve = (liveEdge: number, windowEdge: number | undefined) =>
    Math.max(0, liveEdge, windowEdge ?? 0);
  return {
    bottom: resolve(live.bottom, window?.bottom),
    left: resolve(live.left, window?.left),
    right: resolve(live.right, window?.right),
    top: resolve(live.top, window?.top),
  };
}

/*
 * `keyboardLift` USED TO BE DEFINED HERE. It now lives in
 * `src/lib/keyboard-insets.ts`, unchanged, and is re-exported below so this
 * remains its import site.
 *
 * What it does for this screen is still exactly what it did: how far the footer
 * (Public / Photo / Camera + POST) must be lifted to clear a keyboard of height
 * `keyboardHeight`, given `bottomInset` — the bottom padding the composer's own
 * root View applies, from `resolveComposerInsets` above. THE CONTRACT is that
 * the footer's bottom edge ends up `bottomInset + lift` above the screen's
 * bottom edge, and `bottomInset` is the SAME VARIABLE the container pays, not an
 * inset some other component is assumed to have paid — this used to name a
 * `SafeAreaView` that turned out to pay nothing inside an iOS modal, so the
 * footer was lifted `keyboardHeight - 34` when it needed `keyboardHeight` and
 * POST sat one home-indicator strip inside the keyboard.
 *
 * WHY IT MOVED: the per-platform arithmetic (iOS reports a screen-coordinate
 * frame that already covers the home indicator; Android reports
 * `imeInsets.bottom - barInsets.bottom`, `ReactRootView.java:922`, which
 * EXCLUDES the navigation bar the safe-area inset pays separately) had been
 * derived independently three times — here, as `systemBottomInset` in
 * `comments-sheet.tsx`, and NOT AT ALL in `edit-profile-screen.tsx`, which
 * shipped with the keyboard over its bio field. Two of those carried a comment
 * saying they existed "so there is no third time". The citation, and the
 * function, are now in one importable place; read it there.
 */
export { keyboardLift };

// `uploadPostMedia` is added to the repository by a separate slice. Type it as an
// optional method so this screen typechecks (and stays non-crashing) whether or
// not the running binary's repository actually carries it.
type PostMediaUploader = {
  uploadPostMedia?: (postId: string, jpegBytes: ArrayBuffer) => Promise<{ mediaId: string }>;
};

// expo-image-picker / expo-image-manipulator are native modules that may be
// absent from the binary an OTA-updated JS bundle is running on. The picker is
// probed through `loadNativeImagePicker`, which checks the NATIVE registry —
// requiring the JS alone succeeds even when the native half is missing, which is
// what crashed the composer's Photo/Camera chips.
function loadImageManipulator() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-manipulator');
  } catch {
    return null;
  }
}

/**
 * A filled composer affordance pill — the gray "Post Controls" chips from the
 * Figma New Post sheet (gray/50 fill, radius-8, 40pt tall, an 18pt icon + a
 * 13pt Label). Used for the Public / Photo / Camera controls.
 */
function ControlChip({
  icon,
  label,
  labelColor,
  onPress,
  testID,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  labelColor: string;
  onPress: () => void;
  testID: string;
  trailing?: React.ReactNode;
}) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.controlChip,
        {
          backgroundColor: theme.colors.gray50,
          borderRadius: theme.radii.sm,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
      testID={testID}
    >
      {icon}
      <Text style={[theme.typography.label, { color: labelColor }]}>{label}</Text>
      {trailing}
    </Pressable>
  );
}

/**
 * New Post composer (Phase 3c). A FULL-PAGE modal that comes up from the bottom
 * and cannot be dismissed by a gesture — the only ways out are the X button and
 * a completed post. Styled from the Figma "New Post" sheet minus its grabber
 * (there is nothing to drag): close + centered title, the author's avatar/name,
 * a multiline body ("What's on your mind?"), a row of three "Post Controls"
 * chips — Public (a static visibility indicator), Photo (library picker) and
 * Camera (device capture) — and a full-width POST button pinned to the bottom
 * that stays gray/disabled until there's text and turns dark once there is.
 *
 * Submit inserts the text post via `createPost`, then best-effort uploads the
 * image to the post-media endpoint — a failed image upload leaves the text post
 * intact. Every native dependency is loaded defensively so the screen never
 * crashes.
 */
export function NewPostScreen({ testID = 'new-post' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { currentUser } = useAuth();
  /*
    THE ONE SOURCE OF TRUTH for this screen's safe area.

    `safeArea` is applied as explicit padding on the root View below AND handed
    to `keyboardLift` — the container's clearance and the footer's lift are
    computed from the same number, so neither can assume the other paid.

    The native `SafeAreaView` that used to do this silently resolved to ZERO
    inside an iOS `fullScreenModal`; the full mechanism is on
    `resolveComposerInsets`.
  */
  const insets = useSafeAreaInsets();
  const safeArea = resolveComposerInsets(insets, initialWindowMetrics?.insets);

  const [body, setBody] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);

  /*
    SUBMIT IS THREE STATES, NOT A BOOLEAN, AND THE THIRD ONE IS A BUG FIX.

    `isSubmitting` used to be flipped back to false in a `finally` the moment
    the post succeeded — while `body` still held the text, so the discard guard
    re-armed DURING the ~500ms native dismissal that `router.back()` had just
    started. That re-render lands on `NativeStackView` with
    `preventNativeDismiss={true}` mid-animation, so `RNSScreen.mm`'s
    `viewDidDisappear` takes the PREVENT branch, calls `updateContainer` —
    RESURRECTING the composer in the JS stack — and re-dispatches a pop, which
    the freshly-armed guard then intercepts with "Discard this post?". The alert
    is the symptom; the composer coming back from the dead is the failure.

    `posted` is a TERMINAL state precisely so nothing re-arms behind the
    animation: the guard is off, POST stays disabled, and the screen is on its
    way out. It has to be state and not a ref — `usePreventRemove` evaluates its
    argument during render and reads it at fire time from the last COMMITTED
    render, so a ref makes the fix depend on React's scheduling winning a race
    against a native animation. (That was tried and reverted.)
  */
  type SubmitState = 'idle' | 'submitting' | 'posted';
  const [submitState, setSubmitState] = useState<SubmitState>('idle');

  /*
    Lift the footer (Public / Photo / Camera + POST) clear of the keyboard.

    HOW THIS IS COMPUTED, AND WHY IT IS NOT MEASURED.

    The previous attempt measured the footer's window position on each keyboard
    event and padded by the SHORTFALL, feeding its own output back in. That
    lifted the chips clear but left the POST button under the keyboard: a
    self-correcting loop only converges if every input is settled when it is
    read, and here they are not — `keyboardDidShow` can land before the sheet's
    final layout, and the QuickType suggestion bar changes the keyboard's height
    afterwards WITHOUT firing another `keyboardDidShow`. Each stale reading was
    silently absorbed as "already clear".

    So compute it instead, in `keyboardLift` above — the footer is the
    bottom-most thing in a modal that reaches the screen's bottom edge, so the
    lift is a function of the reported keyboard height and the `safeArea.bottom`
    padding this screen applies to its own root. No feedback loop, nothing to
    converge, and it is right on the first frame. The per-platform arithmetic
    (and why Android must NOT subtract the inset) is documented on that
    function.

    Nothing lifts this screen for the keyboard except this. UIKit does not move a
    full-screen modal for the keyboard, and the `KeyboardAvoidingView` that used
    to wrap the content had `behavior={undefined}` — a literal passthrough — so
    it never did either, whatever its comment claimed.

    `keyboardWillChangeFrame` carries every height change, including the ones
    `keyboardDidShow` misses, and its `will` phase means the footer travels with
    the keyboard's own animation instead of snapping after it.
  */
  /*
    NO DISCARD CONFIRMATION — removed deliberately, on request.

    There used to be a `usePreventRemove` guard here raising "Discard this post?"
    on every exit. It was added when the composer was a form sheet whose
    drag-to-dismiss was armed across the whole surface, including directly over
    the text field: a stray flick could bin a written post, and the confirm was
    the only thing in its way.

    That gesture no longer exists. The composer is a full-page modal with no
    dismiss gesture on either platform, so the only ways out are the X button and
    Android's hardware back — both deliberate presses on a specific target. The
    confirm was guarding an accident that can no longer happen, and it was
    charging a tap for every intentional close to do it.

    Worth being clear-eyed about the cost: there is still no draft persistence
    behind this screen, so closing does lose what was typed. That is now the
    stated behaviour rather than something a dialog apologised for. If losing
    drafts turns out to bite, the fix is to KEEP the text (lift it out of this
    screen's state, or persist it), not to put the dialog back — a confirm makes
    the loss louder, it does not make it recoverable.
  */

  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    /*
      BOTH platforms, because the keyboard overlays the app on both.

      Android looked like the exception — `softwareKeyboardLayoutMode` is unset,
      so Expo asks for `adjustResize` — but under EDGE-TO-EDGE (default in Expo
      SDK 55 / RN 0.83, enforced by Android 15) the window is not resized at
      all: the app draws behind the IME and consumes the inset itself. Leaving
      this iOS-only meant nothing lifted the footer on Android and the keyboard
      simply covered Post / Public / photo / camera.

      `KeyboardAvoidingView` is deliberately NOT doing this job. Driving the
      footer from the measured height is what makes it travel WITH the
      keyboard's own animation, and it is one mechanism to reason about instead
      of two that can disagree.
    */
    const isIOS = Platform.OS === 'ios';
    // `keyboardWillChangeFrame` carries every height change and animates in the
    // `will` phase, but is iOS-only; Android gets the `did` pair.
    const showEvent = isIOS ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = isIOS ? 'keyboardWillHide' : 'keyboardDidHide';
    const changeSub = Keyboard.addListener(showEvent, (event) => {
      const screenHeight = Dimensions.get('window').height;
      const endCoordinates = event?.endCoordinates;
      if (isIOS) {
        const top = endCoordinates?.screenY ?? screenHeight;
        // Derived from the keyboard's TOP rather than read from `height`: a
        // dismissing keyboard reports its full height with a top that is already
        // off-screen, which would keep the footer floating after it left.
        setKeyboardHeight(Math.max(0, screenHeight - top));
        return;
      }
      setKeyboardHeight(Math.max(0, endCoordinates?.height ?? 0));
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      changeSub.remove();
      hideSub.remove();
    };
  }, []);

  const keyboardOverlap = keyboardLift(keyboardHeight, safeArea.bottom);

  const trimmedBody = body.trim();
  const canPost = submitState === 'idle' && trimmedBody.length > 0;

  const authorName = currentUser ? getResolvedDisplayName(currentUser) : 'Collector';
  const authorInitials = currentUser ? getUserInitials(currentUser) : 'C';

  // Downscale a freshly-picked/captured image to a ~1080px JPEG and stage it as
  // the single pending post image. Shared by the Photo and Camera flows.
  const stagePickedImage = useCallback(async (rawUri: string) => {
    let uri = rawUri;
    const ImageManipulator = loadImageManipulator();
    if (ImageManipulator) {
      const manipulated = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: POST_IMAGE_WIDTH } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      );
      if (manipulated?.uri) {
        uri = manipulated.uri;
      }
    }
    setImageUri(uri);
  }, []);

  const handlePickImage = useCallback(async () => {
    const ImagePicker = loadNativeImagePicker();
    if (!ImagePicker) {
      Alert.alert('Update needed', 'Adding a photo needs the latest app version.');
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission?.granted === false) {
        Alert.alert('Photos access needed', 'Allow photo access to add an image.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result?.canceled || !result?.assets?.[0]?.uri) {
        return;
      }

      await stagePickedImage(result.assets[0].uri as string);
    } catch {
      // Never surface picker/resize failures — leave the composer as-is.
    }
  }, [stagePickedImage]);

  const handleCaptureImage = useCallback(async () => {
    const ImagePicker = loadNativeImagePicker();
    if (!ImagePicker || typeof ImagePicker.launchCameraAsync !== 'function') {
      Alert.alert('Update needed', 'Taking a photo needs the latest app version.');
      return;
    }

    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission?.granted === false) {
        Alert.alert('Camera access needed', 'Allow camera access to take a photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result?.canceled || !result?.assets?.[0]?.uri) {
        return;
      }

      await stagePickedImage(result.assets[0].uri as string);
    } catch {
      // Never surface camera/resize failures — leave the composer as-is.
    }
  }, [stagePickedImage]);

  // The "Public" chip matches the design (globe + label + chevron) but privacy
  // is NOT schema-backed: `posts` has no `visibility` column, so there's nothing
  // to persist and no other level to switch to. Rather than ship a dropdown that
  // silently drops a choice, tapping just confirms that posts are public today.
  // Real privacy levels (followers-only, private) would need a `posts.visibility`
  // column plus matching RLS before this can become a functional selector.
  const handlePrivacy = useCallback(() => {
    Alert.alert('Public post', 'Posts are visible to everyone. More privacy options are coming soon.');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canPost) {
      return;
    }
    setSubmitState('submitting');
    try {
      const postId = await createPost({
        body: trimmedBody.length > 0 ? trimmedBody : null,
        // Card attach is no longer a composer affordance; the data layer still
        // accepts a cardId for other callers, so pass an explicit null here.
        cardId: null,
      });
      if (!postId) {
        Alert.alert("Couldn't post", 'Something went wrong. Please try again.');
        // Back to a usable composer: POST re-enables and the discard guard
        // re-arms, because the text really is still unsaved.
        setSubmitState('idle');
        return;
      }

      // Best-effort image upload — the text post already exists, so a failed
      // (or unavailable) media upload only costs the image, never the post.
      if (imageUri) {
        const uploader = spotlightRepository as unknown as PostMediaUploader;
        try {
          if (typeof uploader.uploadPostMedia !== 'function') {
            throw new Error('post media upload unavailable');
          }
          const response = await fetch(imageUri);
          const bytes = await response.arrayBuffer();
          await uploader.uploadPostMedia(postId, bytes);
        } catch {
          Alert.alert(
            'Photo not attached',
            'Your post was published, but the photo could not be attached. You can try adding it again.',
          );
        }
      }

      // Counted after the post really exists, and after the image attempt, so
      // `has_image` describes what was published rather than what was intended.
      capturePostHogEvent('post_created', {
        body_length: trimmedBody.length,
        has_image: imageUri != null,
      });

      signalFeedNeedsRefresh();
      // BEFORE `router.back()`, and terminal: the dismissal takes ~500ms and
      // anything that re-arms the discard guard inside that window resurrects
      // the screen (see the SubmitState note above).
      setSubmitState('posted');
      router.back();
    } catch {
      /*
        NOT optional, and NOT a swap for the `finally` this replaced.

        A throw out of `createPost` (or the signal/navigate below it) used to
        escape into the `void handleSubmit()` at the call site and vanish —
        `finally` was the only thing un-sticking the button, so removing it
        without catching here would strand `submitState` at 'submitting'
        forever: POST permanently disabled AND the discard guard permanently
        disarmed, so the author walks away and loses the post silently. That is
        strictly worse than the bug this change fixes.
      */
      Alert.alert("Couldn't post", 'Something went wrong. Please try again.');
      setSubmitState('idle');
    }
  }, [canPost, imageUri, router, spotlightRepository, trimmedBody]);

  const counterColor = useMemo(
    () =>
      body.length >= BODY_MAX_LENGTH ? theme.colors.dangerStrong : theme.colors.gray600,
    [body.length, theme.colors.dangerStrong, theme.colors.gray600],
  );

  return (
    <View
      /*
        A plain View paying its own safe area, NOT a `SafeAreaView`.

        This was `<SafeAreaView edges={['top','bottom','left','right']}>`, and
        as a full-screen modal on iOS every one of those edges resolved to zero:
        the X button drew over the clock and POST sat inside the keyboard by
        exactly one home-indicator strip. `resolveComposerInsets` documents why
        the native component cannot see a provider from inside a presented view
        controller, and why Android — which reads the window directly — was fine
        throughout.

        `paddingTop` is what holds the header clear of the notch/Dynamic Island;
        `paddingBottom` is the clearance `keyboardLift` subtracts from the
        keyboard height.
      */
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.canvasElevated,
          paddingBottom: safeArea.bottom,
          paddingLeft: safeArea.left,
          paddingRight: safeArea.right,
          paddingTop: safeArea.top,
        },
      ]}
      testID={testID}
    >
      {/*
        A plain View, deliberately. This was a `KeyboardAvoidingView` with
        `behavior={undefined}` — which is a literal passthrough, so it never
        avoided anything — carrying a comment claiming iOS lifts the surface for
        the keyboard by itself. It does not for a full-screen modal, and the same
        file said the opposite a few lines up. The footer's `marginBottom` from
        `keyboardLift` is the ONE mechanism that lifts this screen.
      */}
      <View style={styles.flex}>
        <SheetHeader
          align="center"
          leadingAccessory={
            <IconButton
              accessibilityLabel="Cancel"
              onPress={() => router.back()}
              size={36}
              testID={`${testID}-cancel`}
              variant="subtle"
            >
              <Xmark color={theme.colors.textPrimary} height={20} width={20} />
            </IconButton>
          }
          style={styles.header}
          title="New Post"
          // Figma 3147:10838 — compact 14/600 gray-900 sheet title.
          titleStyle={theme.typography.titleXsmall}
        />

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.authorRow}>
            <Avatar
              initials={authorInitials}
              size={40}
              testID={`${testID}-author-avatar`}
              uri={currentUser?.avatarURL}
            />
            <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
              {authorName}
            </Text>
          </View>

          <TextInput
            maxFontSizeMultiplier={1.3}
            maxLength={BODY_MAX_LENGTH}
            multiline
            onChangeText={setBody}
            placeholder="What's on your mind?"
            placeholderTextColor={theme.colors.gray400}
            // Typed text is 14/500 gray-800; the empty placeholder is 14/400
            // gray-400 — two states in the frames, hence the conditional. RN
            // has no separate placeholder font, so the style swaps with content.
            style={[
              styles.bodyInput,
              // With a photo attached the field stops reserving its full empty
              // height, so the preview sits right under what you typed instead
              // of under the full-height box with one line in it.
              imageUri ? styles.bodyInputWithImage : null,
              body.length > 0 ? theme.typography.bodyMedium : theme.typography.bodySmall,
              {
                backgroundColor: theme.colors.gray50,
                borderRadius: theme.radii.md,
                color: theme.colors.gray800,
              },
            ]}
            testID={`${testID}-body-input`}
            textAlignVertical="top"
            value={body}
          />

          {imageUri ? (
            <View style={styles.imagePreviewWrap} testID={`${testID}-image-preview`}>
              <ExpoImage
                accessibilityIgnoresInvertColors
                contentFit="cover"
                source={{ uri: imageUri }}
                style={[styles.imagePreview, { borderRadius: theme.radii.md, backgroundColor: theme.colors.gray100 }]}
              />
              <Pressable
                accessibilityLabel="Remove image"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setImageUri(null)}
                style={[styles.imageRemove, { backgroundColor: theme.colors.gray900 }]}
                testID={`${testID}-image-remove`}
              >
                <Xmark color={theme.colors.gray0} height={16} width={16} />
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              backgroundColor: theme.colors.canvasElevated,
              borderTopColor: theme.colors.gray100,
              marginBottom: keyboardOverlap,
            },
          ]}
          testID={`${testID}-footer`}
        >
          {/* Character counter sits bottom-right, directly above the control chips. */}
          <View style={styles.counterRow}>
            <Text style={[theme.typography.label, { color: counterColor }]}>
              {body.length}/{BODY_MAX_LENGTH}
            </Text>
          </View>

          <View style={styles.controlRow}>
            <ControlChip
              icon={<Globe color={theme.colors.gray900} height={18} width={18} />}
              label="Public"
              labelColor={theme.colors.gray900}
              onPress={handlePrivacy}
              testID={`${testID}-privacy`}
              trailing={<NavArrowDown color={theme.colors.gray900} height={18} width={18} />}
            />

            {!imageUri ? (
              <>
                <ControlChip
                  icon={<MediaImage color={theme.colors.gray900} height={18} width={18} />}
                  label="Photo"
                  labelColor={theme.colors.gray900}
                  onPress={() => {
                    void handlePickImage();
                  }}
                  testID={`${testID}-add-image`}
                />

                <ControlChip
                  icon={<Camera color={theme.colors.gray900} height={18} width={18} />}
                  label="Camera"
                  labelColor={theme.colors.gray900}
                  onPress={() => {
                    void handleCaptureImage();
                  }}
                  testID={`${testID}-add-camera`}
                />
              </>
            ) : null}
          </View>

          <Button
            disabled={!canPost}
            // 'POSTING…' covers 'posted' too, so the button stays disabled and
            // unpressable for the whole dismissal rather than flicking back to
            // an inviting POST as the screen slides away.
            label={submitState === 'idle' ? 'POST' : 'POSTING…'}
            onPress={() => {
              void handleSubmit();
            }}
            shape="rounded"
            size="md"
            style={styles.postButton}
            testID={`${testID}-submit`}
            variant="dark"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  authorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  bodyInput: {
    // Comfortable target for an empty composer — this is what you tap into.
    minHeight: 120,
    padding: 16,
    paddingTop: 16,
  },
  bodyInputWithImage: {
    // Once there is a preview below, the tall empty field is just a gap. One
    // line's worth keeps the caret stable while the photo moves up to meet it.
    minHeight: 56,
  },
  controlChip: {
    alignItems: 'center',
    // Each chip takes an equal share so the row spans the full width (same 16px
    // side padding as the POST button below), centered — not left-packed.
    flex: 1,
    flexDirection: 'row',
    gap: 4,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  controlRow: {
    flexDirection: 'row',
    gap: 10,
  },
  counterRow: {
    alignItems: 'flex-end',
  },
  flex: {
    flex: 1,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
    paddingBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: {
    // A plain token now the grabber is gone. The old 10 was reverse-engineered
    // from Figma 3147:10814's grabber-at-y=10 stack (paddingTop + a 4pt grabber
    // + a 2pt gap landed the close button at y=16) — arithmetic that only had a
    // meaning while there WAS a grabber, and `gap` had nothing left to space.
    // The header now starts below the real status-bar inset the root View pays
    // (`safeArea.top`), so it takes standard spacing off it.
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  imagePreview: {
    aspectRatio: 4 / 3,
    width: '100%',
  },
  imagePreviewWrap: {
    gap: 8,
    // 16 below the text you typed, not below the field's reserved height.
    marginTop: 16,
  },
  imageRemove: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: 8,
    top: 8,
    width: 28,
  },
  postButton: {
    width: '100%',
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
});
