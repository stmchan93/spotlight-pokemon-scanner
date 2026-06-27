import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthErrorLine,
  PrimaryButton,
  SecondaryField,
  TertiaryButton,
} from './auth-controls';

// Matches Supabase's default per-address resend interval (`max_frequency`, 60s)
// so the button only re-enables once the server will actually accept a resend —
// otherwise an early tap returns a 429 "you can only request this after 60s".
const RESEND_COOLDOWN_SECONDS = 60;

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

  // Throttle resends: tapping "Resend email" starts a countdown so the user
  // can't spam the OTP endpoint (which Supabase rate-limits) or wonder why
  // nothing happened on a rapid double-tap. Seeded to the full interval because
  // the email that brought the user to this screen was just sent — the server's
  // 60s clock is already running, so the button should start disabled.
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (resendCooldown <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setResendCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleResend = useCallback(() => {
    if (resendCooldown > 0 || isBusy) {
      return;
    }
    onResend();
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }, [isBusy, onResend, resendCooldown]);

  return (
    <AuthScreenLayout
      backTestID="auth-verify-back"
      onBack={onBack}
      testID="auth-verify-code-screen"
    >
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray0 }]}>Check your inbox</Text>
        <Text style={[styles.subtitle, { color: theme.colors.gray400 }]}>
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

        <TertiaryButton
          disabled={resendCooldown > 0 || isBusy}
          label={resendCooldown > 0 ? `Resend email in ${resendCooldown}s` : 'Resend email'}
          onPress={handleResend}
          testID="auth-resend"
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
