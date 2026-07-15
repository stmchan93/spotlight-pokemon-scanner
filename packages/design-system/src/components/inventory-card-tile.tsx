import { ArrowUpRightSquare, BoxIso, Star, StarSolid } from 'iconoir-react-native';
import { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  View,
  type ImageLoadEventData,
  type NativeSyntheticEvent,
} from 'react-native';

// Standard portrait trading-card ratio (Scrydex renders ~245×342) — the art
// wrapper's default shape until the real image reports its dimensions.
const DEFAULT_CARD_ASPECT = 245 / 342;
// Slab display slot ratio (Figma 2609:6977's 84×136 card-image slot).
const SLAB_ASPECT = 84 / 136;

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { SelectionCheckCircle } from './selection-check-circle';
import { SlabFrame } from './slab-frame';

export type InventoryCardTileKind = 'raw' | 'slab';

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
  /**
   * When true (default) the condition/grade text line renders under the card.
   * Set false to hide just that text while keeping the slab-case thumbnail
   * frame intact (Wishlist, where copy-specific condition isn't shown).
   */
  showQualityLine?: boolean;
  quantity?: number;
  priceLabel: string | null;
  isFavorite: boolean;
  /**
   * When true (default) the favorite star badge renders in the tile's
   * top-right corner. Set false to hide it entirely (Collection card view).
   */
  showFavorite?: boolean;
  /**
   * When true (default) the quantity renders at the right edge of the price
   * row (count + box icon, Figma 2489:6459). Set false for surfaces with no
   * owned-quantity concept (Wishlist card view), where `quantity` may then be
   * omitted.
   */
  showQuantity?: boolean;
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
   * layouts where the surrounding container draws the gray400 0.5pt rules
   * (Collection card view, Figma node 2489:6459). The card art keeps its
   * rounded corners in either mode.
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
  showQualityLine = true,
  quantity = 1,
  priceLabel,
  isFavorite,
  showFavorite = true,
  showQuantity = true,
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

  // Art radius is per-kind (Figma 2609:7016 / 2609:6977): raw scans get a
  // subtle rounding, slab photos stay square (the PSA case in the photo has
  // its own shape — rounding would clip it). Independent of the `bordered`
  // shell mode.
  const artRadius =
    kind === 'slab'
      ? theme.layout.inventoryArtRadiusSlab
      : theme.layout.inventoryArtRadiusRaw;

  // The art is letterboxed inside a SQUARE frame, so the frame's top-left is
  // whitespace, not the card's corner. Instead of measuring offsets, the image
  // + quantity chip live inside a CARD-SHAPED wrapper (the image's real aspect,
  // defaulting to the standard portrait card ratio) centered in the frame — the
  // chip docks to the wrapper's corner, which IS the card's corner.
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const handleImageLoad = (event: NativeSyntheticEvent<ImageLoadEventData>) => {
    const source = event.nativeEvent?.source;
    if (source?.width && source?.height) {
      setImageAspect(source.width / source.height);
    }
  };

  const setLine = buildSetLine(setName, cardNumber);
  const qualityLine = buildQualityLine(kind, conditionLabel, graderLabel, gradeLabel);
  // Slabs render their art inside the slab-case frame — keyed by THIS entry's
  // own grader (unknown graders get the neutral label).
  const brandedGrader = kind === 'slab' ? (graderLabel ?? '').trim() || null : null;

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
          {brandedGrader ? (
            // Slab-case frame (Figma 2609:6812): the card art sits inside its
            // grading slab with the grader's own label band on top. The slot is
            // the SLAB's 84:136 ratio (Figma 2609:6977) — NOT the card image's
            // aspect, which is wider and would fatten the case.
            <View style={[styles.artWrap, { aspectRatio: SLAB_ASPECT }]}>
              <SlabFrame
                cardNumber={cardNumber}
                detailLine={variantName}
                grade={(gradeLabel ?? '').trim() || null}
                grader={brandedGrader}
                setLine={setName}
                size="md"
                testID={testID ? `${testID}-slab-frame` : undefined}
                title={name}
              >
                {imageUrl ? (
                  <Image
                    accessibilityIgnoresInvertColors
                    onLoad={handleImageLoad}
                    // cover (not contain): the SlabFrame crop scales the art past
                    // the case edges, so it must fill the crop box (Figma 2609:14258).
                    resizeMode="cover"
                    source={{ uri: imageUrl }}
                    style={styles.image}
                    testID={testID ? `${testID}-image` : undefined}
                  />
                ) : (
                  <View style={styles.imagePlaceholder}>
                    <AppText color="textSecondary" variant="micro">
                      CARD
                    </AppText>
                  </View>
                )}
              </SlabFrame>
            </View>
          ) : (
            <View
              style={[styles.artWrap, { aspectRatio: imageAspect ?? DEFAULT_CARD_ASPECT }]}
            >
              {imageUrl ? (
                <Image
                  accessibilityIgnoresInvertColors
                  onLoad={handleImageLoad}
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
            </View>
          )}
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

            {showQualityLine && qualityLine ? (
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
            {/* Quantity sits at the price row's right edge (Figma 2489:6459):
                count + box icon, replacing the old top-left overlay chip. */}
            {showQuantity ? (
              <View
                style={styles.quantityGroup}
                testID={testID ? `${testID}-quantity` : undefined}
              >
                <AppText color="gray700" variant="label">
                  {String(quantity)}
                </AppText>
                <BoxIso color={theme.colors.gray700} height={16} width={16} />
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
    gap: 12,
    // Padding lives here (not on the Pressable) so the Pressable's absolute
    // children — the star/selection badges — pin to the tile's TRUE corners.
    padding: 16,
  },
  copyStack: {
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    gap: 2,
    width: '100%',
  },
  image: {
    height: '100%',
    width: '100%',
  },
  // Card-shaped inner wrapper: the image fills it exactly, so children pinned
  // to its corners sit on the CARD, not the letterboxed frame.
  artWrap: {
    alignSelf: 'center',
    height: '100%',
    maxWidth: '100%',
    position: 'relative',
  },
  imageFrame: {
    alignItems: 'center',
    aspectRatio: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  quantityGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  imagePlaceholder: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  metaStack: {
    alignItems: 'flex-start',
    gap: 2,
    width: '100%',
  },
  pressable: {
    alignSelf: 'stretch',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  price: {
    flexShrink: 1,
    // Figma 2489:6459 — Bold 14/150% (priceCaption variant supplies the Bold
    // family; this bumps the size from the 12px catalog default to 14).
    fontSize: 14,
    lineHeight: 21,
  },
  priceRow: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 4,
    width: '100%',
  },
  starBadge: {
    // Padding moved off the Pressable, so bake it into the offset (16 + 8) to
    // keep the star/selection badge exactly where it was.
    position: 'absolute',
    right: 24,
    top: 24,
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
