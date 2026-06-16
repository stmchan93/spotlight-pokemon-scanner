import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  PasswordField,
  PasswordRules,
  PrimaryButton,
} from './auth-controls';
import { buildPasswordRules } from './email-password-screen';

type SetNewPasswordScreenProps = {
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  password: string;
};

export function SetNewPasswordScreen({
  errorMessage,
  isBusy,
  onBack,
  onChangePassword,
  onContinue,
  password,
}: SetNewPasswordScreenProps) {
  const theme = useSpotlightTheme();
  const rules = buildPasswordRules(password);
  const canContinue = rules.every((rule) => rule.satisfied) && !isBusy;

  return (
    <AuthScreenLayout
      backTestID="auth-newpassword-back"
      onBack={onBack}
      testID="auth-set-new-password-screen"
    >
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray0 }]}>Set a new password</Text>
      </View>

      <View style={styles.form}>
        <PasswordField
          onChangeText={onChangePassword}
          placeholder="New password"
          testID="auth-newpassword-input"
          toggleTestID="auth-newpassword-toggle"
          value={password}
        />

        <PasswordRules rules={rules} testID="auth-newpassword-rules" />

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Update password"
          onPress={onContinue}
          testID="auth-newpassword-continue"
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
