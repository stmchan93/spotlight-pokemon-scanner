import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useEffect } from 'react';

import { claimLaunchToScanner } from '@/lib/launch-to-scanner';

const RETRY_MS = 350;
const RETRY_FOR_MS = 2200;

/**
 * Called from Home: switches to the Scanner the first time Home is focused for
 * this account. Goes through the react-navigation tab navigator with a short
 * retry, same as `GuestScannerRedirect`, because the first dispatch lands before
 * the native tabs controller is ready and expo-router APIs are ignored on Android.
 */
export function useLaunchToScanner(userId: string | null | undefined) {
  const isFocused = useIsFocused();
  const navigation = useNavigation();

  useEffect(() => {
    if (!isFocused || !claimLaunchToScanner(userId)) {
      return;
    }
    const go = () => navigation.navigate('scan' as never);
    go();
    const retry = setInterval(() => {
      if (!navigation.isFocused()) {
        clearInterval(retry);
        return;
      }
      go();
    }, RETRY_MS);
    const stop = setTimeout(() => clearInterval(retry), RETRY_FOR_MS);
    return () => {
      clearInterval(retry);
      clearTimeout(stop);
    };
  }, [isFocused, navigation, userId]);
}
