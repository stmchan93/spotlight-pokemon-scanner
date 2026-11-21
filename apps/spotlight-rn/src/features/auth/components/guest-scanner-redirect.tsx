import { useIsFocused, useNavigation } from '@react-navigation/native';
import { usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, spacing } from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import { getAppStartedAt, resetAppStartedAtForTests } from '@/lib/app-start-time';

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
// Home is where the app opens, so its redirect right after launch is the silent
// "guests start on the scanner" one; a Home TAP later is an ask for an account.
// "Right after launch" is a time window, not "first Home visit": a guest the app
// opened straight onto the scanner would otherwise get a silent first Home tap.
const LAUNCH_REDIRECT_WINDOW_MS = 5000;
let launchRedirectDone = false;

function isLaunchVisit(): boolean {
  return !launchRedirectDone && Date.now() - getAppStartedAt() < LAUNCH_REDIRECT_WINDOW_MS;
}

/** Test-only: pretend the app just started. */
export function resetGuestLaunchRedirectForTests() {
  launchRedirectDone = false;
  resetAppStartedAtForTests();
}

export function GuestScannerRedirect({
  promptLogin = false,
}: {
  /**
   * `true` (Social, Watchlist): a guest who opens this tab gets the login page.
   * `'after-launch'` (Home): silent redirect on the launch visit, login after.
   * When login closes without signing in, the guest goes to the scanner.
   */
  promptLogin?: boolean | 'after-launch';
} = {}) {
  const isFocused = useIsFocused();
  const navigation = useNavigation();
  const pathname = usePathname();
  const { openLogin } = useGuestGate();
  const [redirectMayHaveFailed, setRedirectMayHaveFailed] = useState(false);
  // The login detour, as a sequence. The path lags focus by a render or two
  // (a Home tap is still '/scan', then '/', then '/login'), so state can't be
  // read off the path alone, and switching tabs while login is opening closes
  // it again (2026-11-21):
  //   idle → opening (login pushed) → open (path is /login) → closed → scanner.
  const stageRef = useRef<'idle' | 'opening' | 'open'>('idle');
  const openingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goToScanner = useCallback(() => {
    navigation.navigate('scan' as never);
  }, [navigation]);

  useEffect(() => () => {
    if (openingTimerRef.current) {
      clearTimeout(openingTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (pathname === '/login') {
      if (stageRef.current === 'opening') {
        stageRef.current = 'open';
      }
      return;
    }
    if (!isFocused) {
      setRedirectMayHaveFailed(false);
      return;
    }
    if (stageRef.current === 'opening') {
      // Login is on its way; don't touch the tabs until it has come and gone.
      return;
    }
    if (stageRef.current === 'idle') {
      const shouldPrompt = promptLogin === true || (promptLogin === 'after-launch' && !isLaunchVisit());
      if (shouldPrompt) {
        stageRef.current = 'opening';
        openLogin();
        // If login never shows (push dropped), don't strand the guest here.
        openingTimerRef.current = setTimeout(() => {
          openingTimerRef.current = null;
          if (stageRef.current === 'opening') {
            stageRef.current = 'idle';
            goToScanner();
          }
        }, 1500);
        return;
      }
    }
    // Launch visit, or login just closed without signing in: to the scanner.
    stageRef.current = 'idle';
    if (promptLogin === 'after-launch') {
      launchRedirectDone = true;
    }
    // The first attempt fires before the tabs controller is ready and is
    // silently dropped, so retry briefly.
    goToScanner();
    const retry = setInterval(goToScanner, 350);
    const stopRetrying = setTimeout(() => clearInterval(retry), 2200);
    // Still here after the retries means the switch isn't happening — show the
    // manual way out instead of a blank screen.
    const reveal = setTimeout(() => setRedirectMayHaveFailed(true), 2400);
    return () => {
      clearInterval(retry);
      clearTimeout(stopRetrying);
      clearTimeout(reveal);
    };
  }, [goToScanner, isFocused, openLogin, pathname, promptLogin]);

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
