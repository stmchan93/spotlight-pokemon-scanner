import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
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
    <AuthScreenLayout
      backTestID="auth-verify-back"
      onBack={onBack}
      testID="auth-verify-code-screen"
      title="Sign in / Sign up"
    >
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray900 }]}>Check your inbox</Text>
        <Text style={[styles.subtitle, { color: theme.colors.gray600 }]}>
          {`Enter the verification code sent to ${email}`}
        </Text>
      </View>

      <View style={styles.form}>
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          onChangeText={onChangeCode}
          onSubmitEditing={canContinue ? onContinue : undefined}
          placeholder="Verification code"
          testID="auth-code-input"
          value={code}
        />

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-verify-continue"
        />

        <TertiaryButton label="Resend email" onPress={onResend} testID="auth-resend" />
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 16,
    marginTop: 24,
  },
  heading: {
    gap: 8,
    marginTop: 8,
  },
  subtitle: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 13,
    lineHeight: 18,
  },
  title: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 22,
    lineHeight: 28,
  },
});
