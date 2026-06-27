import { StyleSheet, Text, View } from 'react-native';
import { Heart } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

type CardWishlistCounterProps = {
  /** Public wishlist count (how many collectors have wishlisted this card). */
  count: number;
  testID?: string;
};

// Wishlist count shown as social proof next to the card name (Figma 1640:4255 —
// heart + count). Capped at "9999+" so a viral card can't blow out the row width.
function wishlistLabel(count: number): string {
  return count > 9999 ? '9999+' : count.toLocaleString();
}

/**
 * Heart + count chip rendered at the top-right of the card-info block. Renders
 * nothing when the card has no wishlist activity so the row stays clean rather
 * than showing a "0".
 */
export function CardWishlistCounter({ count, testID }: CardWishlistCounterProps) {
  const theme = useSpotlightTheme();

  if (count <= 0) {
    return null;
  }

  return (
    <View style={styles.root} testID={testID}>
      <Heart color={theme.colors.gray500} height={16} width={16} />
      <Text
        style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}
        testID={testID ? `${testID}-value` : undefined}
      >
        {wishlistLabel(count)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
});

export default CardWishlistCounter;
