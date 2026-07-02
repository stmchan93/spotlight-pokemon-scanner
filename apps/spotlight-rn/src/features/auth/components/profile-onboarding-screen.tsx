import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { type AppUser, getResolvedDisplayName } from '@/features/auth/auth-models';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthErrorLine, PrimaryButton, SecondaryField } from './auth-controls';

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
    <AuthScreenLayout testID="auth-profile-onboarding-screen">
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray900 }]}>Finish your profile</Text>
        <Text style={[styles.subtitle, { color: theme.colors.gray600 }]}>
          Pick the display name other collectors and future marketplace buyers will see.
        </Text>
      </View>

      <View style={styles.form}>
        {user?.email ? (
          <Text style={[styles.signedInAs, { color: theme.colors.gray600 }]}>
            {`Signed in as ${user.email}`}
          </Text>
        ) : null}

        <SecondaryField
          autoCapitalize="words"
          autoCorrect={false}
          onChangeText={onChangeDraftName}
          onSubmitEditing={canContinue ? onSubmit : undefined}
          placeholder={user ? getResolvedDisplayName(user) : 'Your name or table alias'}
          returnKeyType="done"
          testID="auth-profile-input"
          value={profileDraftName}
        />

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onSubmit}
          testID="auth-profile-submit"
        />
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 16,
    marginTop: 24,
  },
  heading: {
    gap: 8,
    marginTop: 8,
  },
  signedInAs: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  subtitle: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 13,
    lineHeight: 18,
  },
  title: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 22,
    lineHeight: 28,
  },
});
