import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Camera, NavArrowLeft, NavArrowRight } from 'iconoir-react-native';

import { Avatar, Button, Text, useSpotlightTheme } from '@spotlight/design-system';

import {
  describeHandleValidity,
  getUserInitials,
  sanitizeHandleInput,
  validateHandle,
  type ProfileUpdate,
} from '@/features/auth/auth-models';
import { isHandleAvailable, ProfileUpdateError } from '@/features/auth/auth-service';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const BIO_MAX_LENGTH = 150;
const HANDLE_CHECK_DEBOUNCE_MS = 400;
const COVER_HEIGHT = 176;
const AVATAR_SIZE = 80;
/** Camera glyph inside the avatar/cover badges (Figma 3083:12761 / 3083:12763). */
const CAMERA_ICON_SIZE = 16;

// expo-image-picker / expo-image-manipulator are native modules that may not be
// present in an OTA-updated JS bundle. Load them defensively so the screen never
// crashes when they're missing from the running binary.
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

type UnderlineFieldProps = {
  label: string;
  value: string;
  placeholder: string;
  onChangeText: (text: string) => void;
  testID?: string;
  /** e.g. the "@" glyph before the handle input. */
  leading?: ReactNode;
  /** Overrides the value color — the social link renders in blue, per the design. */
  valueColor?: string;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
};

/**
 * A floating-underline text field (Figma 3083:9398): a tiny label appears above
 * the value ONLY once the field has content; empty fields show just the
 * placeholder. A hairline underline sits beneath. Matches the Profile Name /
 * Social Link / Location fields exactly (Bio is a separate filled box).
 *
 * The 48px frame is bottom-anchored so the value keeps its centerline whether or
 * not the floating label is showing, which is what stops the row from jumping as
 * you type the first character.
 */
function UnderlineField({
  label,
  value,
  placeholder,
  onChangeText,
  testID,
  leading,
  valueColor,
  autoCapitalize,
  autoCorrect,
}: UnderlineFieldProps) {
  const theme = useSpotlightTheme();
  const hasValue = value.length > 0;
  return (
    <View
      style={[
        styles.field,
        { borderBottomColor: theme.colors.gray400, borderBottomWidth: theme.borderWidths.rule },
      ]}
    >
      {hasValue ? (
        <Text style={[theme.typography.overline, { color: theme.colors.gray500 }]}>
          {label}
        </Text>
      ) : null}
      <View style={styles.fieldInputRow}>
        {leading}
        <TextInput
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          maxFontSizeMultiplier={1.2}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.gray400}
          style={[styles.fieldInput, { color: valueColor ?? theme.colors.gray900 }]}
          testID={testID}
          value={value}
        />
      </View>
    </View>
  );
}

/**
 * The scalloped verified seal (Figma "badge-check" 3095:5501): a solid purple
 * starburst badge with a white check. Reuses iconoir's BadgeCheck vector data,
 * but filled (the icon ships as an outline) to match the design's solid fill.
 */
function VerifiedSeal({ size = 24 }: { size?: number }) {
  const theme = useSpotlightTheme();
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M10.5213 2.62368C11.3147 1.75255 12.6853 1.75255 13.4787 2.62368L14.4989 3.74391C14.8998 4.18418 15.4761 4.42288 16.071 4.39508L17.5845 4.32435C18.7614 4.26934 19.7307 5.23857 19.6757 6.41554L19.6049 7.92905C19.5771 8.52388 19.8158 9.10016 20.2561 9.50111L21.3763 10.5213C22.2475 11.3147 22.2475 12.6853 21.3763 13.4787L20.2561 14.4989C19.8158 14.8998 19.5771 15.4761 19.6049 16.071L19.6757 17.5845C19.7307 18.7614 18.7614 19.7307 17.5845 19.6757L16.071 19.6049C15.4761 19.5771 14.8998 19.8158 14.4989 20.2561L13.4787 21.3763C12.6853 22.2475 11.3147 22.2475 10.5213 21.3763L9.50111 20.2561C9.10016 19.8158 8.52388 19.5771 7.92905 19.6049L6.41553 19.6757C5.23857 19.7307 4.26934 18.7614 4.32435 17.5845L4.39508 16.071C4.42288 15.4761 4.18418 14.8998 3.74391 14.4989L2.62368 13.4787C1.75255 12.6853 1.75255 11.3147 2.62368 10.5213L3.74391 9.50111C4.18418 9.10016 4.42288 8.52388 4.39508 7.92905L4.32435 6.41553C4.26934 5.23857 5.23857 4.26934 6.41554 4.32435L7.92905 4.39508C8.52388 4.42288 9.10016 4.18418 9.50111 3.74391L10.5213 2.62368Z"
        fill={theme.colors.brandStrong}
        stroke={theme.colors.brandStrong}
        strokeWidth={1.5}
      />
      <Path
        d="M9 12L11 14L15 10"
        stroke={theme.colors.gray0}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </Svg>
  );
}

export function EditProfileScreen() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const auth = useAuth();
  const { spotlightRepository } = useAppServices();
  const user = auth.currentUser;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [handle, setHandle] = useState(() => sanitizeHandleInput(user?.handle ?? ''));
  const [socialLink, setSocialLink] = useState(user?.socialLink ?? '');
  const [location, setLocation] = useState(user?.location ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarURL ?? null);
  const [isSaving, setIsSaving] = useState(false);
  const [handleAvailability, setHandleAvailability] =
    useState<'idle' | 'checking' | 'available' | 'taken'>('idle');

  const initials = useMemo(() => (user ? getUserInitials(user) : '?'), [user]);

  const savedHandle = useMemo(() => sanitizeHandleInput(user?.handle ?? ''), [user?.handle]);
  const handleValidity = validateHandle(handle);
  const handleHint = describeHandleValidity(handleValidity);
  // Only the user's own unchanged handle is exempt from the availability check.
  const handleIsUnchanged = handle === savedHandle;

  // Debounced availability probe. The request counter drops stale responses so a
  // slow early check can't overwrite the verdict for what's currently typed.
  const handleCheckSeq = useRef(0);
  useEffect(() => {
    if (!user || handleValidity !== 'ok' || handleIsUnchanged) {
      setHandleAvailability('idle');
      return;
    }

    setHandleAvailability('checking');
    const seq = handleCheckSeq.current + 1;
    handleCheckSeq.current = seq;

    const timer = setTimeout(() => {
      void isHandleAvailable(handle, user.id).then((available) => {
        if (handleCheckSeq.current === seq) {
          setHandleAvailability(available ? 'available' : 'taken');
        }
      });
    }, HANDLE_CHECK_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [handle, handleIsUnchanged, handleValidity, user]);

  const handleStatusText = (() => {
    if (handleHint) {
      return handleHint;
    }
    if (handleAvailability === 'checking') {
      return 'Checking availability…';
    }
    if (handleAvailability === 'available') {
      return `@${handle} is available.`;
    }
    if (handleAvailability === 'taken') {
      return `@${handle} is taken.`;
    }
    return null;
  })();

  const handleStatusIsError = Boolean(handleHint) || handleAvailability === 'taken';
  // An empty handle is fine — profiles stay reachable by user id.
  const canSaveHandle =
    handleValidity === 'empty' || (handleValidity === 'ok' && handleAvailability !== 'taken');

  const handlePickAvatar = useCallback(async () => {
    const ImagePicker = loadImagePicker();
    if (!ImagePicker) {
      Alert.alert('Update needed', 'Changing your photo needs the latest app version.');
      return;
    }
    if (!user) {
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission?.granted === false) {
        Alert.alert('Photos access needed', 'Allow photo access to change your picture.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [1, 1],
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (result?.canceled || !result?.assets?.[0]?.uri) {
        return;
      }

      let uploadUri = result.assets[0].uri as string;
      const ImageManipulator = loadImageManipulator();
      if (ImageManipulator) {
        const manipulated = await ImageManipulator.manipulateAsync(
          uploadUri,
          [{ resize: { width: 512 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (manipulated?.uri) {
          uploadUri = manipulated.uri;
        }
      }

      const response = await fetch(uploadUri);
      const data = await response.arrayBuffer();

      // Upload the resized JPEG to the backend, which stores it in the public
      // GCS avatar bucket and returns the public URL. The object is owner-scoped
      // by the auth header on the backend, so no user id is sent here. (Supabase
      // Storage is no longer involved.)
      const { avatarUrl: publicUrl } = await spotlightRepository.uploadProfileAvatar(data);
      if (publicUrl) {
        // Cache-bust so the freshly uploaded image replaces the old cached one.
        setAvatarUrl(`${publicUrl}?t=${Date.now()}`);
      }
    } catch {
      // Never surface picker/upload failures to the UI — leave the current avatar.
    }
  }, [spotlightRepository, user]);

  const handlePickCover = useCallback(() => {
    // Cover images aren't persisted yet — keep the badge non-crashing.
    Alert.alert('Coming soon', 'Custom cover photos are coming soon.');
  }, []);

  const handleVerifyPage = useCallback(() => {
    Alert.alert('Verification coming soon', 'Page verification is coming soon.');
  }, []);

  const handleSave = useCallback(async () => {
    if (isSaving || !canSaveHandle) {
      return;
    }
    setIsSaving(true);
    try {
      const patch: ProfileUpdate = {
        avatarURL: avatarUrl,
        bio: bio.trim(),
        displayName: displayName.trim(),
        // Clearing the field releases the handle rather than writing ''.
        handle: handle.length > 0 ? handle : null,
        location: location.trim(),
        socialLink: socialLink.trim(),
      };
      await auth.updateProfile(patch);
      router.back();
    } catch (error) {
      if (error instanceof ProfileUpdateError && error.code === 'handle-taken') {
        setHandleAvailability('taken');
        Alert.alert('Handle taken', `@${handle} was just claimed. Try another one.`);
        return;
      }
      Alert.alert('Could not save', 'Something went wrong saving your profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [
    auth,
    avatarUrl,
    bio,
    canSaveHandle,
    displayName,
    handle,
    isSaving,
    location,
    router,
    socialLink,
  ]);

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Banner: full-bleed cover with a centered title, a back control on the
              left, and a cover-photo camera badge pinned to the bottom-right —
              mirroring the Figma "Banner Section". */}
          <View style={[styles.cover, { backgroundColor: theme.colors.surfaceMuted }]}>
            <SafeAreaView edges={['top']} style={styles.coverBar}>
              <Pressable
                accessibilityLabel="Go back"
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => router.back()}
                style={[styles.circleButton, { backgroundColor: theme.colors.canvasElevated }]}
                testID="edit-profile-back"
              >
                <NavArrowLeft color={theme.colors.textPrimary} height={20} width={20} />
              </Pressable>
            </SafeAreaView>

            <Pressable
              accessibilityLabel="Change cover photo"
              accessibilityRole="button"
              hitSlop={8}
              onPress={handlePickCover}
              style={[styles.coverCameraBadge, { backgroundColor: theme.colors.gray0 }]}
              testID="edit-profile-cover-camera"
            >
              <Camera color={theme.colors.gray900} height={CAMERA_ICON_SIZE} width={CAMERA_ICON_SIZE} />
            </Pressable>
          </View>

          <View style={styles.avatarRow}>
            <View style={styles.avatarWrap}>
              <Avatar initials={initials} ring size={AVATAR_SIZE} uri={avatarUrl} />
              <Pressable
                accessibilityLabel="Change profile photo"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  void handlePickAvatar();
                }}
                style={[styles.avatarBadge, { backgroundColor: theme.colors.gray0 }]}
                testID="edit-profile-avatar-camera"
              >
                <Camera color={theme.colors.gray900} height={CAMERA_ICON_SIZE} width={CAMERA_ICON_SIZE} />
              </Pressable>
            </View>
          </View>

          <View style={styles.form}>
            <UnderlineField
              label="Profile Name"
              onChangeText={setDisplayName}
              placeholder="Enter Profile Name"
              testID="edit-profile-name-input"
              value={displayName}
            />

            {/* Handle isn't in the 3095:5517 mock, but it's the Phase-2 handle
                claim — kept here, styled to match the other underline fields. */}
            <View style={styles.handleField}>
              <UnderlineField
                autoCapitalize="none"
                autoCorrect={false}
                label="Handle"
                leading={
                  // Must NOT reuse styles.fieldInput — that carries flex:1, so the
                  // "@" stretched to half the row and pushed the input across.
                  <Text style={[styles.fieldPrefix, { color: theme.colors.gray900 }]}>@</Text>
                }
                onChangeText={(next) => setHandle(sanitizeHandleInput(next))}
                placeholder="yourhandle"
                testID="edit-profile-handle-input"
                value={handle}
              />
              {/* Only real feedback renders — availability, or an error. There is
                  no idle "Optional…" hint, so the field sits flush with the rest
                  of the form until you actually type. */}
              {handleStatusText ? (
                <Text
                  style={[
                    theme.typography.caption,
                    {
                      // dangerStrong, not danger: caption-size error text needs the
                      // darker red to stay legible on the light form background.
                      color: handleStatusIsError
                        ? theme.colors.dangerStrong
                        : theme.colors.gray500,
                    },
                  ]}
                  testID="edit-profile-handle-status"
                >
                  {handleStatusText}
                </Text>
              ) : null}
            </View>

            <UnderlineField
              autoCapitalize="none"
              autoCorrect={false}
              label="Social Link"
              onChangeText={setSocialLink}
              placeholder="Enter Social Link"
              testID="edit-profile-social-input"
              // Social link value renders in blue, per the design.
              valueColor={theme.colors.blue400}
              value={socialLink}
            />

            <UnderlineField
              label="Location"
              onChangeText={setLocation}
              placeholder="Enter Location"
              testID="edit-profile-location-input"
              value={location}
            />

            <View style={styles.bioField}>
              <View style={styles.bioLabelRow}>
                {/* The Bio row sits at 12px, unlike the 11px floating labels on
                    the underline fields above (Figma "Bio Info"). */}
                <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
                  Bio
                </Text>
                <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
                  {bio.length}/{BIO_MAX_LENGTH}
                </Text>
              </View>
              <TextInput
                maxFontSizeMultiplier={1.2}
                maxLength={BIO_MAX_LENGTH}
                multiline
                onChangeText={setBio}
                placeholder="Tell us about you..."
                placeholderTextColor={theme.colors.gray400}
                style={[
                  styles.bioInput,
                  {
                    // Figma "Bio Text Container" (3083:12773): a flat gray100
                    // fill, no border, with gray body text.
                    backgroundColor: theme.colors.gray100,
                    color: theme.colors.gray700,
                  },
                ]}
                testID="edit-profile-bio-input"
                textAlignVertical="top"
                value={bio}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={handleVerifyPage}
              style={[
                styles.verifyCard,
                {
                  backgroundColor: theme.colors.gray0,
                  borderColor: theme.colors.gray400,
                  borderWidth: theme.borderWidths.rule,
                },
              ]}
              testID="edit-profile-verify"
            >
              <View style={styles.verifyBadge}>
                <VerifiedSeal size={24} />
                <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>
                  Verify page
                </Text>
              </View>
              <NavArrowRight color={theme.colors.gray900} height={24} width={24} />
            </Pressable>
          </View>
        </ScrollView>

        {/* Footer actions stay pinned above the keyboard/home indicator, matching
            the Figma "Dropdown Handle" footer that hosts Cancel / Save. */}
        <View
          style={[
            styles.actions,
            {
              backgroundColor: theme.colors.canvas,
              borderTopColor: theme.colors.outlineSubtle,
            },
          ]}
        >
          <View style={styles.actionButton}>
            <Button
              label="CANCEL"
              labelStyleVariant="label"
              onPress={() => router.back()}
              shape="rounded"
              size="xs"
              style={styles.fullWidth}
              testID="edit-profile-cancel"
              variant="outline"
            />
          </View>
          <View style={styles.actionButton}>
            <Button
              disabled={isSaving || !canSaveHandle}
              label={isSaving ? 'SAVING…' : 'SAVE'}
              labelStyleVariant="label"
              onPress={() => {
                void handleSave();
              }}
              shape="rounded"
              size="xs"
              style={styles.fullWidth}
              testID="edit-profile-save"
              variant="dark"
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actions: {
    // Figma 3083:12784 — 10px between the two actions, 16px gutter, 10px above.
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  avatarBadge: {
    // Figma 3083:12761 — matches the cover badge: gray50 circle, black glyph.
    alignItems: 'center',
    borderRadius: 14,
    bottom: -2,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: -2,
    width: 28,
  },
  avatarRow: {
    marginTop: -AVATAR_SIZE / 2,
    paddingHorizontal: 20,
  },
  avatarWrap: {
    height: AVATAR_SIZE,
    width: AVATAR_SIZE,
  },
  bioField: {
    // Figma "Bio Container" gap.
    gap: 6,
  },
  bioInput: {
    // Figma "Bio Text Container": radius 8, even 16 padding, 104 tall, 14px
    // Regular body on a flat fill (no border).
    borderRadius: 8,
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 14,
    lineHeight: 20,
    minHeight: 104,
    padding: 16,
  },
  bioLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  circleButton: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  cover: {
    height: COVER_HEIGHT,
    width: '100%',
  },
  field: {
    // 48px frame per Figma 3083:9398, bottom-anchored: the label's baseline lands
    // 14px from the top and the value keeps its 33px centerline either way.
    gap: 9,
    height: 48,
    justifyContent: 'flex-end',
    paddingBottom: 5,
  },
  fieldInput: {
    flex: 1,
    fontFamily: 'SpotlightBodyRegular',
    // 14px Regular — Figma's "Body" role. Was 16, which is what made every value
    // on this form read a size too large.
    fontSize: 14,
    paddingVertical: 0,
  },
  fieldInputRow: {
    // The "@" prefix must hug the handle — no gap between glyph and input.
    alignItems: 'center',
    flexDirection: 'row',
    gap: 0,
  },
  fieldPrefix: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 14,
  },
  coverBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  coverCameraBadge: {
    // Figma 3083:12763 — a plain gray50 circle, no ring. Was a purple fill with a
    // 2px border and a white glyph.
    alignItems: 'center',
    borderRadius: 14,
    bottom: 12,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    width: 28,
  },
  flex: {
    flex: 1,
  },
  form: {
    // Figma 3083:9397 — 24px between fields on the standard 16px page gutter.
    gap: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  fullWidth: {
    width: '100%',
  },
  handleField: {
    gap: 6,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  verifyCard: {
    // Figma 3095:5499 — white card on a 0.5px gray400 hairline, radius 8, even
    // 12 padding, badge left / chevron right.
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
  },
  verifyBadge: {
    // Figma 3095:5499 — seal + 13px label sit together on the left, chevron right.
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
});
