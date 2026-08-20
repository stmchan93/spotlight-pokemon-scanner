import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check as IconCheck } from 'iconoir-react-native';

import type {
  CatalogSearchResult,
  DeckConditionCode,
  RawPricingMatrix,
  RawPricingMatrixVariant,
  SlabContext,
} from '@spotlight/api-client';
import {
  IconButton,
  SheetHeader,
  SurfaceCard,
  Text,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { buildTcgPlayerSearchUrl } from '@/features/cards/marketplace-urls';
import { useAppServices } from '@/providers/app-providers';

import { formatCurrency, isFinitePrice } from './scanner-screen-helpers';

const conditionShortLabels: Record<string, string> = {
  NM: 'NM',
  LP: 'LP',
  MP: 'MP',
  HP: 'HP',
  DM: 'DMG',
};

const conditionCodeToDeckCondition: Record<string, DeckConditionCode> = {
  NM: 'near_mint',
  LP: 'lightly_played',
  MP: 'moderately_played',
  HP: 'heavily_played',
  DM: 'damaged',
};

export type ScanPriceSheetMode = 'raw' | 'slabs';

export type ScanPriceSheetSelection = {
  variantKey: string;
  variantLabel: string;
  conditionCode: DeckConditionCode;
  conditionShortLabel: string;
  marketPrice: number | null;
};

export type ScanPriceSheetProps = {
  visible: boolean;
  mode: ScanPriceSheetMode;
  candidate: CatalogSearchResult | null;
  slabContext: SlabContext | null;
  selectedVariantKey: string | null;
  selectedConditionCode: DeckConditionCode | null;
  fallbackVariantLabel?: string | null;
  fallbackMarketPrice?: number | null;
  fallbackCurrencyCode?: string | null;
  onSelect: (selection: ScanPriceSheetSelection) => void;
  onClose: () => void;
  onOpenEbayLink?: () => void;
  ebayLinkLoading?: boolean;
  ebayLinkAvailable?: boolean;
  testID?: string;
};

export function ScanPriceSheet({
  visible,
  mode,
  candidate,
  slabContext,
  selectedVariantKey,
  selectedConditionCode,
  fallbackVariantLabel,
  fallbackMarketPrice,
  fallbackCurrencyCode,
  onSelect,
  onClose,
  onOpenEbayLink,
  ebayLinkLoading,
  ebayLinkAvailable,
  testID = 'scan-price-sheet',
}: ScanPriceSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const windowHeight = useWindowDimensions().height;
  const listMaxHeight = Math.max(220, windowHeight * 0.45);
  const { spotlightRepository } = useAppServices();

  const [matrix, setMatrix] = useState<RawPricingMatrix | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const cardId = candidate?.cardId ?? null;

  useEffect(() => {
    if (!visible || mode !== 'raw' || !cardId) {
      return;
    }

    let isActive = true;
    setIsLoading(true);
    setHasError(false);

    void spotlightRepository
      .getRawPricingMatrix(cardId)
      .then((result) => {
        if (!isActive) {
          return;
        }
        setMatrix(result);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }
        setHasError(true);
      })
      .finally(() => {
        if (!isActive) {
          return;
        }
        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [cardId, mode, spotlightRepository, visible]);

  useEffect(() => {
    if (!visible) {
      setMatrix(null);
      setHasError(false);
      setIsLoading(false);
    }
  }, [visible]);

  const currencyCode = matrix?.currencyCode
    ?? fallbackCurrencyCode
    ?? candidate?.currencyCode
    ?? 'USD';

  const hasMatrix = !!matrix && matrix.variants.length > 0;

  const handleSelectRow = useCallback(
    (variant: RawPricingMatrixVariant, conditionCode: string, marketPrice: number | null) => {
      const deckCondition = conditionCodeToDeckCondition[conditionCode] ?? 'near_mint';
      onSelect({
        variantKey: variant.variantKey,
        variantLabel: variant.variant,
        conditionCode: deckCondition,
        conditionShortLabel: conditionShortLabels[conditionCode] ?? conditionCode,
        marketPrice,
      });
      onClose();
    },
    [onClose, onSelect],
  );

  const headerTitle = mode === 'slabs' ? 'Market Sales' : 'Market Price';
  const cardName = candidate?.name ?? '';
  const subtitleParts = [
    candidate?.cardNumber,
    candidate?.setName,
    mode === 'slabs' && slabContext?.grader
      ? `${slabContext.grader}${slabContext.grade ? ` ${slabContext.grade}` : ''}`
      : null,
  ].filter((value): value is string => !!value);
  const subtitle = subtitleParts.join(' • ');

  const slabGradeLabel = slabContext?.grader
    ? `${slabContext.grader}${slabContext.grade ? ` ${slabContext.grade}` : ''}`
    : 'Graded';

  const tcgPlayerUrl = useMemo(() => {
    if (mode !== 'raw' || !candidate) {
      return null;
    }
    return buildTcgPlayerSearchUrl({
      cardNumber: candidate.cardNumber ?? '',
      name: candidate.name ?? '',
      setName: candidate.setName ?? '',
      game: candidate.game,
    });
  }, [candidate, mode]);

  const disclaimer = mode === 'slabs'
    ? 'Sales data sourced from recent eBay sold listings.'
    : 'Market prices are sourced from third-party providers and update daily around 1:00 PM PT.';

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View pointerEvents="box-none" style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close pricing details"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.sheetWrap,
            {
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <SurfaceCard padding={18} radius={0} style={styles.sheet}>
            <SheetHeader
              showHandle
              title={headerTitle}
              subtitle={cardName ? `${cardName}${subtitle ? `\n${subtitle}` : ''}` : subtitle}
              titleStyleVariant="title"
              rightAccessory={(
                <IconButton
                  accessibilityLabel="Close pricing details"
                  onPress={onClose}
                  size={36}
                  testID={`${testID}-close`}
                >
                  <Text style={[theme.typography.headline, styles.closeGlyph, { color: theme.colors.textPrimary }]}>
                    ×
                  </Text>
                </IconButton>
              )}
            />

            <View style={styles.body} testID={`${testID}-body`}>
              {mode === 'slabs' ? (
                <View style={styles.singleRow} testID={`${testID}-slab-row`}>
                  <Text style={styles.rowTitle}>{slabGradeLabel}</Text>
                  <Text style={styles.rowPrice}>
                    {isFinitePrice(fallbackMarketPrice)
                      ? formatCurrency(fallbackMarketPrice, currencyCode)
                      : '—'}
                  </Text>
                </View>
              ) : isLoading ? (
                <View style={styles.loadingState} testID={`${testID}-loading`}>
                  <ActivityIndicator color={theme.colors.brand} size="small" />
                </View>
              ) : hasMatrix ? (
                <ScrollView
                  contentContainerStyle={styles.list}
                  style={{ maxHeight: listMaxHeight }}
                  showsVerticalScrollIndicator
                  testID={`${testID}-list`}
                >
                  {matrix!.variants.map((variant) => (
                    variant.conditions.map((condition) => {
                      const isSelected = selectedVariantKey === variant.variantKey
                        && (conditionCodeToDeckCondition[condition.code] ?? 'near_mint') === selectedConditionCode;
                      return (
                        <Pressable
                          key={`${variant.variantKey}-${condition.code}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                          accessibilityLabel={`${variant.variant} ${condition.label} ${
                            isFinitePrice(condition.market)
                              ? formatCurrency(condition.market, currencyCode)
                              : 'no price'
                          }`}
                          onPress={() => handleSelectRow(variant, condition.code, condition.market ?? null)}
                          style={({ pressed }) => [
                            styles.row,
                            isSelected ? styles.rowSelected : null,
                            pressed ? styles.rowPressed : null,
                          ]}
                          testID={`${testID}-row-${variant.variantKey}-${condition.code}`}
                        >
                          <View style={styles.rowCopy}>
                            <Text style={styles.rowTitle}>
                              {variant.variant} · {condition.label}
                            </Text>
                          </View>
                          <View style={styles.rowTrailing}>
                            <Text style={styles.rowPrice}>
                              {isFinitePrice(condition.market)
                                ? formatCurrency(condition.market, currencyCode)
                                : '—'}
                            </Text>
                            {isSelected ? (
                              <IconCheck color={theme.colors.brand} width={18} height={18} />
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })
                  ))}
                </ScrollView>
              ) : (
                <View style={styles.singleRow} testID={`${testID}-empty`}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowTitle}>
                      {fallbackVariantLabel ?? 'Market price'}
                    </Text>
                    <Text style={styles.rowSubtitle}>
                      {hasError
                        ? 'Could not load detailed pricing.'
                        : 'Detailed pricing unavailable.'}
                    </Text>
                  </View>
                  <Text style={styles.rowPrice}>
                    {isFinitePrice(fallbackMarketPrice)
                      ? formatCurrency(fallbackMarketPrice, currencyCode)
                      : '—'}
                  </Text>
                </View>
              )}

              <View style={styles.footer}>
                {mode === 'slabs' ? (
                  onOpenEbayLink ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="View on eBay sold listings"
                      disabled={ebayLinkLoading}
                      onPress={onOpenEbayLink}
                      style={({ pressed }) => [
                        styles.linkRow,
                        pressed ? styles.linkRowPressed : null,
                        ebayLinkAvailable === false ? styles.linkRowDisabled : null,
                      ]}
                      testID={`${testID}-ebay-link`}
                    >
                      {ebayLinkLoading ? (
                        <ActivityIndicator color={theme.colors.brand} size="small" />
                      ) : (
                        <Image
                          source={require('../../../../assets/images/ebay-icon.png')}
                          style={styles.linkIcon}
                        />
                      )}
                      <Text style={styles.linkLabel}>View on eBay sold listings</Text>
                    </Pressable>
                  ) : null
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="View on TCGplayer"
                    disabled={!tcgPlayerUrl}
                    onPress={() => {
                      if (tcgPlayerUrl) {
                        void Linking.openURL(tcgPlayerUrl);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.linkRow,
                      pressed ? styles.linkRowPressed : null,
                      !tcgPlayerUrl ? styles.linkRowDisabled : null,
                    ]}
                    testID={`${testID}-tcgplayer-link`}
                  >
                    <Image
                      source={require('../../../../assets/images/tcgplayer-icon.png')}
                      style={styles.linkIcon}
                    />
                    <Text style={styles.linkLabel}>View on TCGplayer</Text>
                  </Pressable>
                )}

                <Text style={styles.disclaimer}>{disclaimer}</Text>
              </View>
            </View>
          </SurfaceCard>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 15, 18, 0.5)',
  },
  body: {
    gap: 14,
    marginTop: 14,
  },
  closeGlyph: {
    lineHeight: 20,
  },
  disclaimer: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  footer: {
    gap: 10,
    marginTop: 4,
  },
  linkIcon: {
    height: 18,
    resizeMode: 'contain',
    width: 18,
  },
  linkLabel: {
    ...textStyles.control,
    color: colors.textPrimary,
  },
  linkRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
  },
  linkRowDisabled: {
    opacity: 0.5,
  },
  linkRowPressed: {
    opacity: 0.7,
  },
  list: {
    gap: 6,
  },
  loadingState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
  },
  rowPressed: {
    opacity: 0.78,
  },
  rowPrice: {
    ...textStyles.headline,
    color: colors.textPrimary,
  },
  rowSelected: {
    backgroundColor: 'rgba(30, 144, 255, 0.10)',
  },
  rowSubtitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  rowTitle: {
    ...textStyles.bodyStrong,
    color: colors.textPrimary,
  },
  rowTrailing: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  sheet: {
    marginBottom: 16,
    marginHorizontal: 16,
  },
  sheetWrap: {
    justifyContent: 'flex-end',
  },
  singleRow: {
    alignItems: 'center',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
});
