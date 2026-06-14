import { Text } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthSheetLayout } from './auth-sheet-layout';
import {
  AuthErrorLine,
  PrimaryButton,
  SecondaryField,
  TertiaryButton,
} from './auth-controls';

type VerifyCodeScreenProps = {
  code: string;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangeCode: (value: string) => void;
  onContinue: () => void;
  onResend: () => void;
};

export function VerifyCodeScreen({
  code,
  email,
  errorMessage,
  isBusy,
  onBack,
  onChangeCode,
  onContinue,
  onResend,
}: VerifyCodeScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = code.trim().length >= 6 && !isBusy;

  return (
    <AuthSheetLayout
      actions={
        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-verify-continue"
        />
      }
      backTestID="auth-verify-back"
      onBack={onBack}
      testID="auth-verify-code-screen"
    >
      <Text style={[theme.typography.displayLarge, { color: theme.colors.gray900 }]}>
        Check your inbox
      </Text>
      <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
        {`Enter the verification code sent to ${email}`}
      </Text>

      <SecondaryField
        autoCapitalize="none"
        autoCorrect={false}
        floatingLabel="Code"
        keyboardType="number-pad"
        onChangeText={onChangeCode}
        placeholder="Verification code"
        testID="auth-code-input"
        value={code}
      />

      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

      <TertiaryButton label="Resend email" onPress={onResend} testID="auth-resend" />
    </AuthSheetLayout>
  );
}
