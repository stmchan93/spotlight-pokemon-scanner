import { StyleSheet, View } from 'react-native';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  AuthSectionTitle,
  PasswordField,
  PasswordRules,
  PrimaryButton,
  TermsFooter,
  buildPasswordRules,
} from './auth-controls';

type SetNewPasswordScreenProps = {
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  password: string;
};

/**
 * Final password-reset step (light theme, matches Figma 2170:7283's system):
 * "NEW PASSWORD" title, the password underline field with the strength
 * checklist, and a black Update button.
 */
export function SetNewPasswordScreen({
  errorMessage,
  isBusy,
  onBack,
  onChangePassword,
  onContinue,
  password,
}: SetNewPasswordScreenProps) {
  const rules = buildPasswordRules(password);
  const canContinue = rules.every((rule) => rule.satisfied) && !isBusy;

  return (
    <AuthScreenLayout
      backTestID="auth-newpassword-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-set-new-password-screen"
    >
      <AuthSectionTitle>NEW PASSWORD</AuthSectionTitle>

      <View style={styles.fields}>
        <PasswordField
          label="New password"
          onChangeText={onChangePassword}
          placeholder="New password"
          testID="auth-newpassword-input"
          toggleTestID="auth-newpassword-toggle"
          value={password}
        />

        <PasswordRules rules={rules} testID="auth-newpassword-rules" />
      </View>

      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

      <PrimaryButton
        disabled={!canContinue}
        label="Update password"
        onPress={onContinue}
        testID="auth-newpassword-continue"
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  fields: {
    gap: 16,
  },
});
