import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Apple, Google, Mail } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  AuthGroupLabel,
  AuthSectionTitle,
  OrDivider,
  PasswordField,
  PasswordRules,
  PrimaryButton,
  SecondaryActionButton,
  SecondaryField,
  TermsFooter,
  buildPasswordRules,
  isValidLookingEmail,
} from './auth-controls';

type SignUpScreenProps = {
  appleSignInAvailable?: boolean;
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  firstName: string;
  isBusy: boolean;
  lastName: string;
  /** Inline notice, e.g. the "an account already exists" guard. */
  notice?: string | null;
  onApple: () => void;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onChangeFirstName: (value: string) => void;
  onChangeLastName: (value: string) => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onGoogle: () => void;
  onLogIn: () => void;
  password: string;
};

/**
 * Sign Up (Figma 2161:6847, right column): one dedicated screen collecting
 * first/last name, email, and password (with the strength checklist), plus the
 * OR divider with Google/Apple and a "LOG IN" → Continue with Email cross-link
 * back to the login screen. A deliberate, separate path from logging in.
 */
export function SignUpScreen({
  appleSignInAvailable = false,
  configurationIssue,
  email,
  errorMessage,
  firstName,
  isBusy,
  lastName,
  notice,
  onApple,
  onBack,
  onChangeEmail,
  onChangeFirstName,
  onChangeLastName,
  onChangePassword,
  onContinue,
  onGoogle,
  onLogIn,
  password,
}: SignUpScreenProps) {
  const theme = useSpotlightTheme();
  const rules = buildPasswordRules(password);
  const canContinue =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    isValidLookingEmail(email) &&
    rules.every((rule) => rule.satisfied) &&
    !isBusy;
  const [emailTouched, setEmailTouched] = useState(false);
  const showEmailError = emailTouched && email.trim().length > 0 && !isValidLookingEmail(email);
  const showApple = Platform.OS === 'ios' || appleSignInAvailable;

  return (
    <AuthScreenLayout
      backTestID="auth-signup-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-signup-screen"
    >
      <AuthSectionTitle>SIGN UP</AuthSectionTitle>

      <View style={styles.fields}>
        <SecondaryField
          autoCapitalize="words"
          autoCorrect={false}
          label="First Name"
          onChangeText={onChangeFirstName}
          placeholder="First Name"
          testID="auth-firstname-input"
          value={firstName}
        />
        <SecondaryField
          autoCapitalize="words"
          autoCorrect={false}
          label="Last Name"
          onChangeText={onChangeLastName}
          placeholder="Last Name"
          testID="auth-lastname-input"
          value={lastName}
        />
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          label="Email"
          onBlur={() => setEmailTouched(true)}
          onChangeText={onChangeEmail}
          placeholder="Email"
          testID="auth-signup-email-input"
          value={email}
        />

        {showEmailError ? <AuthErrorLine message="Enter a valid email address." /> : null}

        <PasswordField
          label="Password"
          onChangeText={onChangePassword}
          testID="auth-signup-password-input"
          toggleTestID="auth-signup-password-toggle"
          value={password}
        />

        {password.length > 0 ? (
          <PasswordRules rules={rules} testID="auth-signup-password-rules" />
        ) : null}
      </View>

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      {notice ? <AuthErrorLine message={notice} /> : null}
      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

      <PrimaryButton
        disabled={!canContinue}
        label="Continue"
        onPress={onContinue}
        testID="auth-signup-continue"
      />

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
        <AuthGroupLabel>LOG IN</AuthGroupLabel>
        <SecondaryActionButton
          disabled={isBusy}
          label="Continue with Email"
          leadingIcon={<Mail color={theme.colors.gray900} height={16} width={16} />}
          onPress={onLogIn}
          testID="auth-signup-login"
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

export default SignUpScreen;
