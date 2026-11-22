import { StyleSheet, View } from 'react-native';

import { spacing } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthEmailBackChip,
  AuthErrorBlock,
  AuthErrorLine,
  AuthHeading,
  PasswordField,
  PrimaryButton,
  TermsFooter,
  TertiaryButton,
} from './auth-controls';

type PasswordScreenProps = {
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangePassword: (value: string) => void;
  /** Present only when the method lookup failed, so a new user isn't stuck here. */
  onCreateAccount?: () => void;
  onContinue: () => void;
  onForgotPassword: () => void;
  onGoogle: () => void;
  password: string;
};

/** Email-first step 2 for a password account: "Welcome back" + password. */
export function PasswordScreen({
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  onBack,
  onChangePassword,
  onCreateAccount,
  onContinue,
  onForgotPassword,
  onGoogle,
  password,
}: PasswordScreenProps) {
  const canContinue = password.length > 0 && !isBusy;

  return (
    <AuthScreenLayout
      backTestID="auth-password-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-password-screen"
    >
      <View style={styles.header}>
        <AuthEmailBackChip email={email} onPress={onBack} testID="auth-email-chip" />
        <AuthHeading title="Welcome back" />
      </View>

      <PasswordField
        autoComplete="current-password"
        autoFocus
        label="Password"
        onChangeText={onChangePassword}
        onSubmitEditing={canContinue ? onContinue : undefined}
        testID="auth-password-input"
        textContentType="password"
        toggleTestID="auth-password-toggle"
        value={password}
      />

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      <AuthErrorBlock isBusy={isBusy} message={errorMessage} onGoogle={onGoogle} />

      <View style={styles.actions}>
        <PrimaryButton
          disabled={!canContinue}
          label="Log in"
          onPress={onContinue}
          testID="auth-password-continue"
        />
        <TertiaryButton
          label="Forgot password?"
          onPress={onForgotPassword}
          testID="auth-forgot-password"
        />
        {onCreateAccount ? (
          <TertiaryButton
            disabled={isBusy}
            label="New here? Create an account"
            onPress={onCreateAccount}
            testID="auth-password-create-account"
          />
        ) : null}
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.xs,
  },
  header: {
    gap: spacing.sm,
  },
});

export default PasswordScreen;
