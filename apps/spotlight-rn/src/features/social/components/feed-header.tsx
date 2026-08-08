import { StyleSheet, View } from 'react-native';
import { Bell, Menu, Plus } from 'iconoir-react-native';

import { IconButton, SearchEntryPill, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

type FeedHeaderProps = {
  /** Hamburger — opens the app drawer. */
  onOpenMenu: () => void;
  /** The search pill — opens the card catalog search. */
  onOpenSearch: () => void;
  onOpenNotifications: () => void;
  /** The + button. This is the feed's composer entry point (Figma 3505:14539). */
  onOpenComposer: () => void;
  testID?: string;
};

/** Figma 3505:14521 — every control in the bar is a 36pt circle. */
const BUTTON_SIZE = 36;
const BUTTON_ICON_SIZE = 20;
/** The app-mark badge inside the search pill (Figma 3505:14529). */
const MARK_BADGE_SIZE = 28;
// Figma draws the mark at 20.73 × 19.20 inside the badge. Rounded to 21 wide and
// scaled on the mark's own 56:52 intrinsic ratio so it is not stretched.
const MARK_WIDTH = 21;
const MARK_HEIGHT = 19.5;

/**
 * The feed's top bar (Figma 3505:14521): menu, a tap-to-search pill carrying the
 * Ekalight mark, notifications, and the new-post `+`.
 *
 * The `+` IS the composer entry point in this design — the same Plus-opens-the-
 * composer affordance the Portfolio Activity tab already uses — which is why the
 * feed no longer carries a separate "What's on your mind?" row.
 */
export function FeedHeader({
  onOpenMenu,
  onOpenSearch,
  onOpenNotifications,
  onOpenComposer,
  testID = 'feed-header',
}: FeedHeaderProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.header} testID={testID}>
      <IconButton
        accessibilityLabel="Open menu"
        onPress={onOpenMenu}
        size={BUTTON_SIZE}
        testID={`${testID}-menu`}
        variant="subtle"
      >
        <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </IconButton>
      <SearchEntryPill
        label="Search Cards"
        leading={
          <View
            style={[
              styles.markBadge,
              {
                backgroundColor: theme.colors.purple500,
                borderRadius: MARK_BADGE_SIZE / 2,
              },
            ]}
          >
            <EkalightMark
              color={theme.colors.gray0}
              height={MARK_HEIGHT}
              testID={`${testID}-mark`}
              width={MARK_WIDTH}
            />
          </View>
        }
        onPress={onOpenSearch}
        style={styles.searchPill}
        testID={`${testID}-search`}
      />
      <IconButton
        accessibilityLabel="Notifications"
        onPress={onOpenNotifications}
        size={BUTTON_SIZE}
        testID={`${testID}-notifications`}
        variant="subtle"
      >
        <Bell color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </IconButton>
      <IconButton
        accessibilityLabel="New post"
        onPress={onOpenComposer}
        size={BUTTON_SIZE}
        testID={`${testID}-compose`}
        variant="subtle"
      >
        <Plus color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    // 10 above / 16 below lands the hairline under the bar exactly where Figma
    // puts it (header top 58 → rule at 120 on a 59pt status bar).
    paddingBottom: 16,
    paddingTop: 10,
  },
  markBadge: {
    alignItems: 'center',
    height: MARK_BADGE_SIZE,
    justifyContent: 'center',
    width: MARK_BADGE_SIZE,
  },
  searchPill: {
    flex: 1,
  },
});

export default FeedHeader;
