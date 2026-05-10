import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateCard, useSpotlightTheme } from '@spotlight/design-system';

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <View
        style={[
          styles.content,
          {
            paddingBottom: bottomNavClearance,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <Text
          style={[theme.typography.display, { color: theme.colors.textPrimary }]}
          testID="events-header-title"
        >
          Events
        </Text>

        <StateCard
          message="Live drops, set releases, and tournaments will surface here once the schedule is wired up."
          style={styles.placeholder}
          title="Events are coming soon"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    gap: 16,
  },
  placeholder: {
    marginTop: 8,
  },
  safeArea: {
    flex: 1,
  },
});
