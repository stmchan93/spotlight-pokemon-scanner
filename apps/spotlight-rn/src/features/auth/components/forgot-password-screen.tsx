import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
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

/**
 * Forgot password (Figma 1543:2170, bottom frames): a left-aligned heading +
 * helper copy, an email underline field, and a Send button.
 */
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
    <AuthScreenLayout
      backTestID="auth-forgot-back"
      onBack={onBack}
      testID="auth-forgot-password-screen"
    >
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray0 }]}>
          Forgot your password?
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.gray400 }]}>
          Confirm the email address you used to create your account, and we&apos;ll send a
          password reset email to it.
        </Text>
      </View>

      <View style={styles.form}>
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={onChangeEmail}
          onSubmitEditing={canContinue ? onContinue : undefined}
          placeholder="Email"
          returnKeyType="send"
          testID="auth-forgot-email-input"
          value={email}
        />

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Send reset code"
          onPress={onContinue}
          testID="auth-forgot-continue"
        />
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
