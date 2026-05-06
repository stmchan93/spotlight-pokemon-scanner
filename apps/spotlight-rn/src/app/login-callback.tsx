import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { restoreSessionFromUrl } from '@/features/auth/auth-service';
import { useAuth } from '@/providers/auth-provider';

export default function LoginCallbackScreen() {
  const router = useRouter();
  const auth = useAuth();
  const callbackURL = Linking.useLinkingURL();
  const [fallbackCallbackURL, setFallbackCallbackURL] = useState<string | null>(null);
  const hasHandledCallbackRef = useRef(false);
  const hasNavigatedAwayRef = useRef(false);

  const navigateToPortfolio = useCallback(() => {
    if (hasNavigatedAwayRef.current) {
      return;
    }

    hasNavigatedAwayRef.current = true;
    router.replace('/(tabs)/portfolio');
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
      navigateToPortfolio();
    }
  }, [auth.state, navigateToPortfolio]);

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
          navigateToPortfolio();
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [navigateToPortfolio, resolvedCallbackURL]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#111111" testID="login-callback-loading-indicator" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    flex: 1,
    justifyContent: 'center',
  },
});
