import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

/**
 * Follow control for a person you have come across — a feed author, a search
 * result (Figma 6203:9449, a 28pt-tall button).
 *
 * ONE-WAY UNLESS ASKED. Following is a control; FOLLOWED is a status. Without
 * `onUnfollow` the followed state renders as a plain `View`, not a disabled
 * button — a pressable that swallows its own press reads as broken rather than
 * as settled. The Social feed (Figma 6642:5448) passes `onUnfollow`, and the
 * FOLLOWING box becomes the way out; the caller owns any confirmation.
 *
 * Figma 5080:6917/6919 (instance 5768:27191): the invitation is a white box
 * with a gray200 hairline and a gray600 label; the confirmation is a borderless
 * gray50 fill with a gray900 label — settled, not shouting.
 */

// Figma 6203:9449/9451: 28 tall, 10/6 padding, radius 6. The 1pt border is
// inside the box, so the padding carries 9/5.
const PADDING_HORIZONTAL = 9;
const PADDING_VERTICAL = 5;
const BOX_HEIGHT = 28;
const BOX_RADIUS = 6;

export type FollowButtonProps = {
  /** Whether the viewer already follows this person. */
  following: boolean;
  /** Fires only from the un-followed state. */
  onPress?: () => void;
  /** Makes the FOLLOWING state pressable. Omitted, that state is inert. */
  onUnfollow?: () => void;
  /** Whose row this is, for the accessibility label ("Follow Jamie"). */
  personLabel?: string;
  /** `onDark` draws the settled state for a black backdrop (Figma 6322:8416). */
  tone?: 'default' | 'onDark';
  testID?: string;
};

export function FollowButton({
  following,
  onPress,
  onUnfollow,
  personLabel,
  tone = 'default',
  testID,
}: FollowButtonProps) {
  const theme = useSpotlightTheme();
  // Figma 5080:6916/6920 set the label in capitals: FOLLOW / FOLLOWING.
  const label = following ? 'FOLLOWING' : 'FOLLOW';
  const settledFill = tone === 'onDark' ? theme.colors.gray700 : theme.colors.gray50;
  const settledLabel = tone === 'onDark' ? theme.colors.gray0 : theme.colors.gray900;

  const box = [
    styles.box,
    following
      ? // Borderless in Figma; the border takes the fill colour so both states keep one size.
        { backgroundColor: settledFill, borderColor: settledFill }
      : { backgroundColor: theme.colors.canvasElevated, borderColor: theme.colors.gray200 },
  ];
  const text = (
    <Text
      numberOfLines={1}
      // Figma 5080:6916: Caption 13 Regular — the one Regular-weight button
      // label in the file.
      style={[
        theme.typography.caption,
        { color: following ? settledLabel : theme.colors.gray600 },
      ]}
    >
      {label}
    </Text>
  );

  if (following && !onUnfollow) {
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

  const actionLabel = following ? 'Unfollow' : 'Follow';
  return (
    <Pressable
      accessibilityLabel={personLabel ? `${actionLabel} ${personLabel}` : actionLabel}
      accessibilityRole="button"
      accessibilityState={following ? { selected: true } : undefined}
      // The box is 30 tall, well under a comfortable target, and it sits beside
      // the ⋯ menu in a feed row — the slop is what keeps the two apart.
      hitSlop={8}
      onPress={following ? onUnfollow : onPress}
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
    borderRadius: BOX_RADIUS,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: BOX_HEIGHT,
    paddingHorizontal: PADDING_HORIZONTAL,
    paddingVertical: PADDING_VERTICAL,
  },
});
