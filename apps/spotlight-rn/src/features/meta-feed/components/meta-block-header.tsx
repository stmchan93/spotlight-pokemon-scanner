import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@spotlight/design-system';

export type MetaBlockHeaderProps = {
  title: string;
  /** Right-side link, e.g. "See the meta ›". Wins over `caption`. */
  actionLabel?: string;
  onPressAction?: () => void;
  /** Right-side gray caption when there is no link, e.g. "most checked · 24h". */
  caption?: string;
  testID?: string;
};

/**
 * Title row shared by the feed's meta blocks: `titleXsmall` title on the left,
 * a brand-purple link or a gray caption on the right, baseline-aligned. The
 * host supplies the horizontal gutter.
 */
export function MetaBlockHeader({
  title,
  actionLabel,
  onPressAction,
  caption,
  testID,
}: MetaBlockHeaderProps) {
  return (
    <View style={styles.row}>
      <AppText color="gray900" variant="titleXsmall">
        {title}
      </AppText>
      {actionLabel ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={onPressAction}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          testID={testID ? `${testID}-action` : undefined}
        >
          <AppText color="brandStrong" variant="captionStrong">
            {actionLabel}
          </AppText>
        </Pressable>
      ) : caption ? (
        <AppText color="gray600" testID={testID ? `${testID}-caption` : undefined} variant="captionMedium">
          {caption}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
