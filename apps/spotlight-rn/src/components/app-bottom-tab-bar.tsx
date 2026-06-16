import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabBar, useSpotlightTheme } from '@spotlight/design-system';

import { CollectionTabIcon, EventsTabIcon, ScanTabIcon } from './nav-tab-icons';

export type AppBottomTabKey = 'portfolio' | 'scan' | 'events';

type AppBottomTabBarProps = {
  activeKey?: AppBottomTabKey | null;
  // Pushed (stack) screens (wishlist/transactions/insights) set this so a tab tap
  // collapses the pushed stack back to the target tab instead of pushing a
  // duplicate `(tabs)` route on top (which made Back return to the page you left).
  dismissToTabs?: boolean;
  onPressPortfolio?: () => void;
  onPressScan?: () => void;
  onPressEvents?: () => void;
};

export function AppBottomTabBar({
  activeKey = null,
  dismissToTabs = false,
  onPressPortfolio,
  onPressScan,
  onPressEvents,
}: AppBottomTabBarProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const iconColor = theme.colors.textPrimary;
  // Figma nav glyph size (node 1313:7454 — `size-[22px]`).
  const NAV_ICON_SIZE = 22;

  const goToPortfolio = onPressPortfolio
    ?? (dismissToTabs
      ? (() => router.dismissTo({ pathname: '/', params: { page: 'portfolio' } } as never))
      : (() => router.push({ pathname: '/', params: { page: 'portfolio' } } as never)));
  const goToScan = onPressScan
    ?? (dismissToTabs
      ? (() => router.dismissTo({ pathname: '/', params: { page: 'scanner' } } as never))
      : (() => router.push({ pathname: '/', params: { page: 'scanner' } } as never)));
  const goToEvents = onPressEvents
    ?? (dismissToTabs
      ? (() => router.replace('/events' as never))
      : (() => router.push('/events' as never)));

  return (
    <BottomTabBar
      bottomInset={Math.max(insets.bottom, 0)}
      items={[
        {
          key: 'portfolio',
          label: 'Collection',
          selected: activeKey === 'portfolio',
          onPress: goToPortfolio,
          testID: 'bottom-nav-portfolio',
          icon: <CollectionTabIcon color={iconColor} filled={activeKey === 'portfolio'} size={NAV_ICON_SIZE} />,
        },
        {
          key: 'scan',
          label: 'Scan',
          selected: activeKey === 'scan',
          onPress: goToScan,
          testID: 'bottom-nav-scan',
          icon: <ScanTabIcon color={iconColor} size={NAV_ICON_SIZE} />,
        },
        {
          key: 'events',
          label: 'Events',
          selected: activeKey === 'events',
          onPress: goToEvents,
          testID: 'bottom-nav-events',
          icon: <EventsTabIcon color={iconColor} filled={activeKey === 'events'} size={NAV_ICON_SIZE} />,
        },
      ]}
    />
  );
}
