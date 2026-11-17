import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { colors } from '@spotlight/design-system';

import {
  TAB_BAR_BLUR_BANDS,
  tabBarBlurHeight,
  tabBarBottomFadeHeight,
} from '@/lib/tab-bar-insets';

/**
 * What every non-Scan tab page draws under the floating tab bar. Rendered by
 * the pager for each page, so Home, Watchlist, Events and Social cannot drift
 * apart (they used to draw their own fades, and two of the four did not).
 *
 * iOS: a PROGRESSIVE BLUR — strongest at the screen's bottom edge, clear a
 * little above the bar. Real blur, no white wash (owner, 2026-11-16). expo-blur
 * has no gradient mask and we add no native dependency for one, so it is a
 * stack of bands: each starts lower and blurs harder than the one before it,
 * which steps the strength up toward the edge. The bands are siblings of the
 * page, never parents of the tab bar's GlassView, and nothing here animates
 * opacity (an effect view at alpha < 1 stops rendering — see `AppTabBar`).
 *
 * ANDROID: the white 70% -> clear fade the pages drew before. expo-blur on
 * Android needs a `BlurTargetView` wrapping the content to blur at all; without
 * it, it is only a translucent tint. The bar there is opaque and the page is
 * already inset above it, so the fade over the last row is all that shows.
 *
 * `epoch` re-keys the blur bands so they are rebuilt after the pager was frozen
 * or covered (see `TabPagerView`), the same recovery the bar's glass gets.
 */
export function TabBarBackdrop({ barHeight, epoch = 0 }: { barHeight: number; epoch?: number }) {
  if (barHeight <= 0) {
    return null;
  }
  if (Platform.OS === 'ios') {
    const height = tabBarBlurHeight(barHeight);
    return (
      <View pointerEvents="none" style={[styles.anchor, { height }]} testID="tab-bar-backdrop-blur">
        {TAB_BAR_BLUR_BANDS.map((band, index) => (
          <BlurView
            intensity={band.intensity}
            key={`${epoch}-${index}`}
            style={[styles.band, { height: height * band.heightFraction }]}
            testID="tab-bar-backdrop-band"
            tint="default"
          />
        ))}
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[styles.anchor, { height: tabBarBottomFadeHeight }]} testID="tab-bar-backdrop-fade">
      <Svg height="100%" width="100%">
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
  band: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
