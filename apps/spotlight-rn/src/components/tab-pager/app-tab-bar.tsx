import { BlurView } from 'expo-blur';
import { ProfileCircle } from 'iconoir-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Platform, Pressable, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import Reanimated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  GlassSurface,
  colors,
  isLiquidGlassAvailable,
  layout,
  radii,
  shadows,
  spacing,
  textStyles,
} from '@spotlight/design-system';

import { TAB_ICON_POINTS, useCircularTabAvatar } from '@/components/circular-tab-avatar';
import {
  SCAN_PAGE_INDEX,
  TAB_PAGER_ORDER,
  pageSelectedness,
  scanProximity,
  type PagerTab,
} from '@/lib/tab-pager';
import { useAuth } from '@/providers/auth-provider';

/**
 * The app's bottom tab bar, drawn in JS so the strip above it can be dragged.
 *
 * ONE BAR, TWO LOOKS, BLENDED BY THE DRAG. Every page but Scan gets the light
 * bar; Scan gets the solid black scanner bar (Figma 6145:5694 / 6322:9081).
 * Both are drawn at once and cross-faded by `scanProximity(position)`, and every
 * colour (labels, icon tints, the selection pill) is interpolated on the UI
 * thread from the same strip position, so dragging toward Scan darkens the bar
 * in step with the finger.
 *
 * LIGHT MATERIAL, per platform — the same rule `GlassSurface` follows:
 *   - iOS 26 (real Liquid Glass): a `GlassView` capsule behind the items, like
 *     the system bar this replaced;
 *   - older iOS: a full-width `BlurView` with a hairline — the classic UITabBar;
 *   - Android: solid `canvasElevated`, which is exactly what the Material bar
 *     was pinned to (no wallpaper-derived Material You colours).
 *
 * GEOMETRY is the scanner bar's, everywhere: 8pt top padding, the 54pt Figma
 * row (16pt side insets) and `max(25, home indicator)` below. Keeping one
 * geometry means nothing jumps when the dark bar fades in, and
 * `getAppTabBarHeight` is the single number pages inset themselves by.
 */

export const TAB_BAR_LABELS: Record<PagerTab, string> = {
  index: 'HOME',
  wishlist: 'WATCHLIST',
  scan: 'SCAN',
  events: 'EVENTS',
  social: 'SOCIAL',
};

const ICON_SIZE = 24;
const AVATAR_SIZE = TAB_ICON_POINTS;
// Figma tab cell: column, gap 1, padding 6/7 vertical — not on the spacing scale.
const TAB_PADDING_TOP = 6;
const TAB_PADDING_BOTTOM = 7;
const TAB_GAP = 1;
// The iOS 26 glass capsule hugs the item row by this much on every side.
const GLASS_OUTSET = 4;
const ROW_SIDE_INSET = spacing.sm;
const ROW_TOP_INSET = spacing.xxs;

const LIGHT_UNSELECTED = colors.gray600;
const LIGHT_SELECTED = colors.gray900;
const DARK_UNSELECTED = colors.gray300;
const DARK_SELECTED = colors.gray0;
const LIGHT_PILL = colors.gray100;
const DARK_PILL = colors.gray800;

/** Total bar height for a given home-indicator / navigation-bar inset. */
export function getAppTabBarHeight(bottomInset: number): number {
  return ROW_TOP_INSET + layout.tabBarRowHeight + Math.max(layout.tabBarMinBottomPadding, bottomInset);
}

/**
 * The WINDOW's bottom inset (home indicator / Android navigation bar), never a
 * tab bar. `initialWindowMetrics` first, like the scanner's own layout, so the
 * bar and the scanner's reserved space are always computed from the same number.
 */
export function useTabBarBottomInset(): number {
  const insets = useSafeAreaInsets();
  return initialWindowMetrics?.insets.bottom ?? insets.bottom;
}

const TAB_ICONS: Partial<Record<PagerTab, { outline: ImageSourcePropType; filled: ImageSourcePropType }>> = {
  index: {
    outline: require('../../../assets/images/tab-icons/home.png'),
    filled: require('../../../assets/images/tab-icons/home-filled.png'),
  },
  wishlist: {
    outline: require('../../../assets/images/tab-icons/wishlist.png'),
    filled: require('../../../assets/images/tab-icons/wishlist-filled.png'),
  },
  events: {
    outline: require('../../../assets/images/tab-icons/events.png'),
    filled: require('../../../assets/images/tab-icons/events-filled.png'),
  },
};

function blendColor(selected: number, scan: number): string {
  'worklet';
  const light = interpolateColor(selected, [0, 1], [LIGHT_UNSELECTED, LIGHT_SELECTED]);
  const dark = interpolateColor(selected, [0, 1], [DARK_UNSELECTED, DARK_SELECTED]);
  return interpolateColor(scan, [0, 1], [light, dark]);
}

/** Viewfinder: four corner brackets in the 24pt icon box (as the scanner bar drew it). */
function ViewfinderGlyph({ color }: { color: string }) {
  return (
    <Svg fill="none" height={ICON_SIZE} viewBox="0 0 20 20" width={ICON_SIZE}>
      <Path
        d="M1 6.5V4a3 3 0 0 1 3-3h2.5M13.5 1H16a3 3 0 0 1 3 3v2.5M19 13.5V16a3 3 0 0 1-3 3h-2.5M6.5 19H4a3 3 0 0 1-3-3v-2.5"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={1.4}
      />
    </Svg>
  );
}

/** Two copies of a glyph that cannot take an animated colour, cross-faded light -> dark. */
function CrossfadeGlyph({
  position,
  render,
  lightColor,
  darkColor,
}: {
  darkColor: string;
  lightColor: string;
  position: SharedValue<number>;
  render: (color: string) => ReactNode;
}) {
  const darkStyle = useAnimatedStyle(() => ({ opacity: scanProximity(position.value) }));
  const lightStyle = useAnimatedStyle(() => ({ opacity: 1 - scanProximity(position.value) }));
  return (
    <View style={styles.glyphBox}>
      <Reanimated.View style={[StyleSheet.absoluteFill, styles.center, lightStyle]}>{render(lightColor)}</Reanimated.View>
      <Reanimated.View style={[StyleSheet.absoluteFill, styles.center, darkStyle]}>{render(darkColor)}</Reanimated.View>
    </View>
  );
}

function TintedIcon({
  icons,
  page,
  position,
}: {
  icons: { outline: ImageSourcePropType; filled: ImageSourcePropType };
  page: number;
  position: SharedValue<number>;
}) {
  const tint = useAnimatedStyle(() => ({
    tintColor: blendColor(pageSelectedness(position.value, page), scanProximity(position.value)),
  }));
  // The filled variant (Figma 4299:95029) fades in as the page arrives.
  const filled = useAnimatedStyle(() => ({ opacity: pageSelectedness(position.value, page) }));
  const outline = useAnimatedStyle(() => ({ opacity: 1 - pageSelectedness(position.value, page) }));
  return (
    <View style={styles.glyphBox}>
      <Reanimated.Image source={icons.outline} style={[styles.icon, tint, outline]} />
      <Reanimated.Image source={icons.filled} style={[styles.icon, styles.iconOverlay, tint, filled]} />
    </View>
  );
}

/**
 * The account photo, drawn directly from its URL (a React view can clip it;
 * the circular raster only existed because a NATIVE tab item could not), then
 * the raster, then the outline glyph.
 */
function SocialAvatar({ focused, position }: { focused: boolean; position: SharedValue<number> }) {
  const { currentUser } = useAuth();
  const avatarURL = currentUser?.avatarURL ?? null;
  const raster = useCircularTabAvatar();
  const [failedURL, setFailedURL] = useState<string | null>(null);
  useEffect(() => setFailedURL(null), [avatarURL]);

  const photo = avatarURL && failedURL !== avatarURL ? { uri: avatarURL } : raster;
  if (!photo) {
    return (
      <CrossfadeGlyph
        darkColor={DARK_UNSELECTED}
        lightColor={focused ? LIGHT_SELECTED : LIGHT_UNSELECTED}
        position={position}
        render={(color) => (
          <ProfileCircle color={color} height={ICON_SIZE} strokeWidth={1.6} testID="app-tab-bar-avatar-glyph" width={ICON_SIZE} />
        )}
      />
    );
  }
  return (
    <View style={styles.avatarClip} testID="app-tab-bar-avatar">
      <Image
        onError={() => setFailedURL(avatarURL)}
        source={photo}
        style={styles.avatarImage}
        testID="app-tab-bar-avatar-image"
      />
    </View>
  );
}

function TabLabel({ label, page, position }: { label: string; page: number; position: SharedValue<number> }) {
  const color = useAnimatedStyle(() => ({
    color: blendColor(pageSelectedness(position.value, page), scanProximity(position.value)),
  }));
  return (
    <Reanimated.Text numberOfLines={1} style={[styles.label, color]}>
      {label}
    </Reanimated.Text>
  );
}

function LightMaterial({ position }: { position: SharedValue<number> }) {
  const fade = useAnimatedStyle(() => ({ opacity: 1 - scanProximity(position.value) }));
  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fade]} testID="app-tab-bar-glass">
        {/* The lift is what separates the capsule from the pages' white bottom fade;
            glass over white with no shadow reads as a washed-out smear. */}
        <View style={[styles.glassCapsule, shadows.glassPill]} testID="app-tab-bar-glass-lift">
          <GlassSurface fallbackColor={colors.canvasElevated} style={styles.glassFill} />
        </View>
      </Reanimated.View>
    );
  }
  if (Platform.OS === 'ios') {
    return (
      <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.hairline, fade]} testID="app-tab-bar-blur">
        <BlurView intensity={80} style={StyleSheet.absoluteFill} tint="systemChromeMaterialLight" />
      </Reanimated.View>
    );
  }
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.solid, fade]}
      testID="app-tab-bar-solid"
    />
  );
}

export type AppTabBarProps = {
  bottomInset: number;
  /** The settled/focused page, for accessibility state. */
  focusedPage: number;
  onSelectPage: (page: number) => void;
  /** Strip position in pages (0 = Home), shared with the pager. */
  position: SharedValue<number>;
};

export function AppTabBar({ bottomInset, focusedPage, onSelectPage, position }: AppTabBarProps) {
  const dark = useAnimatedStyle(() => ({ opacity: scanProximity(position.value) }));
  const rowWidth = useSharedValue(0);
  const pill = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(scanProximity(position.value), [0, 1], [LIGHT_PILL, DARK_PILL]),
    // The pill slides with the strip, one tab cell per page.
    transform: [{
      translateX: (Math.min(Math.max(position.value, 0), TAB_PAGER_ORDER.length - 1) * rowWidth.value)
        / TAB_PAGER_ORDER.length,
    }],
  }));

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { height: getAppTabBarHeight(bottomInset) }]}
      testID="app-tab-bar"
    >
      <LightMaterial position={position} />
      <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.darkSlab, dark]} testID="app-tab-bar-dark" />
      <View
        onLayout={(event) => {
          rowWidth.value = event.nativeEvent.layout.width;
        }}
        style={styles.row}
      >
        <Reanimated.View pointerEvents="none" style={[styles.selection, pill]} testID="app-tab-bar-selection" />
        {TAB_PAGER_ORDER.map((tab, page) => {
          const label = TAB_BAR_LABELS[tab];
          const isSelected = page === focusedPage;
          const icons = TAB_ICONS[tab];
          let icon: ReactNode;
          if (icons) {
            icon = <TintedIcon icons={icons} page={page} position={position} />;
          } else if (page === SCAN_PAGE_INDEX) {
            icon = (
              <CrossfadeGlyph
                darkColor={DARK_SELECTED}
                lightColor={LIGHT_UNSELECTED}
                position={position}
                render={(color) => <ViewfinderGlyph color={color} />}
              />
            );
          } else {
            icon = <SocialAvatar focused={isSelected} position={position} />;
          }
          return (
            <Pressable
              accessibilityLabel={label.toLowerCase()}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelected }}
              key={tab}
              onPress={() => onSelectPage(page)}
              style={styles.tab}
              testID={`app-tab-${tab}`}
            >
              <View style={styles.iconSlot}>{icon}</View>
              <TabLabel label={label} page={page} position={position} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The bar frozen on one page, for surfaces rendered outside the pager (the
 * scanner dev-screen route used for design screenshots).
 */
export function StaticAppTabBar({ page, onSelectPage }: { onSelectPage?: (page: number) => void; page: number }) {
  const position = useSharedValue(page);
  const bottomInset = useTabBarBottomInset();
  return (
    <AppTabBar
      bottomInset={bottomInset}
      focusedPage={page}
      onSelectPage={onSelectPage ?? (() => undefined)}
      position={position}
    />
  );
}

const styles = StyleSheet.create({
  avatarClip: {
    // Backing so a transparent photo still reads. No ring: a border also
    // pushed the photo 1pt off-centre inside this clip.
    backgroundColor: colors.gray200,
    borderCurve: 'continuous',
    borderRadius: AVATAR_SIZE / 2,
    height: AVATAR_SIZE,
    overflow: 'hidden',
    width: AVATAR_SIZE,
  },
  avatarImage: {
    height: AVATAR_SIZE,
    width: AVATAR_SIZE,
  },
  bar: {
    bottom: 0,
    left: 0,
    paddingHorizontal: ROW_SIDE_INSET,
    paddingTop: ROW_TOP_INSET,
    position: 'absolute',
    right: 0,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  darkSlab: {
    backgroundColor: colors.scannerTray,
  },
  glassCapsule: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: layout.tabBarRowHeight + GLASS_OUTSET * 2,
    left: ROW_SIDE_INSET - GLASS_OUTSET,
    position: 'absolute',
    right: ROW_SIDE_INSET - GLASS_OUTSET,
    top: ROW_TOP_INSET - GLASS_OUTSET,
  },
  glassFill: {
    ...StyleSheet.absoluteFillObject,
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  glyphBox: {
    height: ICON_SIZE,
    width: ICON_SIZE,
  },
  hairline: {
    borderTopColor: colors.gray200,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    height: ICON_SIZE,
    width: ICON_SIZE,
  },
  iconOverlay: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  iconSlot: {
    alignItems: 'center',
    height: layout.tabBarIconSlotHeight,
    justifyContent: 'center',
  },
  label: {
    ...textStyles.tabLabel,
  },
  row: {
    flexDirection: 'row',
    height: layout.tabBarRowHeight,
  },
  selection: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: `${100 / TAB_PAGER_ORDER.length}%`,
  },
  solid: {
    backgroundColor: colors.canvasElevated,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: TAB_GAP,
    paddingBottom: TAB_PADDING_BOTTOM,
    paddingTop: TAB_PADDING_TOP,
  },
});
