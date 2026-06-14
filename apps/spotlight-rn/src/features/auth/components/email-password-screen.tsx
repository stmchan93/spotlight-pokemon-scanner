import { Text } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthSheetLayout } from './auth-sheet-layout';
import {
  AuthErrorLine,
  PasswordField,
  PrimaryButton,
  ReadOnlyField,
  SecondaryField,
  TertiaryButton,
} from './auth-controls';

type EmailPasswordScreenProps = {
  email: string;
  errorMessage?: string | null;
  fullName: string;
  isBusy: boolean;
  mode: 'signup' | 'login';
  onBack: () => void;
  onChangeFullName: (value: string) => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  onForgotPassword: () => void;
  password: string;
};

export function EmailPasswordScreen({
  email,
  errorMessage,
  fullName,
  isBusy,
  mode,
  onBack,
  onChangeFullName,
  onChangePassword,
  onContinue,
  onForgotPassword,
  password,
}: EmailPasswordScreenProps) {
  const theme = useSpotlightTheme();
  const isSignup = mode === 'signup';
  const passwordOk = password.length >= 6;
  const nameOk = !isSignup || fullName.trim().length > 0;
  const canContinue = passwordOk && nameOk && !isBusy;

  return (
    <AuthSheetLayout
      actions={
        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-emailpw-continue"
        />
      }
      backTestID="auth-emailpw-back"
      onBack={onBack}
      testID="auth-email-password-screen"
    >
      <Text style={[theme.typography.displayLarge, { color: theme.colors.gray900 }]}>
        {isSignup ? 'Create your account' : 'Welcome back'}
      </Text>
      <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
        Scan, collect, sell, and build your ultimate collection.
      </Text>

      <ReadOnlyField label="Email" testID="auth-emailpw-email" value={email} />

      {isSignup ? (
        <SecondaryField
          autoCapitalize="words"
          autoCorrect={false}
          floatingLabel="Full name"
          onChangeText={onChangeFullName}
          placeholder="Full name"
          testID="auth-fullname-input"
          value={fullName}
        />
      ) : null}

      <PasswordField
        onChangeText={onChangePassword}
        testID="auth-password-input"
        toggleTestID="auth-password-toggle"
        value={password}
      />

      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

      <TertiaryButton
        label="Forgot password"
        onPress={onForgotPassword}
        testID="auth-forgot-password"
      />
    </AuthSheetLayout>
  );
}
