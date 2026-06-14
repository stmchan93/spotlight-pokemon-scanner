import { Text } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthSheetLayout } from './auth-sheet-layout';
import { AuthErrorLine, PasswordField, PrimaryButton } from './auth-controls';

type SetNewPasswordScreenProps = {
  errorMessage?: string | null;
  isBusy: boolean;
  onBack: () => void;
  onChangePassword: (value: string) => void;
  onContinue: () => void;
  password: string;
};

export function SetNewPasswordScreen({
  errorMessage,
  isBusy,
  onBack,
  onChangePassword,
  onContinue,
  password,
}: SetNewPasswordScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = password.length >= 6 && !isBusy;

  return (
    <AuthSheetLayout
      actions={
        <PrimaryButton
          disabled={!canContinue}
          label="Update password"
          onPress={onContinue}
          testID="auth-newpassword-continue"
        />
      }
      backTestID="auth-newpassword-back"
      onBack={onBack}
      testID="auth-set-new-password-screen"
    >
      <Text style={[theme.typography.displayLarge, { color: theme.colors.gray900 }]}>
        Set a new password
      </Text>

      <PasswordField
        onChangeText={onChangePassword}
        testID="auth-newpassword-input"
        toggleTestID="auth-newpassword-toggle"
        value={password}
      />

      {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}
    </AuthSheetLayout>
  );
}
