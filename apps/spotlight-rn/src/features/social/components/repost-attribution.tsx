import { StyleSheet, View } from 'react-native';
import { Repeat } from 'iconoir-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

/** Matches the metrics-row glyph, so the same act reads the same size twice. */
const ICON_SIZE = 14;

/**
 * "⟲ Reposted" — the line above a post on a profile's Activity tab that says
 * this collector passed it on rather than wrote it.
 *
 * WITHOUT THIS THE LIST LIES. Activity merges what someone wrote with what they
 * reposted, and a repost card is otherwise indistinguishable from an authored
 * one — it carries the ORIGINAL author's name and avatar, so on your own profile
 * an unattributed repost looks like you posted someone else's photo.
 *
 * Shared rather than written twice: the public profile and the owner's own
 * Portfolio → Activity render the same list, and one act must not read two ways
 * depending on which door you came in.
 */
export function RepostAttribution({
  /** Null on your own profile — "You reposted" rather than a name. */
  name,
  testID = 'repost-attribution',
}: {
  name?: string | null;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.row} testID={testID}>
      <Repeat color={theme.colors.gray600} height={ICON_SIZE} width={ICON_SIZE} />
      <Text numberOfLines={1} style={[theme.typography.label, { color: theme.colors.gray600 }]}>
        {name ? `${name} reposted` : 'You reposted'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    // Aligns with the card's own 16pt gutter; the top padding is the card's
    // `paddingTop: 16` moved up here so the attribution sits ON the card rather
    // than floating in the gap between two of them.
    paddingHorizontal: 16,
    paddingTop: 16,
  },
});

export default RepostAttribution;
