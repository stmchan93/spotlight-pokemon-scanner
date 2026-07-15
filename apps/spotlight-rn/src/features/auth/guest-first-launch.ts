import AsyncStorage from '@react-native-async-storage/async-storage';

// Persisted once a NON-anonymous (real) session has ever been observed on this
// device. Its presence flips "first launch" OFF, so after any real login (or a
// logout) we show the normal login screen and never silently drop the user back
// into a guest session. Absent + no session on cold start => first launch =>
// guest.
const HAS_SIGNED_IN_KEY = '@spotlight/auth/has-signed-in';

/**
 * Whether a real account has ever signed in on this device. On storage failure
 * we assume TRUE (fail toward the login screen) so a returning user is never
 * silently handed a fresh guest account.
 */
export async function hasEverSignedIn(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(HAS_SIGNED_IN_KEY)) === 'true';
  } catch {
    return true;
  }
}

/** Record that a real (non-anonymous) session has signed in on this device. */
export async function markHasSignedIn(): Promise<void> {
  try {
    await AsyncStorage.setItem(HAS_SIGNED_IN_KEY, 'true');
  } catch {
    // Non-fatal — worst case a returning user briefly re-enters guest mode.
  }
}
