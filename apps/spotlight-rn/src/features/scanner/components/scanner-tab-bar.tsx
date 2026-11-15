import { ProfileCircle } from 'iconoir-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Text, colors, layout, radii, spacing, textStyles } from '@spotlight/design-system';

import { TAB_ICON_POINTS, useCircularTabAvatar } from '@/components/circular-tab-avatar';
import { useAuth } from '@/providers/auth-provider';

/**
 * The Scanner's own bottom tab bar (Figma 6145:5694): solid black, drawn in JS.
 *
 * The native iOS 26 bar is always Liquid Glass and cannot be solid, so it stays
 * HIDDEN on /scan (`(tabs)/_layout.tsx`) and this one is drawn instead, on the
 * scanner only. It is a sibling BELOW the capture surface, never over it: the
 * tray shell ends at this bar's top edge, so the tray's RNGH pan (which Android
 * hit-tests by view bounds) can never claim a tap meant for a tab.
 *
 * Navigation is the caller's: `(tabs)/scan.tsx` switches tabs through the
 * react-navigation tab navigator, the same path the exit button uses.
 */

export type ScannerTabName = 'index' | 'wishlist' | 'scan' | 'events' | 'social';

// Same sizes as the native tab bar on every other tab: its icon PNGs are 24pt
// and the avatar raster is TAB_ICON_POINTS (28pt).
const ICON_SIZE = 24;
const AVATAR_SIZE = TAB_ICON_POINTS;
// Figma tab cell: column, gap 1, padding 6/7 vertical — not on the spacing scale.
const TAB_PADDING_TOP = 6;
const TAB_PADDING_BOTTOM = 7;
const TAB_GAP = 1;

/** Total bar height for a given home-indicator inset. */
export function getScannerTabBarHeight(bottomInset: number): number {
  return spacing.xxs + layout.tabBarRowHeight + Math.max(layout.tabBarMinBottomPadding, bottomInset);
}

/** SF Symbols `viewfinder`: four corner brackets, drawn in the 24pt icon box. */
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

/** The native bar's own icon artwork, tinted white for the black bar. */
function TabIcon({ source }: { source: ImageSourcePropType }) {
  return <Image source={source} style={styles.icon} />;
}

function SocialAvatar() {
  // This bar is a React view, so it can draw the photo URL directly. The circular
  // raster exists for the NATIVE tab bar and only lands after an offscreen render,
  // which left this bar on the outline glyph.
  const { currentUser } = useAuth();
  const avatarURL = currentUser?.avatarURL ?? null;
  const raster = useCircularTabAvatar();
  const avatar = avatarURL ? { uri: avatarURL } : raster;
  // A photo that fails to load drew an empty circle, i.e. no Social icon.
  const [failedURL, setFailedURL] = useState<string | null>(null);
  useEffect(() => setFailedURL(null), [avatarURL]);
  if (!avatar || (avatarURL !== null && failedURL === avatarURL)) {
    return <ProfileCircle color={colors.gray0} height={ICON_SIZE} strokeWidth={1.6} width={ICON_SIZE} />;
  }
  return (
    <View style={styles.avatarClip} testID="scanner-tab-bar-avatar">
      <Image onError={() => setFailedURL(avatarURL)} source={avatar} style={styles.avatarImage} />
    </View>
  );
}

type TabSpec = { icon: ReactNode; label: string; name: ScannerTabName };

export function ScannerTabBar({
  bottomInset,
  onSelectTab,
  selected = 'scan',
}: {
  bottomInset: number;
  onSelectTab: (tab: ScannerTabName) => void;
  selected?: ScannerTabName;
}) {
  const iconColor = colors.gray0;
  const tabs: TabSpec[] = [
    { icon: <TabIcon source={require('../../../../assets/images/tab-icons/home.png')} />, label: 'HOME', name: 'index' },
    { icon: <TabIcon source={require('../../../../assets/images/tab-icons/wishlist.png')} />, label: 'WATCHLIST', name: 'wishlist' },
    { icon: <ViewfinderGlyph color={iconColor} />, label: 'SCAN', name: 'scan' },
    { icon: <TabIcon source={require('../../../../assets/images/tab-icons/events.png')} />, label: 'EVENTS', name: 'events' },
    { icon: <SocialAvatar />, label: 'SOCIAL', name: 'social' },
  ];

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        { paddingBottom: Math.max(layout.tabBarMinBottomPadding, bottomInset) },
      ]}
      testID="scanner-tab-bar"
    >
      <View style={styles.row}>
        {tabs.map((tab) => {
          const isSelected = tab.name === selected;
          return (
            <Pressable
              accessibilityLabel={tab.label.toLowerCase()}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelected }}
              key={tab.name}
              // The current tab is a no-op, like a native bar re-tap.
              onPress={isSelected ? undefined : () => onSelectTab(tab.name)}
              style={styles.tab}
              testID={`scanner-tab-${tab.name}`}
            >
              {isSelected ? <View pointerEvents="none" style={styles.selection} testID="scanner-tab-selection" /> : null}
              <View style={styles.iconSlot}>{tab.icon}</View>
              <Text
                numberOfLines={1}
                style={[styles.label, isSelected ? styles.labelSelected : null]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.scannerTray,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxs,
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    height: layout.tabBarRowHeight,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: TAB_GAP,
    paddingBottom: TAB_PADDING_BOTTOM,
    paddingTop: TAB_PADDING_TOP,
  },
  selection: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.gray800,
    borderCurve: 'continuous',
    borderRadius: radii.pill,
  },
  iconSlot: {
    alignItems: 'center',
    height: layout.tabBarIconSlotHeight,
    justifyContent: 'center',
  },
  label: {
    ...textStyles.tabLabel,
    color: colors.gray300,
  },
  labelSelected: {
    color: colors.gray0,
  },
  icon: {
    height: ICON_SIZE,
    tintColor: colors.gray0,
    width: ICON_SIZE,
  },
  avatarClip: {
    // Backing so a transparent photo still reads on the black bar. No ring.
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
});
