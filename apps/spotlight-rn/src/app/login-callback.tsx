import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useEffect, useRef } from 'react';

import { restoreSessionFromUrl } from '@/features/auth/auth-service';

export default function LoginCallbackScreen() {
  const router = useRouter();
  const callbackURL = Linking.useLinkingURL();
  const hasHandledCallbackRef = useRef(false);

  useEffect(() => {
    if (!callbackURL || !callbackURL.includes('login-callback') || hasHandledCallbackRef.current) {
      return;
    }

    hasHandledCallbackRef.current = true;
    let isActive = true;

    void (async () => {
      try {
        await restoreSessionFromUrl(callbackURL);
      } catch {
        // Auth provider owns error handling; this route only prevents dead-end navigation.
      } finally {
        if (isActive) {
          router.replace('/(tabs)/portfolio');
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [callbackURL, router]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#111111" />
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
