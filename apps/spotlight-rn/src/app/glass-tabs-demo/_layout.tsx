// Icon/Label are statics on Trigger in expo-router 55, not top-level exports.
import { NativeTabs } from 'expo-router/unstable-native-tabs';

const { Trigger } = NativeTabs;
const { Icon, Label } = Trigger;

/**
 * THROWAWAY SPIKE — delete once the native-tab decision is made.
 *
 * Renders Apple's real `UITabBarController` (via react-native-screens' TabsHost,
 * which expo-router wraps) so we can see the genuine iOS 26 Liquid Glass tab bar
 * on device before deciding whether to adopt it app-wide.
 *
 * WHY THIS IS SEPARATE FROM THE LIVE CHROME
 * The app's real tab bar is a custom JS bar (`app-bottom-tab-bar.tsx`) sitting on
 * a custom swipe pager (`top-tabs-pager.tsx`), with glass painted on by our own
 * `GlassSurface`. Native tabs would replace BOTH, and native tab bars cannot
 * swipe between tabs — so adopting them costs the Portfolio↔Scanner swipe. That
 * tradeoff is the whole point of looking at this first, so nothing here imports
 * from or modifies the live chrome.
 *
 * WHAT TO LOOK FOR
 * - The bar should be real Liquid Glass on an iOS 26 device: content refracts
 *   through it as you scroll, not a flat blur. Compare against today's bar.
 * - `minimizeBehavior="onScrollDown"` is the collapse-to-active-icon that our
 *   June spec ruled out as impossible without Apple's tab controller. Scroll
 *   down inside a tab to see it shrink, scroll up to bring it back.
 * - Off iOS 26 (or on Android) this degrades to a normal solid native tab bar —
 *   absence of glass there is expected, not a bug.
 */
export default function GlassTabsDemoLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <Trigger name="index">
        <Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <Label>Collection</Label>
      </Trigger>
      <Trigger name="scan">
        <Icon sf={{ default: 'viewfinder', selected: 'viewfinder' }} />
        <Label>Scan</Label>
      </Trigger>
      <Trigger name="social">
        <Icon sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }} />
        <Label>Social</Label>
      </Trigger>
    </NativeTabs>
  );
}
