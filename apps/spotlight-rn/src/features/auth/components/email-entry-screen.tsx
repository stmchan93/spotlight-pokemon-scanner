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
  /**
   * `login` shows email + password together and signs in directly ("Log in").
   * `signup` shows email only ("Continue" → collect name/password next). The two
   * modes are deliberate, separate paths — this screen never auto-detects which.
   */
  mode: 'login' | 'signup';
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  /** Inline notice, e.g. signup's "an account already exists" guard. */
  notice?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onChangePassword?: (value: string) => void;
  onContinue: () => void;
  onForgotPassword?: () => void;
  /** Cross-link to the other flow (login ↔ signup); rendered when provided. */
  onCrossLink?: () => void;
  crossLinkLabel?: string;
  password?: string;
};

/**
 * Email entry on the black wave-hero screen: back header, the EKALIGHT wordmark,
 * an email field, and — in `login` mode — a password field with "Forgot
 * password?". Continue stays disabled until the address looks valid (and, for
 * login, a password is entered). A cross-link switches to the other flow.
 */
export function EmailEntryScreen({
  mode,
  configurationIssue,
  email,
  errorMessage,
  notice,
  isBusy,
  onBack,
  onChangeEmail,
  onChangePassword,
  onContinue,
  onForgotPassword,
  onCrossLink,
  crossLinkLabel,
  password = '',
}: EmailEntryScreenProps) {
  const isLogin = mode === 'login';
  const canContinue =
    isValidLookingEmail(email) && (!isLogin || password.length > 0) && !isBusy;
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
          returnKeyType={isLogin ? 'next' : 'done'}
          testID="auth-email-input"
          value={email}
        />

        {showEmailError ? (
          <AuthErrorLine message="Enter a valid email address." />
        ) : null}

        {isLogin ? (
          <PasswordField
            onChangeText={onChangePassword}
            onSubmitEditing={canContinue ? onContinue : undefined}
            testID="auth-password-input"
            toggleTestID="auth-password-toggle"
            value={password}
          />
        ) : null}

        {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
        {notice ? <AuthErrorLine message={notice} /> : null}
        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label={isLogin ? 'Log in' : 'Continue'}
          onPress={onContinue}
          testID="auth-email-continue"
        />

        {isLogin && onForgotPassword ? (
          <TertiaryButton
            label="Forgot password?"
            onPress={onForgotPassword}
            testID="auth-forgot-password"
          />
        ) : null}

        {onCrossLink && crossLinkLabel ? (
          <TertiaryButton
            disabled={isBusy}
            label={crossLinkLabel}
            onPress={onCrossLink}
            testID="auth-email-cross-link"
          />
        ) : null}
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
