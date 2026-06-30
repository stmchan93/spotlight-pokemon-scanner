import { EditPencil, NavArrowLeft, Upload as ShareIcon } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, IconButton, useSpotlightTheme } from '@spotlight/design-system';

import { EditDoneButton } from '@/components/edit-done-button';

type WishlistHeaderProps = {
  onBack: () => void;
  onShare?: () => void;
  /** When true the bar shows a "Done" action instead of the edit pencil. */
  editMode?: boolean;
  /** Enables the edit-mode toggle in the right slot. */
  onToggleEditMode?: () => void;
  testID?: string;
};

// Lean top bar for the Wishlist screen: a circular back button (Figma 1263:3328
// — gray/50 chip), centred "Wishlist" title, and an edit/share slot. Wishlist is
// reached by pushing in from the drawer, so it carries a back button rather than
// the hamburger (that lives on the root Collection screen).
export function WishlistHeader({
  onBack,
  onShare,
  editMode = false,
  onToggleEditMode,
  testID = 'wishlist-header',
}: WishlistHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]} testID={testID}>
      <IconButton
        accessibilityLabel="Back"
        onPress={onBack}
        size={36}
        testID="wishlist-header-back"
        variant="subtle"
      >
        <NavArrowLeft color={theme.colors.gray900} height={24} width={24} />
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
      {onToggleEditMode && editMode ? (
        <EditDoneButton onPress={onToggleEditMode} testID="wishlist-header-done" />
      ) : (
        <>
          {onToggleEditMode ? (
            <IconButton
              accessibilityLabel="Edit wishlist"
              onPress={onToggleEditMode}
              size={36}
              testID="wishlist-header-edit"
              variant="subtle"
            >
              <EditPencil color={theme.colors.gray900} height={20} width={20} />
            </IconButton>
          ) : null}
          <IconButton
            accessibilityLabel="Share wishlist"
            onPress={onShare}
            size={36}
            testID="wishlist-header-share"
            variant="subtle"
          >
            <ShareIcon color={theme.colors.gray900} height={18} width={18} />
          </IconButton>
        </>
      )}
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
