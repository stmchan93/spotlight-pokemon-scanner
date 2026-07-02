import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { NavArrowLeft } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { AppText, IconButton, colors, useSpotlightTheme } from '@spotlight/design-system';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';

export function EventsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
      {/* Lean top bar mirroring the Wishlist header: circular back chip +
          centred title. Events is pushed over the tabs, so it carries a back
          button; the right-side spacer keeps the title optically centred. */}
      <View style={[styles.header, { paddingTop: 8 }]} testID="events-header">
        <IconButton
          accessibilityLabel="Back"
          onPress={() => router.back()}
          size={36}
          testID="events-header-back"
          variant="subtle"
        >
          <NavArrowLeft color={theme.colors.gray900} height={24} width={24} />
        </IconButton>
        <AppText
          color="textPrimary"
          numberOfLines={1}
          style={styles.headerTitle}
          testID="events-header-title"
          variant="titleMedium"
        >
          Events
        </AppText>
        <View style={styles.headerSpacer} />
      </View>

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
          style={[theme.typography.bodyMedium, styles.placeholder, { color: theme.colors.gray600 }]}
          testID="events-placeholder"
        >
          Information about live events are coming soon!
        </Text>
      </ScrollView>

      <AppBottomTabBar activeKey="events" dismissToTabs />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 16,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  headerSpacer: {
    width: 36,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
  placeholder: {
    textAlign: 'center',
  },
  safeArea: {
    flex: 1,
  },
});
