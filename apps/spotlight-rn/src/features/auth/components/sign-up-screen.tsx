import { Platform, StyleSheet, View } from 'react-native';

import { Text, spacing, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthEmailBackChip,
  AuthErrorBlock,
  AuthErrorLine,
  AuthHeading,
  PasswordField,
  PasswordRules,
  PrimaryButton,
  SecondaryField,
  TermsFooter,
  buildPasswordRules,
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
  onChangeFirstName: (value: string) => void;
  onChangeLastName: (value: string) => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onGoogle: () => void;
  password: string;
};

/**
 * Email-first step 2 for a new address: the email is fixed from step 1 (the
 * chip goes back to change it); collects first/last name and a password with
 * the strength checklist, then continues to code verification.
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
  onChangeFirstName,
  onChangeLastName,
  onChangePassword,
  onContinue,
  onGoogle,
  password,
}: SignUpScreenProps) {
  const theme = useSpotlightTheme();
  const rules = buildPasswordRules(password);
  const canContinue =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    rules.every((rule) => rule.satisfied) &&
    !isBusy;
  const showApple = Platform.OS === 'ios' || appleSignInAvailable;

  return (
    <AuthScreenLayout
      backTestID="auth-signup-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-signup-screen"
    >
      <View style={styles.header}>
        <AuthEmailBackChip email={email} onPress={onBack} testID="auth-email-chip" />
        <AuthHeading title="Create your account" />
      </View>

      <View style={styles.fields}>
        <SecondaryField
          autoCapitalize="words"
          autoComplete="given-name"
          autoCorrect={false}
          label="First Name"
          onChangeText={onChangeFirstName}
          placeholder="First Name"
          testID="auth-firstname-input"
          textContentType="givenName"
          value={firstName}
        />
        <SecondaryField
          autoCapitalize="words"
          autoComplete="family-name"
          autoCorrect={false}
          label="Last Name"
          onChangeText={onChangeLastName}
          placeholder="Last Name"
          testID="auth-lastname-input"
          textContentType="familyName"
          value={lastName}
        />

        <PasswordField
          autoComplete="new-password"
          label="Password"
          onChangeText={onChangePassword}
          testID="auth-signup-password-input"
          textContentType="newPassword"
          toggleTestID="auth-signup-password-toggle"
          value={password}
        />

        {password.length > 0 ? (
          <PasswordRules rules={rules} testID="auth-signup-password-rules" />
        ) : null}
      </View>

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      {notice ? <AuthErrorLine message={notice} /> : null}
      <AuthErrorBlock isBusy={isBusy} message={errorMessage} onGoogle={onGoogle} />

      <PrimaryButton
        disabled={!canContinue}
        label="Continue"
        onPress={onContinue}
        testID="auth-signup-continue"
      />

      {/* Apple Hide-My-Email accounts have a relay address, so the typed email
          looks new even though the person already has an account. */}
      {showApple ? (
        <Text style={[styles.appleHint, { color: theme.colors.gray600 }]}>
          Signed up with Apple before?{' '}
          <Text
            accessibilityRole="link"
            disabled={isBusy}
            onPress={onApple}
            style={[styles.appleHintLink, { color: theme.colors.gray900 }]}
            suppressHighlighting
            testID="auth-signup-apple-link"
          >
            Continue with Apple
          </Text>
        </Text>
      ) : null}
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  appleHint: {
    ...textStyles.caption,
    textAlign: 'center',
  },
  appleHintLink: {
    ...textStyles.captionMedium,
    textDecorationLine: 'underline',
  },
  fields: {
    gap: spacing.sm,
  },
  header: {
    gap: spacing.sm,
  },
});

export default SignUpScreen;
