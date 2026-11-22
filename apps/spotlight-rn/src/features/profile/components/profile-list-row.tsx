import { Pressable, StyleSheet, View } from 'react-native';
import { CheckCircle } from 'iconoir-react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import {
  getProfileDisplayName,
  getProfileInitials,
} from '@/features/profile/screens/public-profile-screen';

/** One person in a people list (Followers, Following, Liked by): avatar, name, @handle. */
export function ProfileListRow({
  profile,
  onPress,
  testID,
}: {
  profile: UserProfile;
  onPress: (profile: UserProfile) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const displayName = getProfileDisplayName(profile);
  const handle = profile.handle?.trim();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(profile)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.colors.gray0, paddingHorizontal: theme.layout.pageGutter },
        pressed ? styles.rowPressed : null,
      ]}
      testID={testID}
    >
      <Avatar
        initials={getProfileInitials(profile.displayName)}
        size={40}
        testID={`${testID}-avatar`}
        uri={profile.avatarURL}
      />
      <View style={styles.rowCopy}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={[theme.typography.bodyMedium, styles.nameText]}>
            {displayName}
          </Text>
          {profile.isVerified ? (
            <CheckCircle color={theme.colors.purple500} height={16} testID={`${testID}-verified`} width={16} />
          ) : null}
        </View>
        {handle ? (
          <Text numberOfLines={1} style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
            {`@${handle}`.toUpperCase()}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  nameText: {
    flexShrink: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 10,
  },
  rowCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  rowPressed: {
    opacity: 0.6,
  },
});
