import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthWordmark } from './auth-wordmark';
import {
  AuthErrorLine,
  PasswordField,
  PrimaryButton,
  SecondaryField,
  TertiaryButton,
  isValidLookingEmail,
} from './auth-controls';

type EmailEntryScreenProps = {
  // Social handlers are accepted for parity with the stepper but rendered on the
  // get-started screen, not here.
  appleSignInAvailable?: boolean;
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onApple?: () => void;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onForgotPassword: () => void;
  onGoogle?: () => void;
  password: string;
};

/**
 * Email + password entry (black wave-hero screen): back header, the EKALIGHT
 * wordmark, and the email and password fields shown TOGETHER on one screen — no
 * separate password step. Continue stays disabled until the address looks valid
 * AND a password is entered; it signs an existing account in directly and routes
 * a new address to sign-up.
 */
export function EmailEntryScreen({
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  onBack,
  onChangeEmail,
  onChangePassword,
  onContinue,
  onForgotPassword,
  password,
}: EmailEntryScreenProps) {
  const canContinue = isValidLookingEmail(email) && password.length > 0 && !isBusy;
  // Surface WHY Continue is disabled once they've left the field with a malformed
  // address (don't nag mid-typing). Blank field shows nothing.
  const [emailTouched, setEmailTouched] = useState(false);
  const showEmailError = emailTouched && email.trim().length > 0 && !isValidLookingEmail(email);

  return (
    <AuthScreenLayout
      backTestID="auth-email-back"
      onBack={onBack}
      testID="auth-email-entry-screen"
    >
      <AuthWordmark />

      <View style={styles.form}>
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onBlur={() => setEmailTouched(true)}
          onChangeText={onChangeEmail}
          placeholder="Email"
          returnKeyType="next"
          testID="auth-email-input"
          value={email}
        />

        {showEmailError ? (
          <AuthErrorLine message="Enter a valid email address." />
        ) : null}

        <PasswordField
          onChangeText={onChangePassword}
          onSubmitEditing={canContinue ? onContinue : undefined}
          testID="auth-password-input"
          toggleTestID="auth-password-toggle"
          value={password}
        />

        {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-email-continue"
        />

        <TertiaryButton
          label="Forgot password?"
          onPress={onForgotPassword}
          testID="auth-forgot-password"
        />
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 16,
    marginTop: 40,
  },
});
