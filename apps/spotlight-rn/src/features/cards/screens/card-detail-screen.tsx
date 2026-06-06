import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  deckConditionOptions,
  graderOptions,
  type CardDetailRecord,
  type CardPriceTrendList as CardPriceTrendListRecord,
  type DeckConditionCode,
  type MarketHistoryOption,
  type SlabContext,
} from '@spotlight/api-client';
import { Button, IconButton, colors, useSpotlightTheme } from '@spotlight/design-system';
import { NavArrowLeft, ShareIos } from 'iconoir-react-native';

import { CardConfigurator } from '@/features/cards/components/card-configurator';
import { CardDetailHero } from '@/features/cards/components/card-detail-hero';
import { CardPriceTrendList } from '@/features/cards/components/card-price-trend-list';
import { CardProductDetails } from '@/features/cards/components/card-product-details';
import { buildTcgPlayerSearchUrl } from '@/features/cards/marketplace-urls';
import {
  cardDetailPreviewFromCatalogResult,
  cardDetailPreviewFromInventoryEntry,
  getCardDetailPreview,
} from '@/features/cards/card-detail-preview-session';
import {
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

function displayNumber(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '#--';
  }

  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

// Numeric grade scale shared by PSA/BGS/CGC slab grading lanes.
const numericGradeOptions: readonly string[] = [
  '10',
  '9.5',
  '9',
  '8.5',
  '8',
  '7.5',
  '7',
  '6.5',
  '6',
  '5.5',
  '5',
  '4.5',
  '4',
  '3.5',
  '3',
  '2.5',
  '2',
  '1.5',
  '1',
] as const;

type DropdownOption = {
  id: string;
  label: string;
};

type CardDetailScreenProps = {
  cardId: string;
  entryId?: string;
  onBack: () => void;
  onOpenAddToCollection: (cardId: string, entryId?: string) => void;
  /** Opens the log-transaction flow (photo + bought/sold/traded) for this card. */
  onOpenTransaction?: (cardLabel: string) => void;
  previewId?: string;
  scanReviewId?: string;
};

function deckConditionLabel(code: string | null): string | null {
  if (!code) {
    return null;
  }
  return deckConditionOptions.find((option) => option.code === code)?.label ?? null;
}

export function CardDetailScreen({
  cardId,
  entryId,
  onBack,
  onOpenAddToCollection,
  onOpenTransaction,
  previewId,
  scanReviewId,
}: CardDetailScreenProps) {
  const theme = useSpotlightTheme();
  const {
    spotlightRepository,
    dataVersion,
    refreshData,
    inventoryEntriesCache,
    portfolioDashboardCache,
  } = useAppServices();
  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const [favoriteState, setFavoriteState] = useState<{ isFavorite: boolean; favoritedAt: string | null }>({
    favoritedAt: null,
    isFavorite: false,
  });
  // Configurator local state.
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [selectedGrader, setSelectedGrader] = useState<string | null>(null);
  const [selectedGrade, setSelectedGrade] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<DeckConditionCode | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [isAddPending, setIsAddPending] = useState(false);

  const [priceTrends, setPriceTrends] = useState<CardPriceTrendListRecord | null>(null);

  const scanReviewSession = useMemo(
    () => getScanCandidateReviewSession(scanReviewId),
    [scanReviewId],
  );
  const scanPreviewCandidate = useMemo(() => {
    return scanReviewSession?.candidates.find((candidate) => candidate.cardId === cardId) ?? null;
  }, [cardId, scanReviewSession]);
  const scanDetailPreview = useMemo(() => {
    return scanPreviewCandidate ? cardDetailPreviewFromCatalogResult(scanPreviewCandidate) : null;
  }, [scanPreviewCandidate]);
  const savedDetailPreview = useMemo(() => {
    const preview = getCardDetailPreview(previewId);
    return preview?.cardId === cardId ? preview : null;
  }, [cardId, previewId]);
  const dashboardDetailPreview = useMemo(() => {
    const inventoryEntry = (inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems)?.find((entry) => (
      entryId ? entry.id === entryId : entry.cardId === cardId
    ));

    return inventoryEntry ? cardDetailPreviewFromInventoryEntry(inventoryEntry) : null;
  }, [cardId, entryId, inventoryEntriesCache, portfolioDashboardCache]);
  const detailPreview = scanDetailPreview ?? savedDetailPreview ?? dashboardDetailPreview;

  useEffect(() => {
    let cancelled = false;
    setDetail((currentDetail) => (currentDetail?.cardId === cardId ? currentDetail : null));
    setErrorMessage(null);

    void spotlightRepository.getCardDetail({ cardId })
      .then((nextDetail) => {
        if (cancelled) {
          return;
        }

        if (!nextDetail) {
          setDetail(null);
          setErrorMessage('We could not find this card in the local catalog.');
          return;
        }

        setDetail(nextDetail);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setErrorMessage('Could not load this card right now.');
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, spotlightRepository]);

  useEffect(() => {
    setFavoriteState({ favoritedAt: null, isFavorite: false });
    setSelectedVariant(null);
    setSelectedGrader(null);
    setSelectedGrade(null);
    setSelectedCondition(null);
    setQuantity(1);
    setPriceTrends(null);
    seededCardIdRef.current = null;
  }, [cardId]);

  useEffect(() => {
    if (!detail) {
      return;
    }
    setFavoriteState({
      favoritedAt: detail.favoritedAt ?? null,
      isFavorite: detail.isFavorite ?? false,
    });
  }, [detail]);

  const selectedEntry = useMemo(() => {
    if (!detail) {
      const previewEntry = detailPreview?.ownedEntry ?? null;
      if (!previewEntry) {
        return null;
      }

      return !entryId || previewEntry.id === entryId ? previewEntry : null;
    }

    return detail.ownedEntries.find((entry) => entry.id === entryId) ?? detail.ownedEntries[0] ?? null;
  }, [detail, detailPreview?.ownedEntry, entryId]);

  const ownedSlabContext = selectedEntry?.slabContext ?? scanReviewSession?.slabContext ?? null;

  // Variant options for the configurator: prefer catalog variantOptions, fall
  // back to the market-history available variants.
  const variantOptions = useMemo<MarketHistoryOption[]>(() => {
    const fromDetail = detail?.variantOptions ?? [];
    if (fromDetail.length > 0) {
      return fromDetail;
    }
    return detail?.marketHistory?.availableVariants ?? [];
  }, [detail?.marketHistory?.availableVariants, detail?.variantOptions]);

  // Seed configurator defaults exactly once per card, after a source (full
  // detail or an owned-entry preview) has resolved — so the grader/grade lens
  // matches an owned slab instead of latching to the empty-state Raw default.
  const seededCardIdRef = useRef<string | null>(null);
  useEffect(() => {
    const hasSource = detail != null || selectedEntry != null || ownedSlabContext != null;
    if (!hasSource || seededCardIdRef.current === cardId) {
      return;
    }
    seededCardIdRef.current = cardId;

    const ownedVariant = selectedEntry?.kind === 'raw' ? selectedEntry.variantName?.trim() : null;
    const variantMatch = ownedVariant
      ? variantOptions.find((option) => option.label.toLowerCase() === ownedVariant.toLowerCase())
      : null;
    setSelectedVariant(variantMatch?.id ?? variantOptions[0]?.id ?? null);

    if (ownedSlabContext?.grader) {
      const graderMatch = graderOptions.find(
        (option) => option.toLowerCase() === ownedSlabContext.grader.toLowerCase(),
      );
      setSelectedGrader(graderMatch ?? 'PSA');
      setSelectedGrade(ownedSlabContext.grade ?? '10');
    } else {
      setSelectedGrader('Raw');
      const ownedCondition = selectedEntry?.kind === 'raw' ? selectedEntry.conditionCode ?? null : null;
      setSelectedCondition(ownedCondition ?? deckConditionOptions[0]?.code ?? null);
    }
  }, [cardId, detail, ownedSlabContext, selectedEntry, variantOptions]);

  // Reset the per-lane selection whenever the grader switches so the grade
  // label always reflects the active lane.
  const handleSelectGrader = useCallback((grader: string) => {
    setSelectedGrader(grader);
    if (grader === 'Raw') {
      setSelectedCondition((current) => current ?? deckConditionOptions[0]?.code ?? null);
    } else {
      setSelectedGrade((current) => current ?? ownedSlabContext?.grade ?? '10');
    }
  }, [ownedSlabContext]);

  const isRawLane = selectedGrader == null || selectedGrader === 'Raw';

  // Resolve the active variant label (configurator uses option ids).
  const selectedVariantLabel = useMemo(() => {
    if (!selectedVariant) {
      return null;
    }
    return variantOptions.find((option) => option.id === selectedVariant)?.label ?? null;
  }, [selectedVariant, variantOptions]);

  // Fetch price trends on mount and whenever the grader/variant lens changes.
  useEffect(() => {
    if (!detail || selectedGrader == null) {
      return;
    }
    let cancelled = false;
    const mode = isRawLane ? 'raw' : 'graded';
    void spotlightRepository.getCardPriceTrends({
      cardId,
      mode,
      variant: isRawLane ? (selectedVariantLabel ?? null) : null,
      grader: isRawLane ? null : selectedGrader,
    })
      .then((next) => {
        if (!cancelled) {
          setPriceTrends(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPriceTrends(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, detail, isRawLane, selectedGrader, selectedVariantLabel, spotlightRepository]);

  const handleToggleFavorite = useCallback(() => {
    if (isFavoritePending) {
      return;
    }

    const previousFavoriteState = favoriteState;
    const nextIsFavorite = !favoriteState.isFavorite;
    setFavoriteState((current) => ({ ...current, isFavorite: nextIsFavorite }));
    setIsFavoritePending(true);

    void spotlightRepository.setCardFavorite(cardId, nextIsFavorite)
      .then((result) => {
        setFavoriteState({
          favoritedAt: result.favoritedAt ?? null,
          isFavorite: result.isFavorite,
        });
        setIsFavoritePending(false);
      })
      .catch(() => {
        setFavoriteState(previousFavoriteState);
        setErrorMessage('Could not update favorite right now.');
        setIsFavoritePending(false);
      });
  }, [cardId, favoriteState, isFavoritePending, spotlightRepository]);

  const hasDisplayContent = detail != null || detailPreview != null;

  const displayName = detail?.name ?? detailPreview?.name ?? '';
  const displayImageUrl = detail?.largeImageUrl
    ?? detail?.imageUrl
    ?? detailPreview?.largeImageUrl
    ?? detailPreview?.imageUrl
    ?? null;
  const displayCardNumber = detail?.cardNumber ?? detailPreview?.cardNumber ?? '';
  const displaySetName = detail?.setName ?? detailPreview?.setName ?? '';

  // Carried into the log-transaction flow as the note so a bought/sold/traded
  // entry started from this card keeps its identity.
  const transactionLabel = [displayName, displayCardNumber, displaySetName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ');

  const marketplaceUrl = useMemo(() => buildTcgPlayerSearchUrl({
    cardNumber: displayCardNumber,
    name: displayName,
    setName: displaySetName,
    condition: deckConditionLabel(selectedCondition),
    printing: selectedVariantLabel,
  }), [displayCardNumber, displayName, displaySetName, selectedCondition, selectedVariantLabel]);

  const handleShare = useCallback(() => {
    const message = [transactionLabel, marketplaceUrl].filter(Boolean).join('\n');
    if (!message) {
      return;
    }
    void Share.share(
      marketplaceUrl
        ? { message, url: marketplaceUrl }
        : { message },
    ).catch(() => undefined);
  }, [marketplaceUrl, transactionLabel]);

  const handleSellNow = useCallback(() => {
    onOpenTransaction?.(transactionLabel);
  }, [onOpenTransaction, transactionLabel]);

  // Builds the slab context for the configured ADD ITEM action.
  const configuredSlabContext = useMemo<SlabContext | null>(() => {
    if (isRawLane || !selectedGrader) {
      return null;
    }
    return {
      grader: selectedGrader,
      grade: selectedGrade,
      certNumber: null,
      variantName: selectedGrade ? `${selectedGrader} ${selectedGrade}` : null,
    };
  }, [isRawLane, selectedGrade, selectedGrader]);

  const handleAddItem = useCallback(() => {
    if (isAddPending || !detail) {
      // Fall back to the dedicated sheet when detail hasn't resolved yet.
      onOpenAddToCollection(detail?.cardId ?? cardId, undefined);
      return;
    }
    setIsAddPending(true);
    void spotlightRepository.createInventoryEntry({
      cardID: detail.cardId,
      slabContext: configuredSlabContext,
      variantName: isRawLane ? (selectedVariantLabel ?? null) : null,
      condition: isRawLane ? selectedCondition : null,
      quantity: Math.max(1, quantity),
      sourceScanID: null,
      addedAt: new Date().toISOString(),
    })
      .then(() => {
        capturePostHogEvent('card_detail_add_item_succeeded', {
          kind: isRawLane ? 'raw' : 'graded',
          quantity: Math.max(1, quantity),
        });
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not add this card right now.');
      })
      .finally(() => {
        setIsAddPending(false);
      });
  }, [
    cardId,
    configuredSlabContext,
    detail,
    isAddPending,
    isRawLane,
    onOpenAddToCollection,
    quantity,
    refreshData,
    selectedCondition,
    selectedVariantLabel,
    spotlightRepository,
  ]);

  // Grade/Condition dropdown wiring for the configurator.
  const gradeTitle = isRawLane ? 'Condition' : 'Grade';
  const gradeLabel = isRawLane
    ? deckConditionLabel(selectedCondition)
    : (selectedGrade ? `${selectedGrader} ${selectedGrade}` : null);
  const gradePickerOptions = useMemo<DropdownOption[]>(() => {
    if (isRawLane) {
      return deckConditionOptions.map((option) => ({ id: option.code, label: option.label }));
    }
    return numericGradeOptions.map((grade) => ({ id: grade, label: `${selectedGrader} ${grade}` }));
  }, [isRawLane, selectedGrader]);
  const gradePickerSelectedId = isRawLane ? selectedCondition : selectedGrade;
  const handleGradePick = useCallback((id: string) => {
    if (isRawLane) {
      setSelectedCondition(id as DeckConditionCode);
    } else {
      setSelectedGrade(id);
    }
  }, [isRawLane]);

  const isFavorite = favoriteState.isFavorite;

  if (!hasDisplayContent && !errorMessage) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading card...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasDisplayContent) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Card unavailable</Text>
          <Text style={[theme.typography.body, styles.errorCopy]}>{errorMessage}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <IconButton
            accessibilityLabel="Go back"
            onPress={onBack}
            shape="circle"
            size={36}
            testID="detail-back"
            variant="subtle"
          >
            <NavArrowLeft color={theme.colors.gray900} height={22} width={22} />
          </IconButton>
          <Text
            numberOfLines={1}
            style={[theme.typography.title, styles.headerTitle]}
            testID="detail-header-title"
          >
            {displayName}
          </Text>
          <IconButton
            accessibilityLabel="Share this card"
            onPress={handleShare}
            shape="circle"
            size={36}
            testID="detail-share"
            variant="subtle"
          >
            <ShareIos color={theme.colors.gray900} height={20} width={20} />
          </IconButton>
        </View>

        <CardDetailHero
          imageUrl={displayImageUrl}
          isFavorite={isFavorite}
          name={displayName}
          onToggleFavorite={handleToggleFavorite}
          testID="detail-hero-card"
        />

        <View style={styles.identityBlock} testID="detail-identity">
          <Text style={theme.typography.titleLarge} testID="detail-name">
            {displayName}
          </Text>
          <Text style={[theme.typography.bodyMedium, styles.identityMeta]}>
            {displayNumber(displayCardNumber)}
          </Text>
          <Text style={[theme.typography.bodyMedium, styles.identityMeta]}>
            {displaySetName}
          </Text>
        </View>

        <View style={styles.actionRow}>
          <Button
            disabled={!onOpenTransaction}
            label="SELL NOW"
            labelStyleVariant="label"
            onPress={handleSellNow}
            shape="rounded"
            size="md"
            style={styles.actionButton}
            testID="detail-sell-now"
            variant="outline"
          />
          <Button
            disabled={isAddPending}
            label="ADD ITEM"
            labelStyleVariant="label"
            onPress={handleAddItem}
            shape="rounded"
            size="md"
            style={styles.actionButton}
            testID="detail-add-item"
            variant="accent"
          />
        </View>

        <CardConfigurator
          gradeLabel={gradeLabel}
          gradeOptions={gradePickerOptions}
          gradeSelectedId={gradePickerSelectedId}
          gradeTitle={gradeTitle}
          graders={[...graderOptions]}
          onDecrement={() => setQuantity((current) => Math.max(1, current - 1))}
          onIncrement={() => setQuantity((current) => current + 1)}
          onSelectGrade={handleGradePick}
          onSelectGrader={handleSelectGrader}
          onSelectVariant={setSelectedVariant}
          quantity={quantity}
          selectedGrader={selectedGrader}
          selectedVariant={selectedVariant}
          testID="detail-configurator"
          variants={variantOptions}
        />

        {priceTrends && priceTrends.rows.length > 0 ? (
          <View style={styles.trendBlock}>
            {variantOptions.length > 1 ? (
              <ScrollView
                contentContainerStyle={styles.variantSelectorRow}
                horizontal
                showsHorizontalScrollIndicator={false}
                testID="detail-variant-selector"
              >
                {variantOptions.map((option) => {
                  const selected = option.id === selectedVariant;
                  return (
                    <Pressable
                      key={option.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setSelectedVariant(option.id)}
                      style={({ pressed }) => [
                        styles.variantChip,
                        {
                          borderRadius: theme.radii.sm,
                          backgroundColor: selected ? theme.colors.gray900 : theme.colors.gray50,
                          borderColor: selected ? theme.colors.gray900 : theme.colors.gray50,
                          opacity: pressed ? 0.88 : 1,
                        },
                      ]}
                      testID={`detail-variant-chip-${option.id}`}
                    >
                      <Text
                        style={[
                          theme.typography.label,
                          { color: selected ? theme.colors.gray0 : theme.colors.gray900 },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
            <CardPriceTrendList list={priceTrends} testID="detail-price-trends" />
          </View>
        ) : null}

        {detail?.cardText ? (
          <CardProductDetails cardText={detail.cardText} testID="detail-product-details" />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  content: {
    gap: 16,
    paddingBottom: 120,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  errorCopy: {
    marginTop: 8,
    textAlign: 'center',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
  identityBlock: {
    gap: 4,
  },
  identityMeta: {
    color: colors.gray600,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  safeArea: {
    flex: 1,
  },
  trendBlock: {
    gap: 10,
    width: '100%',
  },
  variantChip: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  variantSelectorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
});
