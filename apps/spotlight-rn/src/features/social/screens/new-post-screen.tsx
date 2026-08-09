import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, Globe, MediaImage, NavArrowDown, Xmark } from 'iconoir-react-native';

import { Avatar, Button, IconButton, SheetHeader, Text, useSpotlightTheme } from '@spotlight/design-system';

import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
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
// The composer is a pushed stack screen over the still-mounted feed. Rather than
// reload the feed on every focus (returning from a PDP shouldn't refetch), the
// composer flips this one-shot flag on a successful post; the feed consumes it
// on focus and reloads only then.
let feedNeedsRefresh = false;

/** Mark the feed as needing a reload the next time it regains focus. */
export function signalFeedNeedsRefresh(): void {
  feedNeedsRefresh = true;
}

/** Read-and-clear the feed-refresh flag. Returns true once per signalled post. */
export function consumeFeedRefreshSignal(): boolean {
  const pending = feedNeedsRefresh;
  feedNeedsRefresh = false;
  return pending;
}

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
 * Figma New Post sheet (gray/100 fill, radius-8, 40pt tall, an 18pt icon + a
 * 13pt Label). Used for the Public / Photo / Camera controls. The icon and
 * label colors are passed in so the active "Public" chip can render darker than
 * the Photo/Camera actions, matching the design.
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
          backgroundColor: theme.colors.gray100,
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
 * New Post composer (Phase 3c). Restyled to match the Figma "New Post" bottom
 * sheet: a drag handle + close + centered title, the author's avatar/name, a
 * multiline body ("What's on your mind?"), a row of three filled "Post Controls"
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
  // The sheet's own SafeAreaView already holds the footer this far off the
  // screen's bottom edge, so it is that much of the keyboard we do NOT re-pay.
  const insets = useSafeAreaInsets();

  const [body, setBody] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

    So compute it instead. The footer is the bottom-most thing in a sheet that
    reaches the screen's bottom edge, and `SafeAreaView` already pads it clear of
    the home indicator, so clearing a keyboard of height K needs exactly
    `K - insets.bottom`. No feedback loop, nothing to converge, and it is right
    on the first frame.

    This assumes UIKit does NOT lift the sheet for the keyboard. It does not:
    the whole reason this bug exists is that the form sheet stays put and the
    keyboard covers its bottom. (An earlier note claimed the opposite and used it
    to justify opting iOS out of `KeyboardAvoidingView` entirely — that claim was
    what left the controls buried in the first place.)

    `keyboardWillChangeFrame` carries every height change, including the ones
    `keyboardDidShow` misses, and its `will` phase means the footer travels with
    the keyboard's own animation instead of snapping after it.
  */
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // iOS-only: on Android the window itself resizes (adjustResize), which the
    // `KeyboardAvoidingView` below already handles — adding this there would
    // lift the footer a second keyboard's worth.
    if (Platform.OS !== 'ios') {
      return;
    }
    const changeSub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const screenHeight = Dimensions.get('window').height;
      const top = event.endCoordinates?.screenY ?? screenHeight;
      // Derived from the keyboard's TOP rather than read from `height`: a
      // dismissing keyboard reports its full height with a top that is already
      // off-screen, which would keep the footer floating after it left.
      setKeyboardHeight(Math.max(0, screenHeight - top));
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', () => setKeyboardHeight(0));
    return () => {
      changeSub.remove();
      hideSub.remove();
    };
  }, []);

  const keyboardOverlap = Math.max(0, keyboardHeight - insets.bottom);

  const trimmedBody = body.trim();
  const canPost = !isSubmitting && trimmedBody.length > 0;

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
    setIsSubmitting(true);
    try {
      const postId = await createPost({
        body: trimmedBody.length > 0 ? trimmedBody : null,
        // Card attach is no longer a composer affordance; the data layer still
        // accepts a cardId for other callers, so pass an explicit null here.
        cardId: null,
      });
      if (!postId) {
        Alert.alert("Couldn't post", 'Something went wrong. Please try again.');
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

      signalFeedNeedsRefresh();
      router.back();
    } finally {
      setIsSubmitting(false);
    }
  }, [canPost, imageUri, router, spotlightRepository, trimmedBody]);

  const counterColor = useMemo(
    () =>
      body.length >= BODY_MAX_LENGTH ? theme.colors.dangerStrong : theme.colors.textSecondary,
    [body.length, theme.colors.dangerStrong, theme.colors.textSecondary],
  );

  return (
    <SafeAreaView
      // KEEP the 'top' edge. `SafeAreaView` here is the native
      // react-native-safe-area-context view, which measures the inset from its
      // OWN frame rather than the window: presented as a form sheet its top
      // edge sits ~65pt down, clear of the notch, so the inset resolves to 0 and
      // costs nothing. Dropping 'top' as "the sheet handles it" is what left the
      // close button jammed under the status bar when the sheet silently failed
      // to present — this edge is the fail-safe that keeps the header reachable
      // even if the composer ever renders full-screen again.
      edges={['top', 'bottom', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvasElevated }]}
      testID={testID}
    >
      <KeyboardAvoidingView
        // iOS moves a form sheet up for the keyboard by itself. Adding
        // `padding` on top of that double-counts the keyboard height and lifts
        // the POST button off the sheet, so iOS opts out here and only Android
        // (where the window resizes instead) gets explicit handling.
        behavior={Platform.OS === 'android' ? 'height' : undefined}
        style={styles.flex}
      >
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
          showHandle
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
            placeholderTextColor={theme.colors.gray600}
            // Body copy is regular 14 / gray-800 (Figma 3147:10825).
            // `body` straight through, with NO fontSize override. It carried
            // `fontSize: 14` on top of the token, so you composed at 14 and the
            // post then published at 15 — what you typed was never the size of
            // what you got. The literal was also exactly the kind of one-off the
            // design-system rule exists to keep out of screens.
            style={[styles.bodyInput, theme.typography.body, { color: theme.colors.gray800 }]}
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
            <Text style={[theme.typography.caption, { color: counterColor }]}>
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
                  icon={<MediaImage color={theme.colors.gray700} height={18} width={18} />}
                  label="Photo"
                  labelColor={theme.colors.gray700}
                  onPress={() => {
                    void handlePickImage();
                  }}
                  testID={`${testID}-add-image`}
                />

                <ControlChip
                  icon={<Camera color={theme.colors.gray700} height={18} width={18} />}
                  label="Camera"
                  labelColor={theme.colors.gray700}
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
            label={isSubmitting ? 'POSTING…' : 'POST'}
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
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    minHeight: 96,
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
    gap: 8,
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
    // Figma 3147:10814 measured from the SHEET's top edge, not the screen's:
    // grabber at y=10 (paddingTop), close button at y=16. SheetHeader stacks
    // paddingTop + the 4pt grabber + `gap`, so 10 + 4 + 2 puts the 36pt button
    // at 16 and its centre at 34 — level with the "New Post" title's centre at
    // 35. The default 14pt gap pushed the button 12pt below where it belongs.
    gap: 2,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  imagePreview: {
    aspectRatio: 4 / 3,
    width: '100%',
  },
  imagePreviewWrap: {
    gap: 8,
    marginTop: 12,
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
