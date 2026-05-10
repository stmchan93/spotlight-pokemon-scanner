import { ArrowDown, ArrowUp, Star, StarSolid } from 'iconoir-react-native';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type InventoryCardTileKind = 'raw' | 'slab';

export type InventoryCardTileDirection = 'up' | 'down';

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
  dayChangeDirection?: InventoryCardTileDirection | null;
  isFavorite: boolean;
  selected?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
};

const DELTA_UP_BACKGROUND = 'rgba(76, 175, 110, 0.15)';
const DELTA_DOWN_BACKGROUND = 'rgba(224, 82, 76, 0.15)';

function formatCardNumberWithHash(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return `#${trimmed.replace(/^#/, '')}`;
}

function buildSetLine(setName: string, cardNumber: string | null) {
  const trimmedSet = setName.trim();
  const formattedNumber = formatCardNumberWithHash(cardNumber);
  if (trimmedSet && formattedNumber) {
    return `${formattedNumber} · ${trimmedSet}`;
  }
  if (trimmedSet) {
    return trimmedSet;
  }
  if (formattedNumber) {
    return formattedNumber;
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
  dayChangeDirection = null,
  isFavorite,
  selected = false,
  onPress,
  onLongPress,
  testID,
}: InventoryCardTileProps) {
  const theme = useSpotlightTheme();

  const setLine = buildSetLine(setName, cardNumber);
  const qualityLine = buildQualityLine(kind, conditionLabel, graderLabel, gradeLabel);
  const showDelta =
    dayChangeDirection != null &&
    dayChangeLabel !== null &&
    dayChangeLabel.trim().length > 0;
  const isDown = dayChangeDirection === 'down';
  const deltaBackground = isDown ? DELTA_DOWN_BACKGROUND : DELTA_UP_BACKGROUND;
  const deltaForeground = isDown ? theme.colors.redDelta : theme.colors.greenDelta;

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

        <View
          pointerEvents="none"
          style={styles.starBadge}
          testID={testID ? `${testID}-star` : undefined}
        >
          {isFavorite ? (
            <StarSolid
              color={theme.colors.starFavorited}
              height={20}
              testID={testID ? `${testID}-star-filled` : undefined}
              width={20}
            />
          ) : (
            <Star
              color={theme.colors.starOutline}
              height={20}
              testID={testID ? `${testID}-star-outlined` : undefined}
              width={20}
            />
          )}
        </View>

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
          variant="headline"
        >
          {name}
        </AppText>

        <View style={styles.metaStack}>
          {setLine ? (
            <AppText
              color="textMuted"
              numberOfLines={1}
              variant="cardMeta"
            >
              {setLine}
            </AppText>
          ) : null}

          {qualityLine ? (
            <AppText
              color="textMuted"
              numberOfLines={1}
              variant="cardMeta"
            >
              {qualityLine}
            </AppText>
          ) : null}

          <AppText color="textMuted" numberOfLines={1} variant="cardMeta">
            {`Qty: ${quantity}`}
          </AppText>
        </View>

        <View style={styles.priceRow}>
          <AppText
            color="textPrimary"
            numberOfLines={1}
            style={styles.price}
            variant="caption"
          >
            {priceLabel ?? '—'}
          </AppText>
          {showDelta ? (
            <View
              style={[
                styles.deltaPill,
                {
                  backgroundColor: deltaBackground,
                  borderRadius: theme.radii.pill,
                },
              ]}
              testID={testID ? `${testID}-delta` : undefined}
            >
              {isDown ? (
                <ArrowDown
                  color={deltaForeground}
                  height={12}
                  testID={
                    testID ? `${testID}-delta-arrow-down` : undefined
                  }
                  width={12}
                />
              ) : (
                <ArrowUp
                  color={deltaForeground}
                  height={12}
                  testID={
                    testID ? `${testID}-delta-arrow-up` : undefined
                  }
                  width={12}
                />
              )}
              <AppText
                style={[styles.deltaLabel, { color: deltaForeground }]}
                variant="deltaPill"
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
    alignItems: 'flex-start',
    gap: 4,
    width: '100%',
  },
  deltaLabel: {
    // color overridden inline; spacing handled via pill padding
  },
  deltaPill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
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
  metaStack: {
    alignItems: 'flex-start',
    gap: 4,
    width: '100%',
  },
  pressable: {
    alignSelf: 'stretch',
    flexDirection: 'column',
    gap: 16,
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
});
