import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MediaImage, Plus, Xmark } from 'iconoir-react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { Avatar, Button, IconButton, SheetHeader, Text, useSpotlightTheme } from '@spotlight/design-system';

import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { createPost } from '@/features/social/social-service';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

// Max post length. Mirrors the backend `posts.body` guard; the counter warns as
// the author approaches it and `maxLength` hard-stops at it.
const BODY_MAX_LENGTH = 500;

// Post images are downscaled to this width before upload — enough for a
// full-bleed feed image without shipping a multi-megabyte original.
const POST_IMAGE_WIDTH = 1080;

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
// absent from an OTA-updated JS bundle. Load them defensively (exactly like
// edit-profile-screen) so the composer never crashes when they're missing.
function loadImagePicker() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker');
  } catch {
    return null;
  }
}

function loadImageManipulator() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-manipulator');
  } catch {
    return null;
  }
}

type AttachedCard = {
  cardId: string;
  name: string;
  imageUrl: string | null;
};

/**
 * A filled composer affordance pill — the gray "Post Controls" chips from the
 * Figma New Post sheet (gray/100 fill, radius-8, 40pt tall, an 18pt icon + a
 * 13pt Label). Used for the "Add card" / "Add photo" actions.
 */
function ControlChip({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  testID: string;
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
      <Text style={[theme.typography.label, { color: theme.colors.textPrimary }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * New Post composer (Phase 3c). Restyled to match the Figma "Post flow" bottom
 * sheet: a drag handle + close + centered title, the author's avatar/name, a
 * multiline body, filled "Post Controls" chips for the optional attachments
 * (card picked via the catalog search modal, image picked + downscaled to a
 * ~1080px JPEG), and a full-width dark POST button pinned to the bottom.
 *
 * Submit inserts the text/card post via `createPost`, then best-effort uploads
 * the image to the post-media endpoint — a failed image upload leaves the text
 * post intact. Every native dependency is loaded defensively so the screen
 * never crashes.
 */
export function NewPostScreen({ testID = 'new-post' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { currentUser } = useAuth();

  const [body, setBody] = useState('');
  const [attachedCard, setAttachedCard] = useState<AttachedCard | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [isCardPickerOpen, setIsCardPickerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmedBody = body.trim();
  const canPost = !isSubmitting && (trimmedBody.length > 0 || attachedCard !== null);

  const authorName = currentUser ? getResolvedDisplayName(currentUser) : 'Collector';
  const authorInitials = currentUser ? getUserInitials(currentUser) : 'C';

  const handleAttachCard = useCallback((result: CatalogSearchResult) => {
    setAttachedCard({
      cardId: result.cardId,
      name: result.name,
      imageUrl: result.smallImageUrl ?? result.imageUrl ?? null,
    });
    setIsCardPickerOpen(false);
  }, []);

  const handlePickImage = useCallback(async () => {
    const ImagePicker = loadImagePicker();
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

      let uri = result.assets[0].uri as string;
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
    } catch {
      // Never surface picker/resize failures — leave the composer as-is.
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canPost) {
      return;
    }
    setIsSubmitting(true);
    try {
      const postId = await createPost({
        body: trimmedBody.length > 0 ? trimmedBody : null,
        cardId: attachedCard?.cardId ?? null,
      });
      if (!postId) {
        Alert.alert("Couldn't post", 'Something went wrong. Please try again.');
        return;
      }

      // Best-effort image upload — the text/card post already exists, so a failed
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
  }, [attachedCard, canPost, imageUri, router, spotlightRepository, trimmedBody]);

  const counterColor = useMemo(
    () =>
      body.length >= BODY_MAX_LENGTH ? theme.colors.dangerStrong : theme.colors.textSecondary,
    [body.length, theme.colors.dangerStrong, theme.colors.textSecondary],
  );

  return (
    <SafeAreaView
      edges={['top', 'bottom', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvasElevated }]}
      testID={testID}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
          titleStyleVariant="titleCompact"
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
            autoFocus
            maxFontSizeMultiplier={1.3}
            maxLength={BODY_MAX_LENGTH}
            multiline
            onChangeText={setBody}
            placeholder="Share something with collectors…"
            placeholderTextColor={theme.colors.gray400}
            style={[styles.bodyInput, theme.typography.body, { color: theme.colors.gray800 }]}
            testID={`${testID}-body-input`}
            textAlignVertical="top"
            value={body}
          />

          <View style={styles.counterRow}>
            <Text style={[theme.typography.caption, { color: counterColor }]}>
              {body.length}/{BODY_MAX_LENGTH}
            </Text>
          </View>

          {attachedCard ? (
            <View
              style={[
                styles.cardChip,
                {
                  backgroundColor: theme.colors.gray50,
                  borderColor: theme.colors.gray200,
                  borderRadius: theme.radii.md,
                },
              ]}
              testID={`${testID}-card-chip`}
            >
              {attachedCard.imageUrl ? (
                <ExpoImage
                  accessibilityIgnoresInvertColors
                  contentFit="contain"
                  source={{ uri: attachedCard.imageUrl }}
                  style={[styles.cardThumb, { backgroundColor: theme.colors.field }]}
                />
              ) : null}
              <Text
                numberOfLines={2}
                style={[styles.cardChipLabel, theme.typography.captionMedium, { color: theme.colors.textPrimary }]}
              >
                {attachedCard.name}
              </Text>
              <Pressable
                accessibilityLabel="Remove attached card"
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => setAttachedCard(null)}
                testID={`${testID}-card-remove`}
              >
                <Xmark color={theme.colors.textSecondary} height={18} width={18} />
              </Pressable>
            </View>
          ) : null}

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
              <Text style={[theme.typography.caption, styles.moderationNote, { color: theme.colors.textSecondary }]}>
                Your photo is reviewed before others can see it — it shows on your post right away.
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.footer,
            { backgroundColor: theme.colors.canvasElevated, borderTopColor: theme.colors.gray100 },
          ]}
        >
          {!attachedCard || !imageUri ? (
            <View style={styles.controlRow}>
              {!attachedCard ? (
                <ControlChip
                  icon={<Plus color={theme.colors.textPrimary} height={18} width={18} />}
                  label="Add card"
                  onPress={() => setIsCardPickerOpen(true)}
                  testID={`${testID}-add-card`}
                />
              ) : null}

              {!imageUri ? (
                <ControlChip
                  icon={<MediaImage color={theme.colors.textPrimary} height={18} width={18} />}
                  label="Add photo"
                  onPress={() => {
                    void handlePickImage();
                  }}
                  testID={`${testID}-add-image`}
                />
              ) : null}
            </View>
          ) : null}

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

      <Modal
        animationType="slide"
        onRequestClose={() => setIsCardPickerOpen(false)}
        presentationStyle="fullScreen"
        visible={isCardPickerOpen}
      >
        <CatalogSearchScreen
          onClose={() => setIsCardPickerOpen(false)}
          onOpenCard={handleAttachCard}
        />
      </Modal>
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
  cardChip: {
    alignItems: 'center',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    padding: 10,
  },
  cardChipLabel: {
    flex: 1,
  },
  cardThumb: {
    borderRadius: 6,
    height: 48,
    width: 34,
  },
  controlChip: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  controlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  counterRow: {
    alignItems: 'flex-end',
    marginTop: 6,
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
  moderationNote: {
    marginTop: 2,
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
