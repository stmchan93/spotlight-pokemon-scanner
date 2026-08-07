import { useCallback, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabBar, useSpotlightTheme } from '@spotlight/design-system';

import { useTabBarCollapsed } from '@/contexts/tab-bar-chrome-context';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { CollectionNavSymbol, ScanNavSymbol, WishlistNavSymbol } from './nav-tab-symbols';

export type AppBottomTabKey = 'portfolio' | 'scan' | 'wishlist';

// A tab nav pushes/replaces a route; the transition takes a few hundred ms during
// which the OUTGOING screen's tab bar is still tappable. A fast second tap to the
// same destination would fire the navigation again — pushing a DUPLICATE screen
// (two Wishlist entries), so Back/swipe-back lands on a stale copy. Coalesce
// repeat navigations to the same destination inside one transition window.
const NAV_DEBOUNCE_MS = 600;

type AppBottomTabBarProps = {
  activeKey?: AppBottomTabKey | null;
  // Pushed (stack) screens (wishlist/transactions/insights) set this so a
  // Collection/Wishlist tab tap collapses the pushed stack back to the
  // target tab instead of pushing a duplicate `(tabs)` route on top (which made
  // Back return to the page you left). Scan is the exception: it always pushes,
  // so Back returns to the pushed screen the user scanned from (see goToScan below).
  dismissToTabs?: boolean;
  onPressPortfolio?: () => void;
  onPressScan?: () => void;
  onPressWishlist?: () => void;
};

export function AppBottomTabBar({
  activeKey = null,
  dismissToTabs = false,
  onPressPortfolio,
  onPressScan,
  onPressWishlist,
}: AppBottomTabBarProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Guests can scan freely but Collection/Wishlist are gated behind login.
  const { gate } = useGuestGate();
  // Reddit-style minimize-on-scroll: the bar morphs down to the active tab's
  // icon-only circle as the user scrolls the list, and expands on scroll-up.
  const collapsed = useTabBarCollapsed();

  const iconColor = theme.colors.textPrimary;
  // Reddit's active tab is a LIGHT-grey stadium, so the selected glyph stays
  // dark (filled) — same ink as the label beneath it — not a white knockout.
  const selectedIconColor = theme.colors.textPrimary;
  // Figma nav glyph size (node 1313:7454 — `size-[22px]`).
  const NAV_ICON_SIZE = 22;

  // Drop a repeat tap to the SAME destination inside the transition window (the
  // duplicate-push guard described above). Different destinations pass straight
  // through, so genuine tab switching stays instant.
  const lastNavRef = useRef<{ key: AppBottomTabKey; at: number } | null>(null);
  const runGuardedNav = useCallback((key: AppBottomTabKey, navigate: () => void) => {
    const now = Date.now();
    const last = lastNavRef.current;
    if (last && last.key === key && now - last.at < NAV_DEBOUNCE_MS) {
      return;
    }
    lastNavRef.current = { key, at: now };
    navigate();
  }, []);

  const goToPortfolio = onPressPortfolio
    ?? (() => runGuardedNav('portfolio', dismissToTabs
      ? () => router.dismissTo('/' as never)
      : () => router.push('/' as never)));
  // Scan, Collection and Wishlist are now TABS, not pager pages, so these
  // navigate to real routes rather than passing `page` params into the tabs
  // root. This bar only survives on pushed stack screens (insights,
  // transactions); the tabs themselves are drawn by UIKit.
  const goToScan = onPressScan
    ?? (() => runGuardedNav('scan', () => router.push('/scan' as never)));
  // Wishlist is a pushed stack screen: replace when already on a stack route
  // so the back-stack doesn't accumulate, push from the tabs root.
  const goToWishlist = onPressWishlist
    ?? (() => runGuardedNav('wishlist', dismissToTabs
      ? () => router.replace('/wishlist' as never)
      : () => router.push('/wishlist' as never)));

  // Tapping the tab you are already on is a no-op — re-navigating pushed a
  // duplicate screen instance (e.g. Wishlist re-opening itself, or a second
  // scanner with its own tray).
  const noop = () => {};

  return (
    <BottomTabBar
      bottomInset={Math.max(insets.bottom, 0)}
      collapsed={collapsed}
      items={[
        {
          key: 'portfolio',
          label: 'Portfolio',
          selected: activeKey === 'portfolio',
          onPress: activeKey === 'portfolio' ? noop : gate(goToPortfolio),
          testID: 'bottom-nav-portfolio',
          icon: <CollectionNavSymbol color={iconColor} filled={activeKey === 'portfolio'} size={NAV_ICON_SIZE} />,
          selectedIcon: <CollectionNavSymbol color={selectedIconColor} filled size={NAV_ICON_SIZE} />,
        },
        {
          key: 'scan',
          label: 'Scan',
          selected: activeKey === 'scan',
          onPress: activeKey === 'scan' ? noop : goToScan,
          testID: 'bottom-nav-scan',
          icon: <ScanNavSymbol color={iconColor} size={NAV_ICON_SIZE} />,
          selectedIcon: <ScanNavSymbol color={selectedIconColor} size={NAV_ICON_SIZE} />,
        },
        {
          key: 'wishlist',
          label: 'Wishlist',
          selected: activeKey === 'wishlist',
          onPress: activeKey === 'wishlist' ? noop : gate(goToWishlist),
          testID: 'bottom-nav-wishlist',
          // Bookmark fills in when the Wishlist tab is the active one.
          icon: <WishlistNavSymbol color={iconColor} filled={activeKey === 'wishlist'} size={NAV_ICON_SIZE} />,
          selectedIcon: <WishlistNavSymbol color={selectedIconColor} filled size={NAV_ICON_SIZE} />,
        },
      ]}
    />
  );
}
