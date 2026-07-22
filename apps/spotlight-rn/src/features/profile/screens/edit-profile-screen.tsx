import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, Check, NavArrowLeft, NavArrowRight } from 'iconoir-react-native';

import { Avatar, Button, Text, useSpotlightTheme } from '@spotlight/design-system';

import { getUserInitials, type ProfileUpdate } from '@/features/auth/auth-models';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

const BIO_MAX_LENGTH = 150;
const COVER_HEIGHT = 150;
const AVATAR_SIZE = 80;

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

export function EditProfileScreen() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const auth = useAuth();
  const user = auth.currentUser;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [socialLink, setSocialLink] = useState(user?.socialLink ?? '');
  const [location, setLocation] = useState(user?.location ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarURL ?? null);
  const [isSaving, setIsSaving] = useState(false);

  const initials = useMemo(() => (user ? getUserInitials(user) : '?'), [user]);

  const handlePickAvatar = useCallback(async () => {
    const ImagePicker = loadImagePicker();
    if (!ImagePicker) {
      Alert.alert('Update needed', 'Changing your photo needs the latest app version.');
      return;
    }
    if (!supabase || !user) {
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
      const path = `${user.id}/avatar.jpg`;

      const uploadResult = await supabase.storage
        .from('avatars')
        .upload(path, data, { contentType: 'image/jpeg', upsert: true });
      if (uploadResult.error) {
        return;
      }

      const publicUrl = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      if (publicUrl) {
        // Cache-bust so the freshly uploaded image replaces the old cached one.
        setAvatarUrl(`${publicUrl}?t=${Date.now()}`);
      }
    } catch {
      // Never surface picker/upload failures to the UI — leave the current avatar.
    }
  }, [user]);

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
  }, [auth, avatarUrl, bio, displayName, isSaving, location, router, socialLink]);

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

              <Text style={[theme.typography.titleMedium, styles.coverTitle]}>Edit Profile</Text>

              <Pressable
                accessibilityLabel="Change cover photo"
                accessibilityRole="button"
                hitSlop={10}
                onPress={handlePickCover}
                style={[styles.circleButton, { backgroundColor: theme.colors.canvasElevated }]}
                testID="edit-profile-cover-camera"
              >
                <Camera color={theme.colors.textPrimary} height={18} width={18} />
              </Pressable>
            </SafeAreaView>
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
                style={[
                  styles.avatarBadge,
                  {
                    backgroundColor: theme.colors.brandStrong,
                    borderColor: theme.colors.canvasElevated,
                  },
                ]}
                testID="edit-profile-avatar-camera"
              >
                <Camera color={theme.colors.gray0} height={14} width={14} />
              </Pressable>
            </View>
          </View>

          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                Profile Name
              </Text>
              <TextInput
                maxFontSizeMultiplier={1.2}
                onChangeText={setDisplayName}
                placeholder="Enter Profile Name"
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.underlineInput,
                  { borderBottomColor: theme.colors.outlineSubtle, color: theme.colors.textPrimary },
                ]}
                testID="edit-profile-name-input"
                value={displayName}
              />
            </View>

            <View style={styles.field}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                Social Link
              </Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                maxFontSizeMultiplier={1.2}
                onChangeText={setSocialLink}
                placeholder="Enter Social Link"
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.underlineInput,
                  { borderBottomColor: theme.colors.outlineSubtle, color: theme.colors.textPrimary },
                ]}
                testID="edit-profile-social-input"
                value={socialLink}
              />
            </View>

            <View style={styles.field}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                Location
              </Text>
              <TextInput
                maxFontSizeMultiplier={1.2}
                onChangeText={setLocation}
                placeholder="Enter Location"
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.underlineInput,
                  { borderBottomColor: theme.colors.outlineSubtle, color: theme.colors.textPrimary },
                ]}
                testID="edit-profile-location-input"
                value={location}
              />
            </View>

            <View style={styles.field}>
              <View style={styles.bioLabelRow}>
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  Bio
                </Text>
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  {bio.length}/{BIO_MAX_LENGTH}
                </Text>
              </View>
              <TextInput
                maxFontSizeMultiplier={1.2}
                maxLength={BIO_MAX_LENGTH}
                multiline
                onChangeText={setBio}
                placeholder="Tell us about you..."
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.bioInput,
                  { borderColor: theme.colors.outlineSubtle, color: theme.colors.textPrimary },
                ]}
                testID="edit-profile-bio-input"
                textAlignVertical="top"
                value={bio}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={handleVerifyPage}
              style={[styles.verifyCard, { borderColor: theme.colors.outlineSubtle }]}
              testID="edit-profile-verify"
            >
              <View style={[styles.verifySeal, { backgroundColor: theme.colors.brandStrong }]}>
                <Check color={theme.colors.gray0} height={14} width={14} />
              </View>
              <Text style={[theme.typography.control, styles.verifyLabel, { color: theme.colors.textPrimary }]}>
                Verify page
              </Text>
              <NavArrowRight color={theme.colors.textSecondary} height={20} width={20} />
            </Pressable>
          </View>

          <View style={styles.actions}>
            <View style={styles.actionButton}>
              <Button
                label="CANCEL"
                onPress={() => router.back()}
                size="lg"
                style={styles.fullWidth}
                testID="edit-profile-cancel"
                variant="outline"
              />
            </View>
            <View style={styles.actionButton}>
              <Button
                disabled={isSaving}
                label={isSaving ? 'SAVING…' : 'SAVE'}
                onPress={() => {
                  void handleSave();
                }}
                size="lg"
                style={styles.fullWidth}
                testID="edit-profile-save"
                variant="dark"
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  avatarBadge: {
    alignItems: 'center',
    borderRadius: 13,
    borderWidth: 2,
    bottom: 0,
    height: 26,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    width: 26,
  },
  avatarRow: {
    marginTop: -AVATAR_SIZE / 2,
    paddingHorizontal: 20,
  },
  avatarWrap: {
    height: AVATAR_SIZE,
    width: AVATAR_SIZE,
  },
  bioInput: {
    borderRadius: 14,
    borderWidth: 1,
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 15,
    lineHeight: 20,
    minHeight: 96,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
  coverBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  coverTitle: {
    color: '#FFFFFF',
  },
  field: {
    gap: 6,
  },
  flex: {
    flex: 1,
  },
  form: {
    gap: 20,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  fullWidth: {
    width: '100%',
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  underlineInput: {
    borderBottomWidth: 1,
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 16,
    paddingBottom: 8,
    paddingTop: 4,
  },
  verifyCard: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  verifyLabel: {
    flex: 1,
  },
  verifySeal: {
    alignItems: 'center',
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
});
