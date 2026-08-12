import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { colors } from '@spotlight/design-system';

import { restoreSessionFromUrl } from '@/features/auth/auth-service';
import { useAuth } from '@/providers/auth-provider';

export default function LoginCallbackScreen() {
  const router = useRouter();
  const auth = useAuth();
  const callbackURL = Linking.useLinkingURL();
  const [fallbackCallbackURL, setFallbackCallbackURL] = useState<string | null>(null);
  const hasHandledCallbackRef = useRef(false);
  const hasNavigatedAwayRef = useRef(false);

  /**
   * Land on Home after sign-in. Home IS `/` — the feed is the app's landing
   * surface.
   *
   * This was `navigateToPortfolio` and passed `params: { page: 'portfolio' }`.
   * Both were stale: `/` stopped being the collection when the feed took the
   * tabs root, and `page` was the retired pager's addressing for choosing
   * between two mounted pages — nothing reads it now that each page is a real
   * route. So the name said portfolio, the param said portfolio, and the
   * destination was the feed.
   *
   * `dismissTo` is correct HERE, unlike in the drawer: this is a root-stack
   * route, so the divergence is at the stack and `StackRouter` implements
   * POP_TO. Popping is what closes the callback screen.
   */
  const navigateHome = useCallback(() => {
    if (hasNavigatedAwayRef.current) {
      return;
    }

    hasNavigatedAwayRef.current = true;
    router.dismissTo('/');
  }, [router]);

  useEffect(() => {
    if (callbackURL) {
      setFallbackCallbackURL(null);
      return;
    }

    let isActive = true;

    void (async () => {
      try {
        const initialURL = await Linking.getInitialURL();
        if (isActive && initialURL?.includes('login-callback')) {
          setFallbackCallbackURL(initialURL);
        }
      } catch {
        // Ignore deep-link fallback lookup failures and wait for auth state instead.
      }
    })();

    return () => {
      isActive = false;
    };
  }, [callbackURL]);

  useEffect(() => {
    if (auth.state === 'signedIn') {
      navigateHome();
    }
  }, [auth.state, navigateHome]);

  const resolvedCallbackURL = callbackURL ?? fallbackCallbackURL;

  useEffect(() => {
    if (!resolvedCallbackURL || !resolvedCallbackURL.includes('login-callback') || hasHandledCallbackRef.current) {
      return;
    }

    hasHandledCallbackRef.current = true;
    let isActive = true;

    void (async () => {
      try {
        await restoreSessionFromUrl(resolvedCallbackURL);
      } catch {
        // Auth provider owns error handling; this route only prevents dead-end navigation.
      } finally {
        if (isActive) {
          navigateHome();
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [navigateHome, resolvedCallbackURL]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#111111" testID="login-callback-loading-indicator" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    flex: 1,
    justifyContent: 'center',
  },
});
