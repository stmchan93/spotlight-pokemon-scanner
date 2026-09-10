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
 * The two states deliberately inverse each other's weight — the invitation is
 * quiet (white, gray label) and the confirmation is loud (black, white label),
 * which is the reverse of the usual convention and is what the product asked
 * for: a followed row should be unmistakable while scrolling past it.
 */

// Figma 5080:6921: 65x30 with the label inset 10 across and its 18pt line box
// centred. The 1pt border is inside that 30, so the vertical padding carries 5
// rather than the frame's 6.
const PADDING_HORIZONTAL = 9;
const PADDING_VERTICAL = 5;
const LABEL_LINE_HEIGHT = 18;

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
  const label = following ? 'Following' : 'Follow';

  const box = [
    styles.box,
    following
      ? { backgroundColor: theme.colors.gray900, borderColor: theme.colors.gray900 }
      : { backgroundColor: theme.colors.canvasElevated, borderColor: theme.colors.gray200 },
    { borderRadius: theme.radii.sm },
  ];
  const text = (
    <Text
      numberOfLines={1}
      style={[
        theme.typography.bodyMedium,
        styles.label,
        { color: following ? theme.colors.gray0 : theme.colors.gray600 },
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
    paddingHorizontal: PADDING_HORIZONTAL,
    paddingVertical: PADDING_VERTICAL,
  },
  label: {
    // Figma sets the label's line box at 18; the token's own 21 would push the
    // control past its 30pt frame.
    lineHeight: LABEL_LINE_HEIGHT,
  },
});
