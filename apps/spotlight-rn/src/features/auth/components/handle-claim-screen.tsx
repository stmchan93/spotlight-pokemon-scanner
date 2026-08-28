import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text, fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import {
  type AppUser,
  describeHandleValidity,
  sanitizeHandleInput,
  validateHandle,
} from '@/features/auth/auth-models';
import { checkHandleAvailability, type HandleAvailability } from '@/features/profile/profile-service';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthErrorLine, PrimaryButton, SecondaryField } from './auth-controls';

type HandleClaimScreenProps = {
  errorMessage: string | null;
  isBusy: boolean;
  onSubmit: (handle: string) => void;
  user: AppUser | null;
};

const AVAILABILITY_DEBOUNCE_MS = 400;

/**
 * The blocking @handle claim step. Rendered INSTEAD of the app (same modality
 * as ProfileOnboardingScreen) — no back, no dismiss — so its failure posture
 * matters: the availability probe is advisory and `unknown` (offline, RPC
 * missing) must never block submit. The unique index decides at save time; the
 * caller surfaces `handle-taken` back through `errorMessage`.
 */
export function HandleClaimScreen({
  errorMessage,
  isBusy,
  onSubmit,
  user,
}: HandleClaimScreenProps) {
  const theme = useSpotlightTheme();
  const [value, setValue] = useState('');
  const [availability, setAvailability] = useState<HandleAvailability | 'checking' | null>(null);
  const probeTokenRef = useRef(0);

  const validity = validateHandle(value);

  useEffect(() => {
    const token = ++probeTokenRef.current;
    if (validity !== 'ok') {
      setAvailability(null);
      return undefined;
    }
    setAvailability('checking');
    const timer = setTimeout(() => {
      void checkHandleAvailability(value).then((result) => {
        if (probeTokenRef.current === token) {
          setAvailability(result);
        }
      });
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, validity]);

  // 'taken' blocks; 'unknown' does not — a probe failure must not trap the user.
  const canContinue = validity === 'ok' && availability !== 'taken' && !isBusy;

  const validityMessage = validity === 'empty' ? null : describeHandleValidity(validity);
  let helperText: string | null = null;
  let helperColor: string = theme.colors.gray600;
  if (validityMessage) {
    helperText = validityMessage;
  } else if (validity === 'ok') {
    switch (availability) {
      case 'checking':
        helperText = 'Checking availability…';
        break;
      case 'available':
        helperText = `@${value} is available.`;
        helperColor = theme.colors.green500;
        break;
      case 'taken':
        helperText = `@${value} is already taken.`;
        helperColor = theme.colors.red500;
        break;
      case 'unknown':
        helperText = "Can't check availability right now — you can still continue.";
        break;
      default:
        break;
    }
  } else {
    helperText = 'Letters, numbers, and underscores.';
  }

  return (
    <AuthScreenLayout testID="auth-handle-claim-screen">
      <View style={styles.heading}>
        <Text style={[styles.title, { color: theme.colors.gray900 }]}>Claim your @handle</Text>
        <Text style={[styles.subtitle, { color: theme.colors.gray600 }]}>
          Your unique name on Ekalight
        </Text>
      </View>

      <View style={styles.form}>
        {user?.email ? (
          <Text style={[styles.signedInAs, { color: theme.colors.gray600 }]}>
            {`Signed in as ${user.email}`}
          </Text>
        ) : null}

        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          label="Handle"
          onChangeText={(next) => setValue(sanitizeHandleInput(next))}
          onSubmitEditing={canContinue ? () => onSubmit(value) : undefined}
          placeholder="@yourhandle"
          returnKeyType="done"
          testID="auth-handle-input"
          value={value}
        />

        {helperText ? (
          <Text style={[styles.helper, { color: helperColor }]} testID="auth-handle-helper">
            {helperText}
          </Text>
        ) : null}

        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Claim handle"
          onPress={() => onSubmit(value)}
          testID="auth-handle-submit"
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
  helper: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 13,
    lineHeight: 18,
  },
  signedInAs: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
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
