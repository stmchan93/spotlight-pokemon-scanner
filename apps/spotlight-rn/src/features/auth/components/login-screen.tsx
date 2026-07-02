import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Apple, Google } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  AuthGroupLabel,
  AuthSectionTitle,
  OrDivider,
  PasswordField,
  PrimaryButton,
  SecondaryActionButton,
  SecondaryField,
  TermsFooter,
  TertiaryButton,
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
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onForgotPassword: () => void;
  onGoogle: () => void;
  onSignUp: () => void;
  password: string;
};

/**
 * Log In (Figma 2161:6847): the signed-out root. White screen under the
 * EKALIGHT header — "LOG IN", email + password underline fields, Continue
 * (black when valid), "Forgot password?", an OR divider with Google/Apple, and
 * a "NEW ACCOUNT" → Sign Up cross-link. Logging in and signing up are separate,
 * deliberate paths — no auto-detect.
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
  onChangePassword,
  onContinue,
  onForgotPassword,
  onGoogle,
  onSignUp,
  password,
}: LoginScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = isValidLookingEmail(email) && password.length > 0 && !isBusy;
  // Surface WHY Continue is disabled once they've left the field with a malformed
  // address (don't nag mid-typing). Blank field shows nothing.
  const [emailTouched, setEmailTouched] = useState(false);
  const showEmailError = emailTouched && email.trim().length > 0 && !isValidLookingEmail(email);
  // Apple Sign In is required alongside Google on iOS (App Store guideline 4.8),
  // so always offer it on iOS; on Android fall back to the runtime availability
  // flag (effectively hidden, since Apple auth isn't native there).
  const showApple = Platform.OS === 'ios' || appleSignInAvailable;

  return (
    <AuthScreenLayout
      backTestID="auth-login-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-login-screen"
    >
      <AuthSectionTitle>LOG IN</AuthSectionTitle>

      <View style={styles.fields}>
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          label="Email"
          onBlur={() => setEmailTouched(true)}
          onChangeText={onChangeEmail}
          placeholder="Email"
          returnKeyType="next"
          testID="auth-email-input"
          value={email}
        />

        {showEmailError ? <AuthErrorLine message="Enter a valid email address." /> : null}

        <PasswordField
          label="Password"
          onChangeText={onChangePassword}
          onSubmitEditing={canContinue ? onContinue : undefined}
          testID="auth-password-input"
          toggleTestID="auth-password-toggle"
          value={password}
        />
      </View>

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-login-continue"
        />
        <TertiaryButton
          label="Forgot password?"
          onPress={onForgotPassword}
          testID="auth-forgot-password"
        />
      </View>

      <OrDivider />

      <View style={styles.actions}>
        <SecondaryActionButton
          disabled={isBusy}
          label="Continue with Google"
          leadingIcon={<Google color={theme.colors.gray900} height={16} width={16} />}
          onPress={onGoogle}
          testID="auth-google-button"
        />
        {showApple ? (
          <SecondaryActionButton
            disabled={isBusy}
            label="Continue with Apple"
            leadingIcon={<Apple color={theme.colors.gray900} height={16} width={16} />}
            onPress={onApple}
            testID="auth-apple-button"
          />
        ) : null}
      </View>

      <View style={styles.crossFlow}>
        <AuthGroupLabel>NEW ACCOUNT</AuthGroupLabel>
        <SecondaryActionButton
          disabled={isBusy}
          label="Sign Up"
          onPress={onSignUp}
          testID="auth-login-signup"
        />
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
  },
  crossFlow: {
    gap: 16,
    marginTop: 16,
  },
  fields: {
    gap: 16,
  },
});

export default LoginScreen;
