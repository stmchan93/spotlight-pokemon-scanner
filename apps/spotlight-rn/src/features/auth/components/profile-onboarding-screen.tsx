import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { type AppUser, getResolvedDisplayName } from '@/features/auth/auth-models';

type ProfileOnboardingScreenProps = {
  errorMessage: string | null;
  isBusy: boolean;
  onChangeDraftName: (value: string) => void;
  onSubmit: () => void;
  profileDraftName: string;
  user: AppUser | null;
};

export function ProfileOnboardingScreen({
  errorMessage,
  isBusy,
  onChangeDraftName,
  onSubmit,
  profileDraftName,
  user,
}: ProfileOnboardingScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = profileDraftName.trim().length > 0 && !isBusy;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.canvas,
        },
      ]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardShell}
      >
        <View style={styles.shell}>
          <View style={styles.header}>
            <Text style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
              Finish your profile
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              Pick the display name other collectors and future marketplace buyers will see.
            </Text>
          </View>

          <SurfaceCard padding={20} radius={28}>
            <View style={styles.form}>
              {user?.email ? (
                <View style={styles.signedInAs}>
                  <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                    Signed in as
                  </Text>
                  <Text style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>
                    {user.email}
                  </Text>
                </View>
              ) : null}

              <View style={styles.fieldWrap}>
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  Display name
                </Text>
                <TextInput
                  autoCapitalize="words"
                  autoCorrect={false}
                  onChangeText={onChangeDraftName}
                  onSubmitEditing={() => {
                    if (canContinue) {
                      onSubmit();
                    }
                  }}
                  placeholder={user ? getResolvedDisplayName(user) : 'Your name or table alias'}
                  placeholderTextColor="rgba(77, 79, 87, 0.48)"
                  returnKeyType="done"
                  style={[
                    theme.typography.bodyStrong,
                    styles.input,
                    {
                      backgroundColor: theme.colors.field,
                      borderColor: theme.colors.outlineSubtle,
                      color: theme.colors.textPrimary,
                    },
                  ]}
                  testID="auth-profile-input"
                  value={profileDraftName}
                />
              </View>

              {errorMessage ? (
                <Text style={[theme.typography.body, { color: theme.colors.danger }]}>
                  {errorMessage}
                </Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={!canContinue}
                onPress={onSubmit}
                style={[
                  styles.continueButton,
                  {
                    backgroundColor: theme.colors.brand,
                    opacity: canContinue ? 1 : 0.55,
                  },
                ]}
                testID="auth-profile-submit"
              >
                <Text style={[theme.typography.control, { color: theme.colors.textPrimary }]}>
                  Continue
                </Text>
              </Pressable>
            </View>
          </SurfaceCard>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  continueButton: {
    alignItems: 'center',
    borderRadius: 18,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
  },
  fieldWrap: {
    gap: 8,
  },
  form: {
    gap: 18,
  },
  header: {
    gap: 10,
  },
  input: {
    borderRadius: 18,
    borderWidth: 1,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  keyboardShell: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  shell: {
    flex: 1,
    gap: 24,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  signedInAs: {
    gap: 4,
  },
});
