import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type InventoryCardTileKind = 'raw' | 'slab';

export type InventoryCardTileProps = {
  imageUrl: string | null;
  name: string;
  setName: string;
  cardNumber: string | null;
  kind: InventoryCardTileKind;
  conditionLabel?: string | null;
  graderLabel?: string | null;
  gradeLabel?: string | null;
  quantity: number;
  priceLabel: string | null;
  dayChangeLabel: string | null;
  isFavorite: boolean;
  selected?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
};

const STAR_COLOR = '#F5C518';
const DELTA_BACKGROUND = '#E2F4E8';
const DELTA_FOREGROUND = '#2D9148';

function buildSetLine(setName: string, cardNumber: string | null) {
  const trimmedSet = setName.trim();
  const trimmedNumber = (cardNumber ?? '').trim();
  if (trimmedSet && trimmedNumber) {
    return `${trimmedSet} #${trimmedNumber}`;
  }
  if (trimmedSet) {
    return trimmedSet;
  }
  if (trimmedNumber) {
    return `#${trimmedNumber}`;
  }
  return '';
}

function buildQualityLine(
  kind: InventoryCardTileKind,
  conditionLabel: string | null | undefined,
  graderLabel: string | null | undefined,
  gradeLabel: string | null | undefined,
) {
  if (kind === 'slab') {
    const grader = (graderLabel ?? '').trim();
    const grade = (gradeLabel ?? '').trim();
    return [grader, grade].filter(Boolean).join(' ');
  }
  return (conditionLabel ?? '').trim();
}

export function InventoryCardTile({
  imageUrl,
  name,
  setName,
  cardNumber,
  kind,
  conditionLabel,
  graderLabel,
  gradeLabel,
  quantity,
  priceLabel,
  dayChangeLabel,
  isFavorite,
  selected = false,
  onPress,
  onLongPress,
  testID,
}: InventoryCardTileProps) {
  const theme = useSpotlightTheme();

  const setLine = buildSetLine(setName, cardNumber);
  const qualityLine = buildQualityLine(kind, conditionLabel, graderLabel, gradeLabel);
  const showDelta = dayChangeLabel !== null && dayChangeLabel.trim().length > 0;
  const showStar = isFavorite;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      delayLongPress={220}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pressable,
        {
          opacity: pressed ? 0.92 : 1,
        },
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.imageFrame,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.layout.inventoryArtRadius,
            borderColor: selected ? theme.colors.brand : 'transparent',
            borderWidth: selected ? 2 : 0,
          },
        ]}
        testID={testID ? `${testID}-image-frame` : undefined}
      >
        {imageUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            source={{ uri: imageUrl }}
            style={[
              styles.image,
              { borderRadius: theme.layout.inventoryArtRadius },
            ]}
            testID={testID ? `${testID}-image` : undefined}
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <AppText color="textSecondary" variant="micro">
              CARD
            </AppText>
          </View>
        )}

        {showStar ? (
          <View
            pointerEvents="none"
            style={styles.starBadge}
            testID={testID ? `${testID}-star` : undefined}
          >
            <AppText style={[styles.starGlyph, { color: STAR_COLOR }]}>★</AppText>
          </View>
        ) : null}

        {selected ? (
          <View
            pointerEvents="none"
            style={[
              styles.selectionVeil,
              {
                backgroundColor: 'rgba(254, 227, 51, 0.16)',
                borderRadius: theme.layout.inventoryArtRadius,
              },
            ]}
            testID={testID ? `${testID}-selection-overlay` : undefined}
          />
        ) : null}
      </View>

      <View style={styles.copyStack}>
        <AppText
          color="textPrimary"
          numberOfLines={1}
          style={styles.name}
          variant="headline"
        >
          {name}
        </AppText>

        {setLine ? (
          <AppText
            color="textSecondary"
            numberOfLines={1}
            variant="caption"
          >
            {setLine}
          </AppText>
        ) : null}

        {qualityLine ? (
          <AppText
            color="textSecondary"
            numberOfLines={1}
            variant="caption"
          >
            {qualityLine}
          </AppText>
        ) : null}

        <AppText color="textSecondary" numberOfLines={1} variant="caption">
          {`Qty: ${quantity}`}
        </AppText>

        <View style={styles.priceRow}>
          <AppText
            color="textPrimary"
            numberOfLines={1}
            style={styles.price}
            variant="headline"
          >
            {priceLabel ?? '—'}
          </AppText>
          {showDelta ? (
            <View
              style={[
                styles.deltaPill,
                {
                  backgroundColor: DELTA_BACKGROUND,
                  borderRadius: theme.radii.pill,
                },
              ]}
              testID={testID ? `${testID}-delta` : undefined}
            >
              <AppText
                style={[styles.deltaLabel, { color: DELTA_FOREGROUND }]}
                variant="caption"
              >
                {dayChangeLabel}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  copyStack: {
    gap: 2,
    marginTop: 8,
    width: '100%',
  },
  deltaLabel: {
    fontSize: 11,
    lineHeight: 14,
  },
  deltaPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  image: {
    height: '100%',
    width: '100%',
  },
  imageFrame: {
    aspectRatio: 1,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  imagePlaceholder: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  name: {},
  pressable: {
    width: '100%',
  },
  price: {
    flexShrink: 1,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  selectionVeil: {
    ...StyleSheet.absoluteFillObject,
  },
  starBadge: {
    position: 'absolute',
    right: 8,
    top: 8,
  },
  starGlyph: {
    fontSize: 20,
    lineHeight: 22,
    textShadowColor: 'rgba(0, 0, 0, 0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
