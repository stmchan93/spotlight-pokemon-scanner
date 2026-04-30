import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { resolveConditionDisplayLabel } from '@/lib/condition-display';
import { getCardImageSource } from '@/lib/card-images';

type InventoryEntryCardProps = {
  entry: InventoryCardEntry;
  isSelected?: boolean;
  showConditionLabel?: boolean;
  selectionMode?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
};

function conditionLabel(entry: InventoryCardEntry) {
  if (entry.kind === 'graded') {
    return `${entry.slabContext?.grader ?? 'Graded'} ${entry.slabContext?.grade ?? ''}`.trim();
  }

  return resolveConditionDisplayLabel({
    conditionCode: entry.conditionCode,
    conditionLabel: entry.conditionLabel,
    conditionShortLabel: entry.conditionShortLabel,
    fallback: '',
  });
}

function normalizedVariantLabel(entry: InventoryCardEntry) {
  const rawVariant = (entry.slabContext?.variantName ?? entry.variantName ?? '').trim();
  if (!rawVariant) {
    return null;
  }

  const normalized = rawVariant.toLowerCase();
  if (normalized === 'raw' || normalized === 'normal') {
    return null;
  }

  return rawVariant;
}

function inventoryDescriptorLabel(entry: InventoryCardEntry) {
  const primaryLabel = conditionLabel(entry).trim();
  const variantLabel = normalizedVariantLabel(entry);

  if (primaryLabel && variantLabel) {
    return `${primaryLabel} • ${variantLabel}`;
  }

  return primaryLabel || variantLabel;
}

export function InventoryEntryCard({
  entry,
  isSelected = false,
  showConditionLabel = false,
  selectionMode = false,
  onLongPress,
  onPress,
}: InventoryEntryCardProps) {
  const theme = useSpotlightTheme();
  const descriptorLabel = showConditionLabel ? inventoryDescriptorLabel(entry) : '';

  return (
    <Pressable
      accessibilityRole="button"
      delayLongPress={220}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pressable,
        {
          opacity: pressed ? 0.9 : 1,
        },
      ]}
      testID={`inventory-entry-${entry.id}`}
    >
      <SurfaceCard
        padding={8}
        radius={18}
        style={[
          styles.tile,
          {
            backgroundColor: isSelected ? theme.colors.surfaceMuted : theme.colors.canvasElevated,
            borderColor: isSelected ? theme.colors.brand : theme.colors.outlineSubtle,
            borderWidth: isSelected ? 1.5 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.imageFrame,
            {
              backgroundColor: theme.colors.surface,
            },
          ]}
        >
          <CachedImage
            cachePolicy={imageCachePolicy.thumbnail}
            contentFit="contain"
            source={getCardImageSource(entry, 'small')}
            style={styles.cardArt}
          />

          {isSelected ? (
            <View
              pointerEvents="none"
              style={[styles.selectionVeil, { backgroundColor: 'rgba(254, 227, 51, 0.12)' }]}
            />
          ) : null}

          {selectionMode ? (
            <View
              style={[
                styles.selectionBadge,
                {
                  backgroundColor: isSelected ? theme.colors.brand : '#FFFFFF',
                  borderColor: isSelected ? theme.colors.brand : theme.colors.outlineSubtle,
                },
              ]}
            >
              {isSelected ? (
                <Text style={[theme.typography.headline, styles.checkmark]}>✓</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        <Text numberOfLines={1} style={[theme.typography.caption, styles.name]}>
          {entry.name}
        </Text>
        <Text numberOfLines={1} style={[theme.typography.caption, styles.price]}>
          {formatOptionalCurrency(entry.hasMarketPrice ? entry.marketPrice : null, entry.currencyCode)}
        </Text>

        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={[theme.typography.caption, styles.metaText]}>
            {entry.cardNumber}
          </Text>
          <View style={styles.quantityCluster}>
            <Text numberOfLines={1} style={[theme.typography.micro, styles.quantityIcon]}>
              ◫
            </Text>
            <Text numberOfLines={1} style={[theme.typography.caption, styles.metaValue]}>
              {entry.quantity}
            </Text>
          </View>
        </View>

        {descriptorLabel ? (
          <Text numberOfLines={1} style={[theme.typography.micro, styles.detailText]}>
            {descriptorLabel}
          </Text>
        ) : null}
      </SurfaceCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardArt: {
    borderRadius: 14,
    height: '100%',
    resizeMode: 'contain',
    width: '100%',
  },
  checkmark: {
    color: '#0F0F12',
    fontSize: 14,
    lineHeight: 16,
  },
  detailText: {
    marginTop: 2,
  },
  imageFrame: {
    borderRadius: 14,
    height: 144,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  metaValue: {
    color: '#0F0F12',
    flexShrink: 0,
  },
  metaText: {
    flex: 1,
    marginRight: 6,
  },
  quantityCluster: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  quantityIcon: {
    color: '#0F0F12',
  },
  name: {
    color: '#0F0F12',
    marginTop: 8,
  },
  pressable: {
    width: '100%',
  },
  price: {
    color: '#0F0F12',
    marginTop: 2,
  },
  selectionBadge: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: 10,
    top: 10,
    width: 28,
  },
  selectionVeil: {
    ...StyleSheet.absoluteFillObject,
  },
  tile: {
    width: '100%',
  },
});
