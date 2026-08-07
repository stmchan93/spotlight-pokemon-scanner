import { useCallback } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * The Scan TAB is a launcher, not a screen.
 *
 * Tapping it pushes the camera (`/scan-camera`) over the tabs. That push is what
 * hides the tab bar: UIKit's `hidesBottomBarWhenPushed` applies to pushed view
 * controllers, so the camera gets the full screen — full-bleed preview, reticle
 * at its original size — and the bar returns on pop, for free. Making the camera
 * a tab SCREEN instead is what shrank the reticle, because a tab always renders
 * the bar over its content and insets it.
 *
 * A native tab cannot push instead of switching (NativeBottomTabsNavigator
 * dispatches JUMP_TO without reading `defaultPrevented`), so the tab switch still
 * happens underneath — this screen just must never be what the user is left on.
 *
 * ===========================================================================
 * WHY THE TAB SELECTION IS HANDED BACK IMMEDIATELY
 * ===========================================================================
 * The first version tried to detect the return: launch on first focus, and on
 * the focus caused by popping, redirect to Collection. That strands the user on
 * a black screen, which is what shipped — the launcher does not reliably receive
 * a second focus event, so the redirect never runs and the popped stack lands on
 * a blank tab with Scan still selected.
 *
 * Detecting the return was the wrong shape. Instead, never be the return target:
 * switch the tab selection back to Collection in the same breath as launching.
 * The camera is a stack screen ABOVE the tabs, so this does not disturb it — it
 * only changes which tab sits underneath. Popping then lands on Collection
 * whether the user used the back button or the back-swipe, and there is no
 * relaunch loop to guard because this tab is no longer selected.
 *
 * `getParent()` targets the TAB navigator specifically. Using `router.replace`
 * here would rewrite the root stack's top entry — which is the camera — and
 * dismiss the very screen we just pushed.
 */
export default function ScanTab() {
  const router = useRouter();
  const navigation = useNavigation();

  useFocusEffect(
    useCallback(() => {
      router.push('/scan-camera' as never);
      navigation.getParent()?.navigate('index' as never);
    }, [navigation, router]),
  );

  // Black, not transparent: this is visible for a frame behind the push, and
  // black matches the camera it becomes rather than flashing the light surface.
  return (
    <View style={{ backgroundColor: '#000000', flex: 1 }} testID="scan-tab-launcher">
      <StatusBar style="light" />
    </View>
  );
}
