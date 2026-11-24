import { BlurView } from 'expo-blur';
import { ProfileCircle, Settings } from 'iconoir-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Platform, Pressable, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import Reanimated, {
  interpolateColor,
  runOnJS,
  useAnimatedReaction,
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
 *
 * SETTINGS is not a tab: a round button of the same material sits right of the
 * capsule (Figma "Tab Bar - iPhone", 6725:9509, where it is a "…"), as tall as
 * the capsule, and pushes the `/settings` stack route.
 */

export const TAB_BAR_LABELS: Record<PagerTab, string> = {
  index: 'HOME',
  search: 'SEARCH',
  scan: 'SCAN',
  social: 'SOCIAL',
};

const ICON_SIZE = 24;
const AVATAR_SIZE = TAB_ICON_POINTS;
// Figma tab cell: column, gap 1, padding 6/7 vertical — not on the spacing scale.
const TAB_PADDING_TOP = 6;
const TAB_PADDING_BOTTOM = 7;
const TAB_GAP = 1;
// Labels never grow with the system text size (the cell is a fixed 1/5 of the
// bar) and may shrink to 80% before ellipsizing.
const TAB_LABEL_MAX_FONT_SCALE = 1;
const TAB_LABEL_MIN_FONT_SCALE = 0.8;
// The iOS 26 glass capsule hugs the item row by this much on every side.
const GLASS_OUTSET = 4;
const ROW_SIDE_INSET = spacing.sm;
const ROW_TOP_INSET = spacing.xxs;
// The Settings circle: the capsule's full height, `spacing.xxs` clear of it.
const SETTINGS_BUTTON_SIZE = layout.tabBarRowHeight + GLASS_OUTSET * 2;
const SETTINGS_BUTTON_GAP = spacing.xxs;

// Unselected tabs on light pages are full-strength ink: gray600 on the light
// bar read as disabled ("feels greyed out", user 2026-11-16). The selected tab
// is marked by its pill and filled icon, not by dimming the others.
const LIGHT_UNSELECTED = colors.gray900;
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
  // Figma 6642:16373: iconoir Search; selected = the same glyph, heavier
  // (`tools/generate_tab_icons.py`).
  search: {
    outline: require('../../../assets/images/tab-icons/search.png'),
    filled: require('../../../assets/images/tab-icons/search-filled.png'),
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

function TabLabel({
  label,
  page,
  position,
  tab,
}: {
  label: string;
  page: number;
  position: SharedValue<number>;
  tab: PagerTab;
}) {
  const color = useAnimatedStyle(() => ({
    color: blendColor(pageSelectedness(position.value, page), scanProximity(position.value)),
  }));
  return (
    <Reanimated.Text
      // WATCHLIST, then the longest label, was ellipsized under larger text sizes
      // ("watchlist label is blocked", design review 2026-11-16): this raw Text
      // took the device's full font scale into a fixed 1/5-width cell. Tab
      // labels hold their size like UITabBar's, and shrink rather than clip on
      // the narrowest phones.
      adjustsFontSizeToFit
      maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
      minimumFontScale={TAB_LABEL_MIN_FONT_SCALE}
      numberOfLines={1}
      style={[styles.label, color]}
      testID={`app-tab-label-${tab}`}
    >
      {label}
    </Reanimated.Text>
  );
}

function SettingsCircle({ onOpenSettings, position }: { onOpenSettings?: () => void; position: SharedValue<number> }) {
  const [onScan, setOnScan] = useState(false);
  useAnimatedReaction(
    () => scanProximity(position.value) > 0.5,
    (next, previous) => {
      if (next !== previous) {
        runOnJS(setOnScan)(next);
      }
    },
  );
  const fade = useAnimatedStyle(() => ({ opacity: 1 - scanProximity(position.value) }));
  return (
    <Reanimated.View pointerEvents={onScan ? 'none' : 'auto'} style={[styles.settingsButton, fade]}>
      <Pressable
        accessibilityElementsHidden={onScan}
        accessibilityLabel="settings"
        accessibilityRole="button"
        hitSlop={GLASS_OUTSET}
        onPress={onOpenSettings}
        style={styles.settingsPress}
        testID="app-tab-settings-button"
      >
        <CrossfadeGlyph
          darkColor={DARK_UNSELECTED}
          lightColor={LIGHT_UNSELECTED}
          position={position}
          render={(color) => <Settings color={color} height={ICON_SIZE} strokeWidth={1.6} width={ICON_SIZE} />}
        />
      </Pressable>
    </Reanimated.View>
  );
}

const GLASS_LIFT_SHADOW_OPACITY = shadows.glassPill.shadowOpacity;

function LightMaterial({ glassEpoch, position }: { glassEpoch: number; position: SharedValue<number> }) {
  // Android's solid View is not an effect view, so it may fade.
  const fade = useAnimatedStyle(() => ({ opacity: 1 - scanProximity(position.value) }));
  // Fades the lift's shadow only. Never put opacity < 1 on the glass or its
  // parents: UIKit's effect view stops rendering after it has sat at alpha 0
  // (Scan) across a full-screen presentation, leaving a see-through bar. The
  // opaque dark slab drawn above covers the glass on Scan instead.
  const lift = useAnimatedStyle(() => ({
    shadowOpacity: GLASS_LIFT_SHADOW_OPACITY * (1 - scanProximity(position.value)),
  }));
  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="app-tab-bar-glass">
        {/* The lift separates the capsule from what is under it; glass over
            white with no shadow reads as a washed-out smear. */}
        <Reanimated.View style={[styles.glassCapsule, shadows.glassPill, lift]} testID="app-tab-bar-glass-lift">
          {/* frostTint gives the glass a floor: untinted glass is only as bright as
              the page behind it and read as see-through over content. */}
          {/* Keyed by `glassEpoch`: rebuilt fresh after the pager was frozen or
              covered, since UIKit can bring an effect view back blank. */}
          <GlassSurface key={glassEpoch} fallbackColor={colors.canvasElevated} glassTintColor={colors.frostTint} style={styles.glassFill} />
        </Reanimated.View>
        <Reanimated.View style={[styles.settingsGlass, shadows.glassPill, lift]} testID="app-tab-bar-settings-glass">
          <GlassSurface key={glassEpoch} fallbackColor={colors.canvasElevated} glassTintColor={colors.frostTint} style={styles.glassFill} />
        </Reanimated.View>
      </View>
    );
  }
  if (Platform.OS === 'ios') {
    return (
      // No opacity here either: a BlurView is the same UIKit effect view as the
      // glass. The opaque dark slab covers it on Scan.
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.hairline]} testID="app-tab-bar-blur">
        <BlurView intensity={80} key={glassEpoch} style={StyleSheet.absoluteFill} tint="systemChromeMaterialLight" />
      </View>
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
  /**
   * Bumped by the pager when it comes back from being covered (pushed screen,
   * full-screen presentation, background). Re-keys the light material's effect
   * view so it is rebuilt rather than left blank. Defaults to 0.
   */
  glassEpoch?: number;
  /** The Settings circle beside the bar. */
  onOpenSettings?: () => void;
  onSelectPage: (page: number) => void;
  /** Strip position in pages (0 = Home), shared with the pager. */
  position: SharedValue<number>;
};

export function AppTabBar({
  bottomInset,
  focusedPage,
  glassEpoch = 0,
  onOpenSettings,
  onSelectPage,
  position,
}: AppTabBarProps) {
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
      <LightMaterial glassEpoch={glassEpoch} position={position} />
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
              <TabLabel label={label} page={page} position={position} tab={tab} />
            </Pressable>
          );
        })}
      </View>
      {/* Figma 6711:5942: Scan's bar is the capsule alone, so the circle fades out there. */}
      <SettingsCircle onOpenSettings={onOpenSettings} position={position} />
    </View>
  );
}

/**
 * The bar frozen on one page, for surfaces rendered outside the pager (the
 * scanner dev-screen route used for design screenshots).
 */
export function StaticAppTabBar({
  onOpenSettings,
  onSelectPage,
  page,
}: {
  onOpenSettings?: () => void;
  onSelectPage?: (page: number) => void;
  page: number;
}) {
  const position = useSharedValue(page);
  const bottomInset = useTabBarBottomInset();
  return (
    <AppTabBar
      bottomInset={bottomInset}
      focusedPage={page}
      onOpenSettings={onOpenSettings}
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
    right: ROW_SIDE_INSET - GLASS_OUTSET + SETTINGS_BUTTON_SIZE + SETTINGS_BUTTON_GAP,
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
    // Room for the Settings circle; the capsule and circle are SETTINGS_BUTTON_GAP apart.
    marginRight: SETTINGS_BUTTON_SIZE + SETTINGS_BUTTON_GAP,
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
  settingsButton: {
    alignItems: 'center',
    height: SETTINGS_BUTTON_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    right: ROW_SIDE_INSET - GLASS_OUTSET,
    top: ROW_TOP_INSET - GLASS_OUTSET,
    width: SETTINGS_BUTTON_SIZE,
  },
  settingsPress: {
    alignItems: 'center',
    height: SETTINGS_BUTTON_SIZE,
    justifyContent: 'center',
    width: SETTINGS_BUTTON_SIZE,
  },
  settingsGlass: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: SETTINGS_BUTTON_SIZE,
    position: 'absolute',
    right: ROW_SIDE_INSET - GLASS_OUTSET,
    top: ROW_TOP_INSET - GLASS_OUTSET,
    width: SETTINGS_BUTTON_SIZE,
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
