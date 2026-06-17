import { StyleSheet, View } from 'react-native';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthWordmark } from './auth-wordmark';
import {
  AuthErrorLine,
  PasswordField,
  PasswordRules,
  PrimaryButton,
  ReadOnlyField,
  SecondaryField,
  TertiaryButton,
  type PasswordRule,
} from './auth-controls';

type EmailPasswordScreenProps = {
  email: string;
  errorMessage?: string | null;
  firstName: string;
  lastName: string;
  isBusy: boolean;
  mode: 'signup' | 'login';
  onBack: () => void;
  onChangeFirstName: (value: string) => void;
  onChangeLastName: (value: string) => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onForgotPassword: () => void;
  password: string;
};

export function buildPasswordRules(password: string): PasswordRule[] {
  return [
    { label: 'Contains 8 characters', satisfied: password.length >= 8 },
    { label: 'Contains at least one number', satisfied: /\d/.test(password) },
    { label: 'Contains at least one special character', satisfied: /[^A-Za-z0-9]/.test(password) },
  ];
}

export function EmailPasswordScreen({
  email,
  errorMessage,
  firstName,
  lastName,
  isBusy,
  mode,
  onBack,
  onChangeFirstName,
  onChangeLastName,
  onChangePassword,
  onContinue,
  onForgotPassword,
  password,
}: EmailPasswordScreenProps) {
  const isSignup = mode === 'signup';
  const rules = buildPasswordRules(password);
  // Signups must satisfy every rule (Figma 1543:2291); logins just need a
  // non-empty password so existing accounts created under older rules still work.
  const passwordOk = isSignup ? rules.every((rule) => rule.satisfied) : password.length > 0;
  const nameOk = !isSignup || (firstName.trim().length > 0 && lastName.trim().length > 0);
  const canContinue = passwordOk && nameOk && !isBusy;

  return (
    <AuthScreenLayout
      backTestID="auth-emailpw-back"
      onBack={onBack}
      testID="auth-email-password-screen"
    >
      <AuthWordmark tagline={null} />

      <View style={styles.form}>
        <ReadOnlyField label="Email" testID="auth-emailpw-email" value={email} />

        {isSignup ? (
          <>
            <SecondaryField
              autoCapitalize="words"
              autoCorrect={false}
              onChangeText={onChangeFirstName}
              placeholder="First name"
              testID="auth-firstname-input"
              value={firstName}
            />
            <SecondaryField
              autoCapitalize="words"
              autoCorrect={false}
              onChangeText={onChangeLastName}
              placeholder="Last name"
              testID="auth-lastname-input"
              value={lastName}
            />
          </>
        ) : null}

        <PasswordField
          onChangeText={onChangePassword}
          testID="auth-password-input"
          toggleTestID="auth-password-toggle"
          value={password}
        />

        {isSignup ? <PasswordRules rules={rules} testID="auth-password-rules" /> : null}

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label={isSignup ? 'Continue' : 'Submit'}
          onPress={onContinue}
          testID="auth-emailpw-continue"
        />

        {isSignup ? null : (
          <TertiaryButton
            label="Forgot password?"
            onPress={onForgotPassword}
            testID="auth-forgot-password"
          />
        )}
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 16,
    marginTop: 32,
  },
});
