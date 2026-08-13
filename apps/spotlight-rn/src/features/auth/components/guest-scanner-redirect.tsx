import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, spacing } from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';

/*
  Guests land on the scanner. The declarative <Redirect> that used to express
  that renders null inside expo-router's native tabs on Android — the native
  tab selection never happens, leaving a dead white tab with no path to
  sign-in (first seen on the Play-installed build, 2026-08-13). expo-router's
  router.replace()/push() have the same failure there, so the switch goes
  through the underlying react-navigation tab navigator instead; the visible
  fallback below is the guarantee that this route can never be a silent dead
  end again.
*/
export function GuestScannerRedirect() {
  const isFocused = useIsFocused();
  const navigation = useNavigation();
  const { openLogin } = useGuestGate();
  const [redirectMayHaveFailed, setRedirectMayHaveFailed] = useState(false);

  const goToScanner = useCallback(() => {
    navigation.navigate('scan' as never);
  }, [navigation]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    // The first attempt fires before the native tabs controller is ready and
    // is silently dropped, so retry briefly — the switch succeeds once the
    // navigator is live (a few hundred ms after first mount).
    goToScanner();
    const retry = setInterval(goToScanner, 350);
    const stopRetrying = setTimeout(() => clearInterval(retry), 2200);
    // Still focused after the retries means the tab switch isn't happening —
    // reveal the manual way out instead of a blank screen.
    const reveal = setTimeout(() => setRedirectMayHaveFailed(true), 800);
    return () => {
      clearInterval(retry);
      clearTimeout(stopRetrying);
      clearTimeout(reveal);
    };
  }, [goToScanner, isFocused]);

  if (!redirectMayHaveFailed) {
    return null;
  }

  return (
    <View style={styles.root} testID="guest-scanner-redirect-fallback">
      <Button
        label="Scan cards"
        onPress={goToScanner}
        testID="guest-scanner-redirect-scan"
      />
      <Button
        label="Sign in"
        onPress={openLogin}
        testID="guest-scanner-redirect-sign-in"
        variant="secondary"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'stretch',
    flex: 1,
    gap: spacing.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
});
