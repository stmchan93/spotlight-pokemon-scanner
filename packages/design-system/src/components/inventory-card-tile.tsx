import { ArrowDown, ArrowUp, ArrowUpRightSquare, BoxIso, Star, StarSolid } from 'iconoir-react-native';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { SelectionCheckCircle } from './selection-check-circle';

export type InventoryCardTileKind = 'raw' | 'slab';

export type InventoryCardTileDirection = 'up' | 'down';

export type InventoryCardTileProps = {
  imageUrl: string | null;
  name: string;
  setName: string;
  cardNumber: string | null;
  kind: InventoryCardTileKind;
  /** Print variant (e.g. "Holofoil"); renders above the condition/grade line. */
  variantName?: string | null;
  conditionLabel?: string | null;
  graderLabel?: string | null;
  gradeLabel?: string | null;
  quantity: number;
  priceLabel: string | null;
  dayChangeLabel: string | null;
  dayChangeDirection?: InventoryCardTileDirection | null;
  isFavorite: boolean;
  /**
   * When true (default) the favorite star badge renders in the tile's
   * top-right corner. Set false to hide it entirely (Collection card view).
   */
  showFavorite?: boolean;
  selected?: boolean;
  /**
   * When true, a selection check-circle renders in the tile's top-right corner
   * (the favorite-star slot) reflecting `selected`. Used for multi-select edit
   * mode; takes the badge slot from the favorite star while active.
   */
  selectable?: boolean;
  /**
   * When true (default) the tile is a self-contained card: gray50 fill, a
   * gray100 hairline border, and rounded shell corners. When false the tile is
   * "plain" — no fill, no shell border, no shell rounding — for ruled-grid
   * layouts where the surrounding container draws full-bleed top/bottom
   * dividers (Collection card view, Figma node 800-7368). The card art keeps
   * its rounded corners in either mode.
   */
  bordered?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  /** Long-press delay in ms. Defaults to 220 (a quick press-and-hold). */
  delayLongPress?: number;
  /**
   * When true, renders a "Live on eBay" footer below the price row with a
   * small live-dot, the label, and an arrow-up-right icon. Tile grows by ~38px
   * to make room.
   */
  liveOnEbay?: boolean;
  /**
   * Optional tap handler for the Live on eBay footer (e.g., opens the listing
   * URL in an external browser).
   */
  onOpenListing?: () => void;
  testID?: string;
};

function formatCardNumber(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // Bare collector number, no "#" prefix (matches the PDP identity + Figma).
  return trimmed.replace(/^#/, '');
}

function buildSetLine(setName: string, cardNumber: string | null) {
  const trimmedSet = setName.trim();
  const formattedNumber = formatCardNumber(cardNumber);
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
  variantName,
  conditionLabel,
  graderLabel,
  gradeLabel,
  quantity,
  priceLabel,
  dayChangeLabel,
  dayChangeDirection = null,
  isFavorite,
  showFavorite = true,
  selected = false,
  selectable = false,
  bordered = true,
  onPress,
  onLongPress,
  delayLongPress = 220,
  liveOnEbay = false,
  onOpenListing,
  testID,
}: InventoryCardTileProps) {
  const theme = useSpotlightTheme();

  // The card art stays rounded regardless of the tile shell mode — only the
  // outer shell (fill/border/corner radius) toggles with `bordered`.
  const artRadius = theme.layout.inventoryArtRadius;

  const setLine = buildSetLine(setName, cardNumber);
  const qualityLine = buildQualityLine(kind, conditionLabel, graderLabel, gradeLabel);
  const showDelta =
    dayChangeDirection != null &&
    dayChangeLabel !== null &&
    dayChangeLabel.trim().length > 0;
  const isDown = dayChangeDirection === 'down';
  const deltaBackground = isDown ? theme.colors.deltaDownSurface : theme.colors.deltaUpSurface;
  const deltaForeground = isDown ? theme.colors.deltaDownText : theme.colors.deltaUpText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      delayLongPress={delayLongPress}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pressable,
        {
          backgroundColor: bordered ? theme.colors.gray50 : 'transparent',
          borderColor: bordered ? theme.colors.gray100 : 'transparent',
          borderWidth: bordered ? 1 : 0,
          borderRadius: bordered ? theme.radii.md : 0,
          opacity: pressed ? 0.92 : 1,
        },
      ]}
      testID={testID}
    >
      <View style={styles.cardContent}>
        <View
          style={[styles.imageFrame, { borderRadius: artRadius }]}
          testID={testID ? `${testID}-image-frame` : undefined}
        >
          {imageUrl ? (
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri: imageUrl }}
              style={[
                styles.image,
                { borderRadius: artRadius },
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

          {/* Quantity chip (Figma 2368:43026): gray100 corner tag docked at the
              art's top-left — box icon + owned count, replacing "Qty: N". */}
          <View
            style={[styles.quantityChip, { backgroundColor: theme.colors.gray100 }]}
            testID={testID ? `${testID}-quantity` : undefined}
          >
            <BoxIso color={theme.colors.gray700} height={12} width={12} />
            <AppText color="gray700" variant="overline">
              {String(quantity)}
            </AppText>
          </View>
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
                color="gray600"
                numberOfLines={1}
                variant="label"
              >
                {setLine}
              </AppText>
            ) : null}

            {(variantName ?? '').trim() ? (
              <AppText
                color="gray600"
                numberOfLines={1}
                variant="label"
              >
                {(variantName ?? '').trim()}
              </AppText>
            ) : null}

            {qualityLine ? (
              <AppText
                color="gray600"
                numberOfLines={1}
                variant="label"
              >
                {qualityLine}
              </AppText>
            ) : null}
          </View>

          <View style={styles.priceRow}>
            <AppText
              color="textPrimary"
              numberOfLines={1}
              style={styles.price}
              variant="priceCaption"
            >
              {priceLabel ?? '—'}
            </AppText>
            {showDelta ? (
              <View
                style={[
                  styles.deltaPill,
                  {
                    backgroundColor: deltaBackground,
                    borderRadius: 4,
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
                  variant="label"
                >
                  {dayChangeLabel}
                </AppText>
              </View>
            ) : null}
          </View>

          {liveOnEbay ? (
            <Pressable
              accessibilityLabel="Open eBay listing"
              accessibilityRole="link"
              disabled={!onOpenListing}
              onPress={onOpenListing}
              style={({ pressed }) => [
                styles.ebayFooter,
                {
                  opacity: pressed && onOpenListing ? 0.7 : 1,
                },
              ]}
              testID={testID ? `${testID}-live-on-ebay` : undefined}
            >
              <View
                style={[
                  styles.ebayDot,
                  { backgroundColor: theme.colors.green400 },
                ]}
              />
              <AppText
                color="textMuted"
                numberOfLines={1}
                style={styles.ebayLabel}
                variant="cardMeta"
              >
                Live on eBay
              </AppText>
              <ArrowUpRightSquare
                color={theme.colors.gray600}
                height={12}
                width={12}
              />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* In edit/multi-select mode the selection check-circle takes the
          top-right badge slot (replacing the favorite star) so selection state
          reads in the same spot the star otherwise occupies. */}
      {selectable ? (
        <View
          pointerEvents="none"
          style={styles.starBadge}
          testID={testID ? `${testID}-select` : undefined}
        >
          <SelectionCheckCircle selected={selected} />
        </View>
      ) : null}

      {/* Star sits on the wrapper (not the imageFrame) so it has consistent
          breathing room (8px) from the card art and visually floats in the
          gray padding area at the top-right of the tile. */}
      {!selectable && showFavorite ? (
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
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardContent: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flex: 1,
    flexDirection: 'column',
    gap: 16,
  },
  copyStack: {
    alignItems: 'flex-start',
    alignSelf: 'stretch',
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
  quantityChip: {
    alignItems: 'center',
    // Docked at the art's TOP-LEFT (Figma 2368:43026); the inner corner rounds.
    borderBottomRightRadius: 4,
    flexDirection: 'row',
    gap: 2,
    left: 0,
    paddingHorizontal: 8,
    paddingVertical: 3,
    position: 'absolute',
    top: 0,
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
    overflow: 'hidden',
    padding: 16,
    position: 'relative',
    width: '100%',
  },
  price: {
    flexShrink: 1,
    // Figma 1263:3390 — Bold 13/140% (priceCaption variant supplies the Bold
    // family; this bumps the size from the 12px catalog default to 13).
    fontSize: 13,
    lineHeight: 18.2,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  starBadge: {
    position: 'absolute',
    right: 8,
    top: 8,
  },
  ebayFooter: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
    paddingTop: 10,
  },
  ebayDot: {
    borderRadius: 999,
    height: 6,
    width: 6,
  },
  ebayLabel: {
    flex: 1,
  },
});
