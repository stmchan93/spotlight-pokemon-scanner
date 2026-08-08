import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Bookmark,
  ChatBubbleEmpty,
  GraphUp,
  LogOut,
  MagicWand,
  Menu as MenuIcon,
  Scanning,
  Settings,
  ViewGrid,
} from 'iconoir-react-native';
import { useEffect, useRef } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { colors, fontFamilies, Text, textStyles } from '@spotlight/design-system';

import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { useAppServices } from '@/providers/app-providers';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

const DRAWER_WIDTH = 329;
const ANIM_DURATION_MS = 240;

type NavItem = {
  key: string;
  label: string;
  icon: typeof ViewGrid;
  selected?: boolean;
  onPress: () => void;
};

function formatMemberSince(isoString: string | null | undefined): string | null {
  if (!isoString) {
    return null;
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `Member since ${date.toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
  })}`;
}

export function AppDrawer() {
  const { isOpen, closeDrawer } = useAppDrawer();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const auth = useAuth();
  const { gate } = useGuestGate();
  const { width: screenWidth } = useWindowDimensions();
  const { inventoryEntriesCache, portfolioDashboardCache } = useAppServices();

  const translateX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const scrimOpacity = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      mountedRef.current = true;
    }
    Animated.parallel([
      Animated.timing(translateX, {
        toValue: isOpen ? 0 : -DRAWER_WIDTH,
        duration: ANIM_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrimOpacity, {
        toValue: isOpen ? 1 : 0,
        duration: ANIM_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [isOpen, scrimOpacity, translateX]);

  // Don't mount any DOM until first opened (avoids covering hit-tests on first load).
  if (!isOpen && !mountedRef.current) {
    return null;
  }

  const user = auth.currentUser;
  const displayName = user?.displayName ?? 'You';
  const initials =
    typeof (user as unknown as { getUserInitials?: () => string })?.getUserInitials === 'function'
      ? (user as unknown as { getUserInitials: () => string }).getUserInitials()
      : displayName
          .split(/\s+/)
          .map((part) => part.charAt(0).toUpperCase())
          .filter(Boolean)
          .slice(0, 2)
          .join('');

  const memberSince = formatMemberSince(auth.currentSession?.user.created_at ?? null);

  // Read directly from the shared caches in AppServices. The PortfolioScreen
  // populates these via `usePortfolioScreenModel`; the drawer just reflects
  // whatever's there. Falls back to deriving from the inventory cache when
  // the dashboard hasn't loaded yet so users see real numbers immediately on
  // first open.
  const portfolioValueRaw = portfolioDashboardCache?.summary.currentValue
    ?? (inventoryEntriesCache?.reduce(
      (sum, entry) => sum + (entry.hasMarketPrice ? entry.marketPrice * entry.quantity : 0),
      0,
    ));
  const portfolioValue = portfolioValueRaw != null ? formatCurrency(portfolioValueRaw) : '—';

  const inventoryCountRaw = portfolioDashboardCache?.inventoryCount
    ?? inventoryEntriesCache?.length;
  const totalItems = inventoryCountRaw != null
    ? new Intl.NumberFormat('en-US').format(inventoryCountRaw)
    : '—';

  // Derive the active nav key from the current route so the yellow indicator
  // dot updates when the user navigates between drawer destinations.
  const normalizedPathname = pathname ?? '';
  let activeKey: 'collection' | 'home' | 'insights' | 'wishlist' | 'scan' | null;
  // `/` is the FEED now, not the collection — Home took the tabs root and
  // Collection moved to `/you`. Matching `/` as 'collection' would light the
  // Portfolio dot while the user is looking at the feed, and would make the
  // Portfolio item a no-op from Home (see the early return in
  // `navigateToCollection`). 'home' has no drawer item of its own; it exists so
  // the tab root is not mistaken for a pushed screen below.
  if (normalizedPathname === '/you' || normalizedPathname.startsWith('/portfolio')) {
    activeKey = 'collection';
  } else if (normalizedPathname === '/') {
    activeKey = 'home';
  } else if (normalizedPathname.startsWith('/insights')) {
    activeKey = 'insights';
  } else if (normalizedPathname.startsWith('/wishlist')) {
    activeKey = 'wishlist';
  } else if (normalizedPathname.startsWith('/scan')) {
    activeKey = 'scan';
  } else {
    activeKey = null;
  }

  // True when we're currently sitting on a stack route (sales/insights/
  // wishlist/scan) — i.e. there is at least one entry above the tabs root
  // in the back stack. Home is a tab root like Collection, so it is excluded
  // for the same reason: there is nothing above it to replace.
  const isOnStackRoute = activeKey != null
    && activeKey !== 'collection'
    && activeKey !== 'home';

  const goTo = (path: string) => {
    closeDrawer();
    // small delay so the drawer slide-out is visible
    setTimeout(() => {
      if (isOnStackRoute) {
        // Hopping between stack routes via the drawer (e.g. Insights → Sales
        // → Insights). REPLACE the current entry instead of stacking new
        // ones, otherwise the back-stack grows unbounded and swipe-back
        // unwinds through every visited screen.
        router.replace(path as never);
      } else {
        // From the Collection tab root, push so swipe-back returns to it.
        router.push(path as never);
      }
    }, ANIM_DURATION_MS / 2);
  };

  const navigateToCollection = () => {
    closeDrawer();
    if (activeKey === 'collection') {
      return;
    }
    // From a stack route back to Collection, which is the `/you` TAB now.
    // `/portfolio` is a Redirect to it, so `router.replace('/portfolio')` would
    // leave the back-stack with BOTH the tabs entry AND the redirected one —
    // both render Collection visually, producing the "Collections then
    // Collections again" swipe-back bug. Pop the stack down to the tabs and
    // select the tab instead, so there is a single Collection entry.
    //
    // The `page: 'portfolio'` param that used to ride along was the retired
    // pager's addressing (it chose which of two mounted pages to show) and is
    // read by nothing now that each page is a real route.
    setTimeout(() => {
      router.dismissTo('/you' as never);
    }, ANIM_DURATION_MS / 2);
  };

  const collectionItems: NavItem[] = [
    {
      key: 'collection',
      label: 'Portfolio',
      icon: ViewGrid,
      selected: activeKey === 'collection',
      onPress: gate(navigateToCollection),
    },
    {
      key: 'wishlist',
      label: 'Wishlist',
      icon: Bookmark,
      selected: activeKey === 'wishlist',
      onPress: gate(() => goTo('/wishlist')),
    },
    {
      key: 'insights',
      label: 'Insights',
      icon: GraphUp,
      selected: activeKey === 'insights',
      onPress: gate(() => goTo('/insights')),
    },
  ];

  const actionItems: NavItem[] = [
    {
      key: 'scan',
      label: 'Scan',
      icon: Scanning,
      selected: activeKey === 'scan',
      onPress: () => {
        closeDrawer();
        // Scanner lives on the tabs root; navigate via the tabs index path
        setTimeout(() => router.push('/scan' as never), ANIM_DURATION_MS / 2);
      },
    },
    {
      // The ONLY entry point to the DM inbox — `/messages` is reachable from
      // nowhere else in the app. Gated like the other signed-in destinations:
      // every DM read is scoped to `auth.uid()` by RLS, so a guest would land on
      // a permanently empty inbox.
      key: 'messages',
      label: 'Messages',
      // Same glyph the feed and comments sheet already use for conversation.
      icon: ChatBubbleEmpty,
      onPress: gate(() => goTo('/messages')),
    },
    {
      key: 'whos-that-pokemon',
      label: "Who's That Pokémon?",
      icon: MagicWand,
      onPress: gate(() => goTo('/whos-that-pokemon')),
    },
  ];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={isOpen ? 'auto' : 'none'} testID="app-drawer">
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.scrim,
          { opacity: scrimOpacity },
        ]}
        pointerEvents={isOpen ? 'auto' : 'none'}
      >
        <Pressable
          accessibilityLabel="Close drawer"
          accessibilityRole="button"
          onPress={closeDrawer}
          style={StyleSheet.absoluteFill}
          testID="app-drawer-scrim"
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          {
            width: Math.min(DRAWER_WIDTH, screenWidth * 0.85),
            transform: [{ translateX }],
          },
        ]}
        testID="app-drawer-panel"
      >
        <View
          style={[
            styles.contentInner,
            // ANDROID ONLY: lift the logout row above the system nav bar. iOS was
            // already correct with the fixed 32 (adding its home-indicator inset
            // would just over-pad a fine screen), so leave iOS untouched.
            Platform.OS === 'android'
              ? { paddingBottom: 32 + insets.bottom }
              : null,
          ]}
        >
          <Pressable
            accessibilityLabel="Account settings"
            accessibilityRole="button"
            onPress={gate(() => {
              closeDrawer();
              setTimeout(() => router.push('/account' as never), ANIM_DURATION_MS / 2);
            })}
            style={styles.profileRow}
            testID="app-drawer-profile"
          >
            {user?.avatarURL ? (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: user.avatarURL }}
                style={styles.avatar}
              />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarInitials}>{initials || '·'}</Text>
              </View>
            )}
            <View style={styles.profileCopy}>
              <Text numberOfLines={1} style={styles.profileName}>
                {displayName}
              </Text>
              {memberSince ? (
                <Text numberOfLines={1} style={styles.profileMeta}>
                  {memberSince}
                </Text>
              ) : null}
            </View>
          </Pressable>

          <View style={styles.statsRow}>
            <View style={styles.statTile}>
              <Text style={styles.statLabel}>Portfolio Value</Text>
              <Text style={styles.statValue}>{portfolioValue}</Text>
            </View>
            <View style={styles.statTile}>
              <Text style={styles.statLabel}>Total Items</Text>
              <Text style={styles.statValue}>{totalItems}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.navSection}>
            {collectionItems.map((item) => (
              <DrawerNavItem
                key={item.key}
                icon={item.icon}
                label={item.label}
                selected={item.selected}
                onPress={item.onPress}
                testID={`app-drawer-nav-${item.key}`}
              />
            ))}
          </View>

          <View style={styles.divider} />

          <View style={styles.navSection}>
            {actionItems.map((item) => (
              <DrawerNavItem
                key={item.key}
                icon={item.icon}
                label={item.label}
                onPress={item.onPress}
                testID={`app-drawer-nav-${item.key}`}
              />
            ))}
          </View>

          <View style={styles.spacer} />

          <View style={styles.navSection}>
            <DrawerNavItem
              icon={Settings}
              label="Account Settings"
              onPress={gate(() => {
                closeDrawer();
                // Same destination as tapping the profile row up top — the
                // Account page carries sign-out + delete-account.
                setTimeout(() => router.push('/account' as never), ANIM_DURATION_MS / 2);
              })}
              testID="app-drawer-nav-account-settings"
            />
            <DrawerNavItem
              icon={LogOut}
              label="Log Out"
              onPress={gate(() => {
                Alert.alert(
                  'Log out?',
                  "You'll need to sign in again to view your portfolio.",
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Log Out',
                      style: 'destructive',
                      onPress: async () => {
                        closeDrawer();
                        try {
                          await auth.signOut();
                        } catch (error) {
                          console.warn('[AppDrawer] signOut failed', error);
                        }
                      },
                    },
                  ],
                );
              })}
              testID="app-drawer-nav-logout"
            />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

type DrawerNavItemProps = {
  icon: typeof MenuIcon;
  label: string;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
};

function DrawerNavItem({ icon: Icon, label, selected, onPress, testID }: DrawerNavItemProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.navItem, pressed ? styles.navItemPressed : null]}
      testID={testID}
    >
      <Icon color={colors.gray900} height={20} width={20} />
      <Text style={styles.navLabel}>{label}</Text>
      {selected ? <View style={styles.activeDot} testID={testID ? `${testID}-active-dot` : undefined} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  panel: {
    backgroundColor: colors.gray0,
    bottom: 0,
    left: 0,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 24,
    top: 0,
  },
  contentInner: {
    flex: 1,
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 75,
  },
  profileRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
  avatar: {
    borderRadius: 21,
    height: 42,
    width: 42,
  },
  avatarFallback: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    justifyContent: 'center',
  },
  avatarInitials: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
    fontSize: 16,
  },
  profileCopy: {
    flex: 1,
    gap: 2,
  },
  profileName: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  profileMeta: {
    color: colors.gray500,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 16.8,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 20,
  },
  statTile: {
    backgroundColor: colors.gray50,
    borderRadius: 12,
    flex: 1,
    gap: 4,
    padding: 16,
  },
  statLabel: {
    ...textStyles.overline,
    color: colors.gray600,
  },
  statValue: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  divider: {
    backgroundColor: colors.gray200,
    height: 1,
    marginVertical: 16,
  },
  navSection: {
    gap: 20,
  },
  navItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  navItemPressed: {
    opacity: 0.7,
  },
  navLabel: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
  },
  activeDot: {
    backgroundColor: colors.brand,
    borderRadius: 999,
    height: 6,
    marginLeft: 4,
    width: 6,
  },
  spacer: {
    flex: 1,
  },
});
