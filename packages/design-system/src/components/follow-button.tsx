import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

/**
 * Follow control for a person you have come across — a feed author, a search
 * result (Figma 5080:6921, a 65x30 button).
 *
 * ONE-WAY BY DESIGN. Following is a control; FOLLOWED is a status. The
 * followed state renders as a plain `View`, not a disabled button: there is no
 * unfollow here, and a pressable that swallows its own press (or greys itself
 * out) reads as broken rather than as settled. Unfollowing lives on the
 * person's profile, where the consequence is visible and deliberate.
 *
 * Figma 5080:6917/6919 (instance 5768:27191): the invitation is a white box
 * with a gray200 hairline and a gray600 label; the confirmation is a borderless
 * gray50 fill with a gray900 label — settled, not shouting.
 */

// Figma 5080:6921: 65x30 with the label inset 10 across. The 1pt border is
// inside that 30, so the vertical padding carries 5 rather than the frame's 6;
// `minHeight` holds the 30 regardless of the label's own line box.
const PADDING_HORIZONTAL = 9;
const PADDING_VERTICAL = 5;
const BOX_HEIGHT = 30;

export type FollowButtonProps = {
  /** Whether the viewer already follows this person. */
  following: boolean;
  /** Fires only from the un-followed state; the followed state is inert. */
  onPress?: () => void;
  /** Whose row this is, for the accessibility label ("Follow Jamie"). */
  personLabel?: string;
  testID?: string;
};

export function FollowButton({ following, onPress, personLabel, testID }: FollowButtonProps) {
  const theme = useSpotlightTheme();
  // Figma 5080:6916/6920 set the label in capitals: FOLLOW / FOLLOWING.
  const label = following ? 'FOLLOWING' : 'FOLLOW';

  const box = [
    styles.box,
    following
      ? // Borderless in Figma; the border takes the fill colour so both states keep one size.
        { backgroundColor: theme.colors.gray50, borderColor: theme.colors.gray50 }
      : { backgroundColor: theme.colors.canvasElevated, borderColor: theme.colors.gray200 },
    { borderRadius: theme.radii.sm },
  ];
  const text = (
    <Text
      numberOfLines={1}
      // Figma 5080:6916: Caption 13 Regular — the one Regular-weight button
      // label in the file.
      style={[
        theme.typography.caption,
        { color: following ? theme.colors.gray900 : theme.colors.gray600 },
      ]}
    >
      {label}
    </Text>
  );

  if (following) {
    return (
      <View
        accessibilityLabel={personLabel ? `Following ${personLabel}` : 'Following'}
        accessible
        style={box}
        testID={testID}
      >
        {text}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={personLabel ? `Follow ${personLabel}` : 'Follow'}
      accessibilityRole="button"
      // The box is 30 tall, well under a comfortable target, and it sits beside
      // the ⋯ menu in a feed row — the slop is what keeps the two apart.
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [...box, { opacity: pressed ? 0.88 : 1 }]}
      testID={testID}
    >
      {text}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: BOX_HEIGHT,
    paddingHorizontal: PADDING_HORIZONTAL,
    paddingVertical: PADDING_VERTICAL,
  },
});
