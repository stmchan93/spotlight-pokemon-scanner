import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

type FeedComposerRowProps = {
  /** Opens the composer. */
  onPress: () => void;
  /** Viewer's avatar; falls back to their initials when they have no photo. */
  avatarUrl?: string | null;
  initials: string;
  testID?: string;
};

/** Viewer avatar in the composer entry row. */
const AVATAR_SIZE = 40;

/**
 * The "What's on your mind?" entry row at the top of the feed. Not a real input —
 * tapping anywhere on it pushes the New Post composer. It stands in for the feed's
 * empty state too: with no posts to read there is still an obvious way to write one.
 */
export function FeedComposerRow({
  onPress,
  avatarUrl,
  initials,
  testID = 'feed-composer-row',
}: FeedComposerRowProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityHint="Opens the post composer"
      accessibilityLabel="What's on your mind?"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.colors.outlineSubtle },
        pressed ? { backgroundColor: theme.colors.gray50 } : null,
      ]}
      testID={testID}
    >
      <Avatar initials={initials} size={AVATAR_SIZE} testID={`${testID}-avatar`} uri={avatarUrl} />
      <View style={styles.placeholder}>
        <Text numberOfLines={1} style={[theme.typography.body, { color: theme.colors.gray400 }]}>
          What’s on your mind?
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    justifyContent: 'center',
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});

export default FeedComposerRow;
