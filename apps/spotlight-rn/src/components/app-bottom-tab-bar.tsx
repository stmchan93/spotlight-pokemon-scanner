import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabBar, useSpotlightTheme } from '@spotlight/design-system';

import { CollectionTabIcon, EventsTabIcon, ScanTabIcon } from './nav-tab-icons';

export type AppBottomTabKey = 'portfolio' | 'scan' | 'events';

type AppBottomTabBarProps = {
  activeKey?: AppBottomTabKey | null;
  onPressPortfolio?: () => void;
  onPressScan?: () => void;
  onPressEvents?: () => void;
};

export function AppBottomTabBar({
  activeKey = null,
  onPressPortfolio,
  onPressScan,
  onPressEvents,
}: AppBottomTabBarProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const iconColor = theme.colors.textPrimary;

  const goToPortfolio = onPressPortfolio
    ?? (() => router.push({ pathname: '/', params: { page: 'portfolio' } } as never));
  const goToScan = onPressScan
    ?? (() => router.push({ pathname: '/', params: { page: 'scanner' } } as never));
  const goToEvents = onPressEvents ?? (() => router.push('/events' as never));

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
          icon: <CollectionTabIcon color={iconColor} filled={activeKey === 'portfolio'} />,
        },
        {
          key: 'scan',
          label: 'Scan',
          selected: activeKey === 'scan',
          onPress: goToScan,
          testID: 'bottom-nav-scan',
          icon: <ScanTabIcon color={iconColor} />,
        },
        {
          key: 'events',
          label: 'Events',
          selected: activeKey === 'events',
          onPress: goToEvents,
          testID: 'bottom-nav-events',
          icon: <EventsTabIcon color={iconColor} filled={activeKey === 'events'} />,
        },
      ]}
    />
  );
}
