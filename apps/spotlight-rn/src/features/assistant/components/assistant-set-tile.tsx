import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AssistantSetRef, AssistantSetWindow } from '@spotlight/api-client';
import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';

// Wider than a card tile: set logos are wordmarks (Market Watch's 83x40 slot, with room).
const TILE_WIDTH = 132;
const LOGO_HEIGHT = 72;
const LOGO_PADDING = spacing.xs;

const windowCaption: Record<AssistantSetWindow, string> = {
  '7d': 'Past week',
  '30d': 'Past month',
  '90d': 'Past 3 months',
};

/** "Past month · 2013" under the set name; empty when neither is known. */
export function assistantSetMeta(set: AssistantSetRef): string {
  return [set.window ? windowCaption[set.window] : null, set.releaseYear].filter(Boolean).join(' · ');
}

type AssistantSetTileProps = {
  set: AssistantSetRef;
  onPress: (set: AssistantSetRef) => void;
  testID?: string;
};

/** One set under a set-level answer: logo (or the name as a wordmark), name, % move. */
export function AssistantSetTile({ set, onPress, testID }: AssistantSetTileProps) {
  const theme = useSpotlightTheme();
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [set.logoUrl]);
  const showLogo = Boolean(set.logoUrl) && !logoFailed;
  const change = set.changePct;
  const meta = assistantSetMeta(set);
  return (
    <Pressable
      accessibilityLabel={[set.name, change != null ? formatSignedPercent(change) : null, meta].filter(Boolean).join(', ')}
      accessibilityRole="button"
      onPress={() => onPress(set)}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.86 : 1 }]}
      testID={testID}
    >
      <View style={[styles.logo, { backgroundColor: theme.colors.gray100 }]}>
        {showLogo ? (
          <CachedImage
            contentFit="contain"
            onError={() => setLogoFailed(true)}
            style={styles.fill}
            testID={testID ? `${testID}-logo` : undefined}
            uri={set.logoUrl}
          />
        ) : (
          // No logo: the name takes the slot as a wordmark (as on the sets list).
          <Text
            numberOfLines={2}
            style={[theme.typography.captionMedium, styles.wordmark, { color: theme.colors.gray900 }]}
            testID={testID ? `${testID}-wordmark` : undefined}
          >
            {set.name}
          </Text>
        )}
      </View>
      <Text numberOfLines={1} style={[theme.typography.captionMedium, { color: theme.colors.gray900 }]}>
        {set.name}
      </Text>
      {meta ? (
        <Text numberOfLines={1} style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]}>
          {meta}
        </Text>
      ) : null}
      {change != null ? (
        <Text
          style={[theme.typography.labelStrong, { color: change >= 0 ? theme.colors.green500 : theme.colors.red500 }]}
          testID={testID ? `${testID}-change` : undefined}
        >
          {formatSignedPercent(change)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: spacing.xxxs,
    width: TILE_WIDTH,
  },
  logo: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: LOGO_HEIGHT,
    justifyContent: 'center',
    marginBottom: spacing.xxxs,
    overflow: 'hidden',
    padding: LOGO_PADDING,
    width: '100%',
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  wordmark: {
    textAlign: 'center',
  },
});
