import { Stack, usePathname, useRouter } from 'expo-router';
import {
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingBottomNav,
  useSpotlightTheme,
} from '@spotlight/design-system';

function isPortfolioPath(pathname: string) {
  return pathname === '/portfolio' || pathname.startsWith('/portfolio/');
}

function isScanPath(pathname: string) {
  return pathname === '/' || pathname === '/index' || pathname === '/scan' || pathname.startsWith('/scan/');
}

function TabsChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useSpotlightTheme();
  const portfolioSelected = isPortfolioPath(pathname);
  const scanSelected = isScanPath(pathname);

  if (scanSelected) {
    return null;
  }

  return (
    <FloatingBottomNav
      bottomInset={Math.max(insets.bottom - 8, 0)}
      items={[
        {
          key: 'portfolio',
          label: 'Portfolio',
          selected: portfolioSelected,
          onPress: () => router.replace('/portfolio'),
          testID: 'bottom-nav-portfolio',
          icon: (
            <PortfolioNavIcon
              color={portfolioSelected ? theme.colors.textPrimary : theme.colors.textSecondary}
            />
          ),
        },
        {
          key: 'scan',
          label: 'Scan',
          emphasized: true,
          selected: scanSelected,
          onPress: () => router.replace('/'),
          testID: 'bottom-nav-scan',
          icon: (
            <ScanNavIcon
              color={scanSelected ? theme.colors.textPrimary : theme.colors.textSecondary}
            />
          ),
        },
      ]}
      surface="default"
    />
  );
}

function PortfolioNavIcon({ color }: { color: string }) {
  return (
    <View style={styles.portfolioIconFrame}>
      <View style={[styles.portfolioIconBack, { borderColor: color }]} />
      <View style={[styles.portfolioIconFront, { borderColor: color }]} />
    </View>
  );
}

function ScanNavIcon({ color }: { color: string }) {
  return (
    <View style={styles.scanIconFrame}>
      <View style={[styles.scanIconCorner, styles.scanIconTopLeft, { borderColor: color }]} />
      <View style={[styles.scanIconCorner, styles.scanIconTopRight, { borderColor: color }]} />
      <View style={[styles.scanIconCorner, styles.scanIconBottomLeft, { borderColor: color }]} />
      <View style={[styles.scanIconCorner, styles.scanIconBottomRight, { borderColor: color }]} />
      <View style={[styles.scanIconDot, { backgroundColor: color }]} />
    </View>
  );
}

export default function TabsLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          animation: 'default',
          contentStyle: {
            backgroundColor: 'transparent',
          },
          headerShown: false,
        }}
      />
      <TabsChrome />
    </View>
  );
}

const styles = StyleSheet.create({
  portfolioIconBack: {
    borderRadius: 3,
    borderWidth: 1.7,
    height: 12,
    left: 2,
    position: 'absolute',
    top: 1,
    width: 12,
  },
  portfolioIconFrame: {
    height: 16,
    position: 'relative',
    width: 16,
  },
  portfolioIconFront: {
    backgroundColor: 'transparent',
    borderRadius: 3,
    borderWidth: 1.7,
    height: 12,
    position: 'absolute',
    right: 0,
    top: 3,
    width: 12,
  },
  scanIconBottomLeft: {
    borderBottomWidth: 1.8,
    borderLeftWidth: 1.8,
    bottom: 0,
    left: 0,
  },
  scanIconBottomRight: {
    borderBottomWidth: 1.8,
    borderRightWidth: 1.8,
    bottom: 0,
    right: 0,
  },
  scanIconCorner: {
    height: 6,
    position: 'absolute',
    width: 6,
  },
  scanIconDot: {
    borderRadius: 999,
    height: 4,
    left: 7,
    position: 'absolute',
    top: 7,
    width: 4,
  },
  scanIconFrame: {
    height: 18,
    position: 'relative',
    width: 18,
  },
  scanIconTopLeft: {
    borderLeftWidth: 1.8,
    borderTopWidth: 1.8,
    left: 0,
    top: 0,
  },
  scanIconTopRight: {
    borderRightWidth: 1.8,
    borderTopWidth: 1.8,
    right: 0,
    top: 0,
  },
});
