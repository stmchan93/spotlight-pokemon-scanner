import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Camera, NavArrowLeft, NavArrowRight } from 'iconoir-react-native';

import { Avatar, Button, Text, useSpotlightTheme } from '@spotlight/design-system';

import {
  getUserInitials,
  type ProfileUpdate,
} from '@/features/auth/auth-models';
import { loadNativeImagePicker } from '@/lib/native-image-picker';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const BIO_MAX_LENGTH = 150;
const COVER_HEIGHT = 176;
const AVATAR_SIZE = 80;
/** Camera glyph inside the avatar/cover badges (Figma 3083:12761 / 3083:12763). */
const CAMERA_ICON_SIZE = 16;

// expo-image-picker / expo-image-manipulator are native modules that may not be
// present in the binary an OTA-updated JS bundle is running on. The picker goes
// through `loadNativeImagePicker`, which probes the NATIVE registry — requiring
// the JS alone succeeds even when the native half is absent, and the first call
// then takes the app down instead of failing softly.
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
  /** Optional glyph rendered before the input. */
  leading?: ReactNode;
  /** Overrides the value color — the social link renders in blue, per the design. */
  valueColor?: string;
  /**
   * Overrides the value's type. The social link is 13px Medium rather than the
   * 14px Regular the other fields use (Figma 3083:9399).
   */
  valueStyle?: TextInputProps['style'];
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
  valueStyle,
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
          style={[styles.fieldInput, { color: valueColor ?? theme.colors.gray900 }, valueStyle]}
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
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const { spotlightRepository } = useAppServices();
  const user = auth.currentUser;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [socialLink, setSocialLink] = useState(user?.socialLink ?? '');
  const [location, setLocation] = useState(user?.location ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarURL ?? null);
  const [isSaving, setIsSaving] = useState(false);

  const initials = useMemo(() => (user ? getUserInitials(user) : '?'), [user]);

  const handlePickAvatar = useCallback(async () => {
    const ImagePicker = loadNativeImagePicker();
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
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      // `handle` is deliberately NOT in the patch. The field was removed from
      // this form, and `updateProfile` only writes keys that are present
      // (`if (patch.handle !== undefined)`), so omitting it leaves whatever
      // handle the account already owns intact. Sending `null` here would
      // release the handle on every save.
      const patch: ProfileUpdate = {
        avatarURL: avatarUrl,
        bio: bio.trim(),
        displayName: displayName.trim(),
        location: location.trim(),
        socialLink: socialLink.trim(),
      };
      await auth.updateProfile(patch);
      router.back();
    } catch {
      Alert.alert('Could not save', 'Something went wrong saving your profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [
    auth,
    avatarUrl,
    bio,
    displayName,
    isSaving,
    location,
    router,
    socialLink,
  ]);

  return (
    <SafeAreaView
      // No 'bottom' edge — the sticky action bar owns the bottom inset itself,
      // exactly like the PDP footer. Keeping both double-padded the home bar.
      edges={['left', 'right']}
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

              {/* Figma 3083:12783 — "Edit Profile", 14/600 in gray/0, centered on
                  the SCREEN rather than on the space left over beside the back
                  button. A flexible title between two equal 36pt slots centers it
                  exactly; the trailing slot is an empty spacer, not a control. */}
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.titleXsmall,
                  styles.coverTitle,
                  { color: theme.colors.gray0 },
                ]}
                testID="edit-profile-title"
              >
                Edit Profile
              </Text>
              <View style={styles.coverBarSpacer} />
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

            <UnderlineField
              autoCapitalize="none"
              autoCorrect={false}
              label="Social Link"
              onChangeText={setSocialLink}
              placeholder="Enter Social Link"
              testID="edit-profile-social-input"
              // Social link value renders in blue 13px Medium, per Figma 3083:9399.
              valueColor={theme.colors.blue400}
              valueStyle={styles.fieldInputLink}
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

      </KeyboardAvoidingView>

      {/* Sticky action bar — same treatment as the PDP's ADD ITEM / SHARE bar:
          absolutely pinned to the bottom OUTSIDE the keyboard avoider, padded by
          the safe-area inset. Keeping it inside KeyboardAvoidingView made it ride
          up and sit flush on top of the keyboard with no bottom inset. */}
      <View
        style={[
          styles.actions,
          {
            backgroundColor: theme.colors.gray0,
            borderTopColor: theme.colors.outlineSubtle,
            paddingBottom: insets.bottom + 8,
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
              disabled={isSaving}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actions: {
    // Mirrors the PDP sticky footer (card-detail-screen `stickyFooter` +
    // `actionBar`): absolutely pinned, elevated above the scroll content, 16px
    // gutter and 10px above the buttons. Bottom padding is applied inline from
    // the safe-area inset.
    borderTopWidth: 1,
    bottom: 0,
    elevation: 10,
    flexDirection: 'row',
    gap: 12,
    left: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    position: 'absolute',
    right: 0,
    zIndex: 10,
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
  fieldInputLink: {
    // Social link value: 13px Medium (Figma 3083:9399), not the 14px Regular the
    // other field values use.
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
  },
  coverBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  // Mirrors `circleButton`'s 36pt width so the flexible title between them lands
  // on the screen's centerline instead of being pushed right by the back button.
  coverBarSpacer: {
    height: 36,
    width: 36,
  },
  coverTitle: {
    flex: 1,
    textAlign: 'center',
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
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    // Clears the absolutely-pinned action bar (32px buttons + 10 top + ~8 inset)
    // so the Verify row can still be scrolled clear of it.
    paddingBottom: 96,
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
