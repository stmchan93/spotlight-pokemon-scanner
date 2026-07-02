import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  AuthSectionTitle,
  PrimaryButton,
  SecondaryField,
  TermsFooter,
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
 * Password reset entry (Figma 2170:7283): "PASSWORD RESET" title, helper copy,
 * an EMAIL underline field, and a Continue button that turns black once the
 * address looks valid. (The design copy says "link"; our flow emails a CODE that
 * the next screen verifies, so the copy stays truthful to what arrives.)
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
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-forgot-password-screen"
    >
      <View style={styles.heading}>
        <AuthSectionTitle>PASSWORD RESET</AuthSectionTitle>
        <Text style={[styles.subtitle, { color: theme.colors.gray600 }]}>
          Enter your email to receive a code to create a new password via email.
        </Text>
      </View>

      <SecondaryField
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        label="Email"
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
        label="Continue"
        onPress={onContinue}
        testID="auth-forgot-continue"
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  heading: {
    gap: 8,
  },
  subtitle: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 14,
    lineHeight: 21,
  },
});
