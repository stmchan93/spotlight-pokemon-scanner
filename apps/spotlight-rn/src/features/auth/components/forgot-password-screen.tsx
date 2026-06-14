import { Text } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthSheetLayout } from './auth-sheet-layout';
import {
  AuthErrorLine,
  PrimaryButton,
  SecondaryField,
  isValidLookingEmail,
} from './auth-controls';

type ForgotPasswordScreenProps = {
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onContinue: () => void;
};

export function ForgotPasswordScreen({
  email,
  errorMessage,
  isBusy,
  onBack,
  onChangeEmail,
  onContinue,
}: ForgotPasswordScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = isValidLookingEmail(email) && !isBusy;

  return (
    <AuthSheetLayout
      actions={
        <PrimaryButton
          disabled={!canContinue}
          label="Send reset code"
          onPress={onContinue}
          testID="auth-forgot-continue"
        />
      }
      backTestID="auth-forgot-back"
      onBack={onBack}
      testID="auth-forgot-password-screen"
    >
      <Text style={[theme.typography.displayLarge, { color: theme.colors.gray900 }]}>
        Reset password
      </Text>
      <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
        Enter your email and we&apos;ll send you a reset code.
      </Text>

      <SecondaryField
        autoCapitalize="none"
        autoCorrect={false}
        floatingLabel="Email"
        keyboardType="email-address"
        onChangeText={onChangeEmail}
        placeholder="Email"
        testID="auth-forgot-email-input"
        value={email}
      />

      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}
    </AuthSheetLayout>
  );
}
