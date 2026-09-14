import { NavigationContext, useIsFocused } from '@react-navigation/native';
import { type ReactNode, useContext, useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

/**
 * Renders a tab's screen only once that tab has been looked at.
 *
 * WHY. expo-router's native tabs mount EVERY tab screen on the first render
 * (`NativeTabsView.js` calls each `contentRenderer()` inline and hardcodes
 * `freezeContents={false}`, so `enableFreeze` never applies). On a low-end
 * Android phone (Galaxy A17, 2026-09-13) that put the scanner (its camera
 * session included), the wishlist and the feed on the JS thread at the same
 * moment as the collection: ~100% JS CPU for the first 10s after a cold launch.
 * Native tabs on Android wait for JS to confirm a tab change, so the bar was
 * dead for exactly that long — "tapping Scan does nothing for ten seconds".
 *
 * Deferring the unfocused tabs until their first focus removes them from the
 * launch entirely. It is FIRST focus, not every focus: once mounted a screen
 * stays mounted, which keeps the mount-once-then-toggle-`isActive` camera
 * pattern the scanner relies on (conditional camera mounts crashed on return).
 *
 * Android only. iOS handles the eager mount fine and gets an already-warm
 * camera the first time Scan is tapped; there is nothing to fix there.
 */
export function MountOnFirstFocus({
  children,
  placeholderColor,
}: {
  children: ReactNode;
  placeholderColor?: string;
}) {
  // `useIsFocused` throws outside a navigator (isolated tests, the dev-screen
  // host). With no navigator there is no focus to wait for.
  const navigation = useContext(NavigationContext);
  if (Platform.OS !== 'android' || !navigation) {
    return children;
  }
  return <DeferredUntilFocused placeholderColor={placeholderColor}>{children}</DeferredUntilFocused>;
}

function DeferredUntilFocused({
  children,
  placeholderColor,
}: {
  children: ReactNode;
  placeholderColor?: string;
}) {
  const isFocused = useIsFocused();
  const [hasBeenFocused, setHasBeenFocused] = useState(isFocused);

  useEffect(() => {
    if (isFocused) {
      setHasBeenFocused(true);
    }
  }, [isFocused]);

  if (!hasBeenFocused) {
    return <View style={[styles.placeholder, placeholderColor ? { backgroundColor: placeholderColor } : null]} />;
  }
  return children;
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
  },
});
