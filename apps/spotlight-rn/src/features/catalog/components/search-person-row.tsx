import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';

const AVATAR_SIZE = 40;

function initialsOf(profile: UserProfile): string {
  const source = (profile.displayName || profile.handle || '?').trim();
  const words = source.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

/**
 * A collector in CARDS search results (the mixed COLLECTORS section): avatar,
 * name and @handle on one white row. The full card with holdings lives on the
 * COLLECTORS tab, which VIEW ALL opens.
 */
export function SearchPersonRow({
  onPress,
  profile,
  testID,
}: {
  onPress: (profile: UserProfile) => void;
  profile: UserProfile;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const name = profile.displayName || (profile.handle ? `@${profile.handle}` : 'Collector');
  return (
    <Pressable
      accessibilityLabel={`Open ${name}'s profile`}
      accessibilityRole="button"
      onPress={() => onPress(profile)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.colors.gray0, borderRadius: theme.radii.md, opacity: pressed ? 0.8 : 1 },
      ]}
      testID={testID}
    >
      <Avatar initials={initialsOf(profile)} size={AVATAR_SIZE} uri={profile.avatarURL} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[theme.typography.bodyStrong, { color: theme.colors.gray900 }]}>
          {name}
        </Text>
        {profile.handle && profile.displayName ? (
          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
            {`@${profile.handle}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderCurve: 'continuous',
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
  },
  text: {
    flex: 1,
    gap: 2,
  },
});
