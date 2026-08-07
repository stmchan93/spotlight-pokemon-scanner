import { useCallback, useRef } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * The Scan TAB is a launcher, not a screen.
 *
 * Tapping it pushes the camera (`/scan-camera`) over the tabs. That push is what
 * hides the tab bar: UIKit's `hidesBottomBarWhenPushed` applies to pushed view
 * controllers, so the camera gets the full screen — full-bleed preview, reticle
 * back to its original size — and the bar returns on pop, for free. Making the
 * camera a tab SCREEN instead is what shrank the reticle, because a tab always
 * renders the bar over its content and insets it.
 *
 * A native tab cannot simply push instead of switching (NativeBottomTabsNavigator
 * dispatches JUMP_TO without reading `defaultPrevented`), so the switch still
 * happens — this screen just never becomes visible.
 *
 * THE LOOP THIS AVOIDS: popping the camera refocuses this tab, which would push
 * the camera straight back and trap the user. `pushedRef` alternates, so the
 * first focus launches the camera and the focus caused by the pop sends the user
 * to Collection instead. That covers the back BUTTON and the back-SWIPE
 * identically, which matters because the swipe never runs our exit handler.
 */
export default function ScanTab() {
  const router = useRouter();
  const pushedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!pushedRef.current) {
        pushedRef.current = true;
        router.push('/scan-camera' as never);
        return;
      }
      // Back from the camera. Land on Collection rather than this empty tab.
      pushedRef.current = false;
      router.replace('/' as never);
    }, [router]),
  );

  // Black, not transparent: this is visible for one frame behind the push, and
  // black matches the camera it becomes rather than flashing the light surface.
  return (
    <View style={{ backgroundColor: '#000000', flex: 1 }} testID="scan-tab-launcher">
      <StatusBar style="light" />
    </View>
  );
}
