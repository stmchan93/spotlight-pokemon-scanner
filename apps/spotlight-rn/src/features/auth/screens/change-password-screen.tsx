import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from '@/features/auth/components/auth-screen-layout';
import {
  AuthErrorLine,
  PasswordField,
  PasswordRules,
  PrimaryButton,
  buildPasswordRules,
} from '@/features/auth/components/auth-controls';
import { useAuth } from '@/providers/auth-provider';

/**
 * In-app "Change password" for an already-signed-in user. Reuses the reset
 * flow's UI/UX (the light auth layout + shared password controls and rules from
 * `set-new-password-screen`) and the same `auth.updatePassword` action —
 * Supabase's `updateUser` accepts a new password on a live session, so no email
 * round-trip is needed here.
 */
export function ChangePasswordScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const auth = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');

  const rules = buildPasswordRules(password);
  const canContinue =
    currentPassword.length > 0 && rules.every((rule) => rule.satisfied) && !auth.isBusy;

  const handleSubmit = useCallback(() => {
    if (!canContinue) {
      return;
    }
    void auth
      .updatePassword(password, currentPassword)
      .then(() => {
        Alert.alert('Password updated', 'Your password has been changed.');
        router.back();
      })
      .catch(() => {
        // Failure message is surfaced inline via auth.errorMessage.
      });
  }, [auth, canContinue, currentPassword, password, router]);

  return (
    <AuthScreenLayout
      backTestID="change-password-back"
      onBack={() => router.back()}
      testID="change-password-screen"
    >
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray900 }]}>Change password</Text>
      </View>

      <View style={styles.form}>
        <PasswordField
          onChangeText={setCurrentPassword}
          placeholder="Current password"
          testID="change-password-current-input"
          toggleTestID="change-password-current-toggle"
          value={currentPassword}
        />

        <PasswordField
          onChangeText={setPassword}
          placeholder="New password"
          testID="change-password-input"
          toggleTestID="change-password-toggle"
          value={password}
        />

        <PasswordRules rules={rules} testID="change-password-rules" />

        {auth.errorMessage ? <AuthErrorLine message={auth.errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Update password"
          onPress={handleSubmit}
          testID="change-password-continue"
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
  title: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 22,
    lineHeight: 28,
  },
});
