import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, useSpotlightTheme } from '@spotlight/design-system';

import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const handleTabBarScroll = useTabBarScrollHandler();

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: bottomNavClearance,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
        onScroll={handleTabBarScroll}
        scrollEventThrottle={16}
      >
        <Text
          style={[theme.typography.display, { color: theme.colors.textPrimary }]}
          testID="events-header-title"
        >
          Events
        </Text>

        <Text
          style={[theme.typography.bodyMedium, styles.placeholder, { color: theme.colors.gray600 }]}
          testID="events-placeholder"
        >
          Information about live events are coming soon!
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 16,
  },
  placeholder: {
    marginTop: 8,
    textAlign: 'center',
  },
  safeArea: {
    flex: 1,
  },
});
