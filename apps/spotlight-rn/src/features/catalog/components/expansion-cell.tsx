import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import type { ExpansionRecord } from '@spotlight/api-client';
import { Text, useSpotlightTheme } from '@spotlight/design-system';

type ExpansionCellProps = {
  expansion: ExpansionRecord;
  onPress: () => void;
  testID?: string;
};

/**
 * One set in the expansions grid: the set logo (with a name fallback when the
 * image is missing/fails), the set name, and its release date. Shared by the
 * Add Card browse grid and the standalone "Browse Sets" screen so both render
 * sets identically.
 */
export function ExpansionCell({ expansion, onPress, testID }: ExpansionCellProps) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.expansionCell, { opacity: pressed ? 0.8 : 1 }]}
      testID={testID}
    >
      <View
        style={[
          styles.expansionImageFrame,
          {
            backgroundColor: theme.colors.field,
            borderColor: theme.colors.outlineSubtle,
          },
        ]}
      >
        {expansion.imageUrl && !hasImageError ? (
          <Image
            onError={() => setHasImageError(true)}
            resizeMode="contain"
            source={{ uri: expansion.imageUrl }}
            style={styles.expansionImage}
          />
        ) : (
          <Text
            numberOfLines={3}
            style={[styles.expansionImageFallback, theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {expansion.name}
          </Text>
        )}
      </View>
      <Text numberOfLines={2} style={[styles.expansionName, theme.typography.body, { color: theme.colors.textPrimary }]}>
        {expansion.name}
      </Text>
      {expansion.releaseDate ? (
        <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {expansion.releaseDate}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  expansionCell: {
    alignItems: 'center',
    flex: 1 / 2,
    gap: 6,
    padding: 8,
  },
  expansionImage: {
    height: '100%',
    width: '100%',
  },
  expansionImageFallback: {
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  expansionImageFrame: {
    alignItems: 'center',
    aspectRatio: 16 / 10,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  expansionName: {
    textAlign: 'center',
    width: '100%',
  },
});
