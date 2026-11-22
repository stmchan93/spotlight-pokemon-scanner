import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { spacing } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorBlock,
  AuthErrorLine,
  AuthHeading,
  OrDivider,
  PrimaryButton,
  SecondaryField,
  SocialAuthButtons,
  TermsFooter,
  isValidLookingEmail,
} from './auth-controls';

type LoginScreenProps = {
  appleSignInAvailable?: boolean;
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onApple: () => void;
  onBack?: () => void;
  onChangeEmail: (value: string) => void;
  onContinue: () => void;
  onGoogle: () => void;
};

/**
 * Email-first root: one email field + Continue, then Google/Apple. Continue
 * looks up how the address signs in and the flow routes to the right step 2
 * (password, social, or create account) — no Log In vs Sign Up choice here.
 */
export function LoginScreen({
  appleSignInAvailable = false,
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  onApple,
  onBack,
  onChangeEmail,
  onContinue,
  onGoogle,
}: LoginScreenProps) {
  const canContinue = isValidLookingEmail(email) && !isBusy;
  // Explain a disabled Continue only after they leave a malformed field.
  const [emailTouched, setEmailTouched] = useState(false);
  const showEmailError = emailTouched && email.trim().length > 0 && !isValidLookingEmail(email);
  // Apple Sign In is required alongside Google on iOS (App Store guideline 4.8);
  // Android falls back to the runtime availability flag.
  const showApple = Platform.OS === 'ios' || appleSignInAvailable;

  return (
    <AuthScreenLayout
      backTestID="auth-login-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-login-screen"
    >
      <AuthHeading subtitle="Log in or create an account" title="Welcome to Ekalight" />

      <View style={styles.fields}>
        {/* `username` lets iOS pair this with the password step for autofill. */}
        <SecondaryField
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          keyboardType="email-address"
          label="Email"
          onBlur={() => setEmailTouched(true)}
          onChangeText={onChangeEmail}
          onSubmitEditing={canContinue ? onContinue : undefined}
          placeholder="Email"
          returnKeyType="next"
          testID="auth-email-input"
          textContentType="username"
          value={email}
        />

        {showEmailError ? <AuthErrorLine message="Enter a valid email address." /> : null}
      </View>

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      <AuthErrorBlock isBusy={isBusy} message={errorMessage} onGoogle={onGoogle} />

      <PrimaryButton
        disabled={!canContinue}
        label="Continue"
        onPress={onContinue}
        testID="auth-login-continue"
      />

      <OrDivider />

      <SocialAuthButtons isBusy={isBusy} onApple={onApple} onGoogle={onGoogle} showApple={showApple} />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  fields: {
    gap: spacing.sm,
  },
});

export default LoginScreen;
