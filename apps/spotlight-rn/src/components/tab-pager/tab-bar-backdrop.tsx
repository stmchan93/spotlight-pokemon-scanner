import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { colors } from '@spotlight/design-system';

import { TAB_BAR_BACKDROP_BLUR_INTENSITY, tabBarBottomFadeHeight } from '@/lib/tab-bar-insets';

/**
 * What every non-Scan tab page draws under the floating tab bar: Figma
 * 5938:16991 "Bottom gradient" — a 95pt layer with a 4px backdrop blur and a
 * white wash from 70% at the bottom edge to clear at 93.684% of its height.
 * Rendered by the pager for each page, so Home, Watchlist, Events and
 * Collection cannot drift apart.
 *
 * ONE uniform blur, as Figma draws it. The earlier stack of progressively
 * stronger blur bands showed grey seams at every band edge (owner, 2026-11-16).
 * The blur is a sibling of the page, never a parent of the tab bar's GlassView,
 * and nothing here animates opacity (an effect view at alpha < 1 stops
 * rendering — see `AppTabBar`).
 *
 * ANDROID: the wash only. expo-blur on Android needs a `BlurTargetView`
 * wrapping the content to blur at all; without it, it is only a tint.
 *
 * `epoch` re-keys the blur so it is rebuilt after the pager was frozen or
 * covered (see `TabPagerView`), the same recovery the bar's glass gets.
 */
export function TabBarBackdrop({ barHeight, epoch = 0 }: { barHeight: number; epoch?: number }) {
  if (barHeight <= 0) {
    return null;
  }
  return (
    <View pointerEvents="none" style={[styles.anchor, { height: tabBarBottomFadeHeight }]} testID="tab-bar-backdrop-fade">
      {Platform.OS === 'ios' ? (
        <BlurView
          intensity={TAB_BAR_BACKDROP_BLUR_INTENSITY}
          key={epoch}
          style={StyleSheet.absoluteFill}
          testID="tab-bar-backdrop-blur"
          tint="default"
        />
      ) : null}
      <Svg height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <LinearGradient id="tabBarBottomFade" x1="0" x2="0" y1="1" y2="0">
            <Stop offset="0" stopColor={colors.gray0} stopOpacity="0.7" />
            <Stop offset="0.93684" stopColor={colors.gray0} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#tabBarBottomFade)" height="100%" width="100%" x="0" y="0" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
