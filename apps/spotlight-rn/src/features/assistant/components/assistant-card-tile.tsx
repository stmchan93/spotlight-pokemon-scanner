import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AssistantCardRef } from '@spotlight/api-client';
import { AppText, Text, layout, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

const TILE_WIDTH = 132;

/** "Celebi" + "XY Black Star Promos · XY111" + price + owned qty. USD only; null price = "No price". */
export function assistantCardMeta(card: AssistantCardRef): string {
  const slab = card.grader ? ` · ${[card.grader, card.grade].filter(Boolean).join(' ')}` : '';
  return [card.setName, card.number].filter(Boolean).join(' · ') + slab;
}

type AssistantCardTileProps = {
  card: AssistantCardRef;
  onPress: (cardId: string) => void;
  testID?: string;
};

export function AssistantCardTile({ card, onPress, testID }: AssistantCardTileProps) {
  const theme = useSpotlightTheme();
  const owned = card.quantityOwned ?? 0;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [card.imageSmallUrl]);
  const showImage = Boolean(card.imageSmallUrl) && !imageFailed;
  return (
    <Pressable
      accessibilityLabel={`${card.name}, ${assistantCardMeta(card)}`}
      accessibilityRole="button"
      onPress={() => onPress(card.cardId)}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: theme.colors.gray0,
          borderColor: theme.colors.gray200,
          opacity: pressed ? 0.86 : 1,
        },
      ]}
      testID={testID}
    >
      <View style={[styles.art, { backgroundColor: showImage ? theme.colors.gray100 : theme.colors.field }]}>
        {showImage ? (
          <CachedImage
            contentFit="contain"
            onError={() => setImageFailed(true)}
            style={styles.fill}
            testID={testID ? `${testID}-image` : undefined}
            uri={card.imageSmallUrl}
          />
        ) : (
          // Same "CARD" placeholder as the inventory tile and list rows.
          <AppText color="textSecondary" testID={testID ? `${testID}-placeholder` : undefined} variant="micro">
            CARD
          </AppText>
        )}
      </View>
      <Text numberOfLines={1} style={theme.typography.labelStrong}>
        {card.name}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
        {assistantCardMeta(card)}
      </Text>
      <View style={styles.footer}>
        <Text style={theme.typography.labelStrong} testID={testID ? `${testID}-price` : undefined}>
          {card.priceUsd != null ? formatCurrency(card.priceUsd, 'USD') : 'No price'}
        </Text>
        {owned > 0 ? (
          <Text style={[theme.typography.caption, { color: theme.colors.purple500 }]}>
            {`Own ×${owned}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xxxs,
    padding: spacing.xxs,
    width: TILE_WIDTH,
  },
  art: {
    alignItems: 'center',
    aspectRatio: layout.rowThumbnailWidth / layout.rowThumbnailHeight,
    borderCurve: 'continuous',
    borderRadius: layout.inventoryArtRadiusRaw,
    justifyContent: 'center',
    marginBottom: spacing.xxxs,
    overflow: 'hidden',
    width: '100%',
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  footer: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
