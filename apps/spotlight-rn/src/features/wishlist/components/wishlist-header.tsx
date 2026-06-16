import { Menu as MenuIcon, Upload as ShareIcon } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, IconButton, useSpotlightTheme } from '@spotlight/design-system';

type WishlistHeaderProps = {
  onOpenMenu: () => void;
  onShare?: () => void;
  testID?: string;
};

// Lean top bar for the Wishlist screen (Figma 813:15695 "after"): menu, centred
// "Wishlist" title, share. The big featured hero card that used to sit below it
// was removed — the screen now goes straight from this header into the
// search/filter chrome and the card grid/list.
export function WishlistHeader({
  onOpenMenu,
  onShare,
  testID = 'wishlist-header',
}: WishlistHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]} testID={testID}>
      <IconButton
        accessibilityLabel="Open menu"
        onPress={onOpenMenu}
        size={36}
        testID="wishlist-header-menu"
        variant="elevated"
      >
        <MenuIcon color={theme.colors.gray900} height={20} width={20} />
      </IconButton>
      <AppText
        color="textPrimary"
        numberOfLines={1}
        style={styles.headerTitle}
        testID="wishlist-header-title"
        variant="titleMedium"
      >
        Wishlist
      </AppText>
      <IconButton
        accessibilityLabel="Share wishlist"
        onPress={onShare}
        size={36}
        testID="wishlist-header-share"
        variant="elevated"
      >
        <ShareIcon color={theme.colors.gray900} height={18} width={18} />
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
});
