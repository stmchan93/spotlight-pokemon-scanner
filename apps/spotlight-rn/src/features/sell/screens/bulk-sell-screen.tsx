import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  findNodeHandle,
  Image,
  Keyboard,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { Button, SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton, chromeBackButtonSize } from '@/components/chrome-back-button';
import { makeBulkSellSmokeTestID } from '@/features/inventory/inventory-smoke-selectors';
import { formatCurrency, formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  buildBulkSellPayloads,
  buildBulkSellStatusCopy,
  buildInitialBulkSellLines,
  getBulkSellLineMetrics,
  summarizeBulkSellSelection,
  validateBulkSellSubmission,
  type BulkSellLineState,
} from '@/features/sell/sell-batch-helpers';
import {
  canStartSellSwipeGesture,
  formatEditableSellPrice,
  formatSellOrderBoughtPriceLabel,
  getSellSwipeArmThresholdRatio,
  getResistedSellSwipeTranslation,
  getSellSwipeConfirmThreshold,
  isSellSwipeReleaseArmed,
  parseSellPrice,
  scheduleSellStatusCompletion,
  sellOrderProcessingMinimumDurationMs,
  sellOrderSwipeRailHeight,
} from '@/features/sell/sell-order-helpers';
import {
  SellBackdrop,
  SellFormFields,
  SellIdentityChips,
  SellStatusOverlay,
  SellSwipeConfirmationSheet,
  triggerSellHaptic,
} from '@/features/sell/components/sell-ui';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

type BulkSellScreenProps = {
  entryIds: string[];
  onClose: () => void;
  onComplete: () => void;
};

function TopChrome({
  onClose,
}: {
  onClose: () => void;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.topChrome} testID="bulk-sell-top-chrome">
      <ChromeBackButton
        onPress={onClose}
        style={styles.closeButton}
        testID="bulk-sell-close"
      />

      <Text style={[theme.typography.headline, styles.topChromeTitle]}>Sell order</Text>

      <View style={styles.closeButtonSpacer} />
    </View>
  );
}

function patchEntryCostBasis(
  entry: InventoryCardEntry,
  nextBoughtPrice: number,
  nextEntryId = entry.id,
): InventoryCardEntry {
  return {
    ...entry,
    id: nextEntryId,
    costBasisPerUnit: nextBoughtPrice,
    costBasisTotal: Number((nextBoughtPrice * entry.quantity).toFixed(2)),
  };
}

function LineCard({
  entry,
  line,
  onChangeLine,
  onEntryPatched,
  onScrollBoughtPriceInputIntoView,
  showsSellPriceValidation,
}: {
  entry: InventoryCardEntry;
  line: BulkSellLineState;
  onChangeLine: (nextLine: BulkSellLineState) => void;
  onEntryPatched: (nextEntry: InventoryCardEntry) => void;
  onScrollBoughtPriceInputIntoView: (inputRef: { current: TextInput | null }) => void;
  showsSellPriceValidation: boolean;
}) {
  const theme = useSpotlightTheme();
  const { refreshData, spotlightRepository } = useAppServices();
  const metrics = getBulkSellLineMetrics(entry, line);
  const boughtPriceText = formatSellOrderBoughtPriceLabel(
    entry.costBasisPerUnit,
    formatCurrency(entry.costBasisPerUnit ?? 0, entry.currencyCode),
    line.revealsBoughtPrice,
  );
  const [isBoughtPriceEditorVisible, setIsBoughtPriceEditorVisible] = useState(false);
  const [boughtPriceDraftText, setBoughtPriceDraftText] = useState(
    entry.costBasisPerUnit != null ? formatEditableSellPrice(entry.costBasisPerUnit) : '',
  );
  const [boughtPriceErrorMessage, setBoughtPriceErrorMessage] = useState<string | null>(null);
  const [isSavingBoughtPrice, setIsSavingBoughtPrice] = useState(false);
  const boughtPriceInputRef = useRef<TextInput | null>(null);
  const focusScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (focusScrollTimerRef.current) {
      clearTimeout(focusScrollTimerRef.current);
    }
  }, []);

  const saveBoughtPrice = useCallback(() => {
    const parsedBoughtPrice = parseSellPrice(boughtPriceDraftText);
    if (parsedBoughtPrice == null) {
      setBoughtPriceErrorMessage('Enter a valid bought price before saving.');
      return;
    }

    setIsSavingBoughtPrice(true);
    setBoughtPriceErrorMessage(null);

    void spotlightRepository.replacePortfolioEntry({
      deckEntryID: entry.id,
      cardID: entry.cardId,
      slabContext: entry.slabContext ?? null,
      variantName: entry.variantName ?? null,
      condition: entry.kind === 'raw' ? entry.conditionCode ?? null : null,
      quantity: entry.quantity,
      unitPrice: parsedBoughtPrice,
      currencyCode: entry.currencyCode,
      updatedAt: new Date().toISOString(),
    }).then((response) => {
      const nextEntry = patchEntryCostBasis(
        entry,
        parsedBoughtPrice,
        response.deckEntryID || entry.id,
      );
      onEntryPatched(nextEntry);
      setBoughtPriceDraftText(formatEditableSellPrice(parsedBoughtPrice));
      setIsBoughtPriceEditorVisible(false);
      setIsSavingBoughtPrice(false);
      refreshData();
    }).catch((error: unknown) => {
      setIsSavingBoughtPrice(false);
      setBoughtPriceErrorMessage(error instanceof Error ? error.message : 'Could not update the bought price.');
    });
  }, [boughtPriceDraftText, entry, onEntryPatched, refreshData, spotlightRepository]);

  return (
    <View testID={`bulk-sell-line-${entry.id}`}>
      <View testID={makeBulkSellSmokeTestID('bulk-sell-line', entry)}>
        <SurfaceCard padding={18} radius={32} style={[styles.lineCard, !metrics.isActive && styles.inactiveLine]}>
          <View style={styles.lineHeaderSection}>
            <View style={styles.lineHeader}>
              <Image source={{ uri: entry.imageUrl }} style={styles.lineArt} />

              <View style={styles.lineCopy}>
                <Text numberOfLines={2} style={[theme.typography.title, styles.lineTitle]}>
                  {entry.name}
                </Text>
                <Text numberOfLines={1} style={[theme.typography.caption, styles.lineSubtitle]}>
                  {entry.setName}
                  {' • '}
                  {entry.cardNumber}
                </Text>
                <SellIdentityChips entry={entry} testIDPrefix={`bulk-sell-${entry.id}`} />
              </View>

              {!metrics.isActive ? (
                <View style={styles.notIncludedBadge}>
                  <Text style={[theme.typography.caption, styles.notIncludedText]}>Not included</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.divider} />
          </View>

          <SellFormFields
            boughtPriceEditorErrorMessage={boughtPriceErrorMessage}
            boughtPriceEditorText={boughtPriceDraftText}
            boughtPriceEditorVisible={isBoughtPriceEditorVisible}
            boughtPriceInputRef={boughtPriceInputRef}
            boughtPriceInputTestID={`bulk-sell-${entry.id}-bought-price-input`}
            boughtPriceLabel={boughtPriceText}
            boughtPriceSaveDisabled={isSavingBoughtPrice}
            boughtPriceToggleDisabled={entry.costBasisPerUnit == null}
            decrementDisabled={metrics.quantity <= 0}
            incrementDisabled={metrics.quantity >= Math.max(0, entry.quantity)}
            marketPriceLabel={formatOptionalCurrency(
              entry.hasMarketPrice ? entry.marketPrice : null,
              entry.currencyCode,
            )}
            onBoughtPriceChangeText={(value) => {
              setBoughtPriceDraftText(value);
              setBoughtPriceErrorMessage(null);
            }}
            onBoughtPriceInputFocus={() => {
              onScrollBoughtPriceInputIntoView(boughtPriceInputRef);
            }}
            onCancelBoughtPriceEdit={() => {
              setBoughtPriceDraftText(
                entry.costBasisPerUnit != null ? formatEditableSellPrice(entry.costBasisPerUnit) : '',
              );
              setBoughtPriceErrorMessage(null);
              setIsSavingBoughtPrice(false);
              setIsBoughtPriceEditorVisible(false);
            }}
            onDecrement={() => onChangeLine({ ...line, quantity: Math.max(0, line.quantity - 1) })}
            onEditBoughtPrice={() => {
              setBoughtPriceDraftText(
                entry.costBasisPerUnit != null ? formatEditableSellPrice(entry.costBasisPerUnit) : '',
              );
              setBoughtPriceErrorMessage(null);
              setIsSavingBoughtPrice(false);
              setIsBoughtPriceEditorVisible(true);
              if (process.env.NODE_ENV === 'test') {
                boughtPriceInputRef.current?.focus();
                return;
              }

              if (focusScrollTimerRef.current) {
                clearTimeout(focusScrollTimerRef.current);
              }
              focusScrollTimerRef.current = setTimeout(() => {
                boughtPriceInputRef.current?.focus();
                onScrollBoughtPriceInputIntoView(boughtPriceInputRef);
              }, 80);
            }}
            onIncrement={() => onChangeLine({ ...line, quantity: Math.min(entry.quantity, line.quantity + 1) })}
            onSaveBoughtPrice={saveBoughtPrice}
            onSoldPriceChangeText={(value) => onChangeLine({ ...line, soldPriceText: value })}
            onToggleBoughtPrice={() => onChangeLine({ ...line, revealsBoughtPrice: !line.revealsBoughtPrice })}
            quantity={metrics.quantity}
            revealsBoughtPrice={line.revealsBoughtPrice}
            soldPriceErrorMessage={showsSellPriceValidation ? 'Enter a sell price before continuing.' : null}
            soldPriceTestID={makeBulkSellSmokeTestID('bulk-sell-sold-price', entry)}
            soldPriceText={line.soldPriceText}
            stepperTestIDs={{
              decrement: makeBulkSellSmokeTestID('bulk-sell-decrement', entry),
              increment: makeBulkSellSmokeTestID('bulk-sell-increment', entry),
            }}
            testIDPrefix={`bulk-sell-${entry.id}`}
            toggleBoughtPriceTestID={makeBulkSellSmokeTestID('bulk-sell-toggle-bought-price', entry)}
          />
        </SurfaceCard>
      </View>
    </View>
  );
}

function ReviewLineCard({
  entry,
  line,
}: {
  entry: InventoryCardEntry;
  line: BulkSellLineState;
}) {
  const theme = useSpotlightTheme();
  const metrics = getBulkSellLineMetrics(entry, line);
  const soldPriceLabel = metrics.soldPrice == null
    ? 'Not set'
    : formatCurrency(metrics.soldPrice, entry.currencyCode);

  return (
    <SurfaceCard
      padding={18}
      radius={28}
      style={styles.reviewLineCard}
      testID={`bulk-sell-review-line-${entry.id}`}
    >
      <View style={styles.reviewLineHeader}>
        <Image source={{ uri: entry.imageUrl }} style={styles.reviewLineArt} />

        <View style={styles.reviewLineCopy}>
          <Text numberOfLines={2} style={[theme.typography.title, styles.lineTitle]}>
            {entry.name}
          </Text>
          <Text numberOfLines={1} style={[theme.typography.caption, styles.lineSubtitle]}>
            {entry.setName}
            {' • '}
            {entry.cardNumber}
          </Text>
          <SellIdentityChips entry={entry} testIDPrefix={`bulk-review-${entry.id}`} />
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.reviewMetricRow}>
        <Text style={[theme.typography.caption, styles.reviewMetricLabel]}>Quantity</Text>
        <Text style={[theme.typography.bodyStrong, styles.reviewMetricValue]}>{metrics.quantity}</Text>
      </View>

      <View style={styles.reviewMetricRow}>
        <Text style={[theme.typography.caption, styles.reviewMetricLabel]}>Sold price</Text>
        <Text style={[theme.typography.bodyStrong, styles.reviewMetricValue]}>{soldPriceLabel}</Text>
      </View>
    </SurfaceCard>
  );
}

export function BulkSellScreen({
  entryIds,
  onClose,
  onComplete,
}: BulkSellScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { refreshData, spotlightRepository } = useAppServices();

  const [entries, setEntries] = useState<InventoryCardEntry[]>([]);
  const [lines, setLines] = useState<Record<string, BulkSellLineState>>({});
  const [screenErrorMessage, setScreenErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitState, setSubmitState] = useState<'idle' | 'processing' | 'success'>('idle');
  const [releaseToConfirmArmed, setReleaseToConfirmArmed] = useState(false);
  const [stage, setStage] = useState<'draft' | 'review'>('draft');
  const [showsValidation, setShowsValidation] = useState(false);

  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const hasInitializedSheetRef = useRef(false);
  const closedSheetOffsetRef = useRef(0);
  const releaseToConfirmArmedRef = useRef(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const sheetOffset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (focusScrollTimerRef.current) {
        clearTimeout(focusScrollTimerRef.current);
      }
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    void spotlightRepository.getInventoryEntries()
      .then((inventory) => {
        if (cancelled) {
          return;
        }

        const selectedEntries = inventory.filter((entry) => entryIds.includes(entry.id));
        setEntries(selectedEntries);
        setLines(buildInitialBulkSellLines(selectedEntries));
        setScreenErrorMessage(selectedEntries.length === 0 ? 'No inventory cards were selected for this sale.' : null);
        setSubmitState('idle');
        setReleaseToConfirmArmed(false);
        setStage('draft');
        setShowsValidation(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setEntries([]);
        setLines({});
        setScreenErrorMessage('Could not load these cards right now.');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
    };
  }, [entryIds, spotlightRepository]);

  const summary = useMemo(() => summarizeBulkSellSelection(entries, lines), [entries, lines]);
  const statusCopy = useMemo(() => buildBulkSellStatusCopy(
    submitState === 'success' ? 'success' : 'processing',
    summary,
  ), [submitState, summary]);

  const containerHeight = Math.max(0, windowHeight - insets.top - insets.bottom);
  const closedSheetOffset = Math.max(0, containerHeight - sellOrderSwipeRailHeight);
  const swipeSheetHeight = containerHeight + insets.bottom;
  const submitThreshold = getSellSwipeConfirmThreshold(containerHeight);
  const releaseArmThresholdRatio = getSellSwipeArmThresholdRatio(containerHeight, closedSheetOffset);
  const canInteract = submitState === 'idle';

  const selectedCountLabel =
    summary.totalSelectedQuantity === 1 ? '1 card selected' : `${summary.totalSelectedQuantity} cards selected`;
  const validationMessage = buildStageValidationMessage(stage, summary.totalSelectedQuantity, summary.hasMissingActiveSoldPrice);
  const canReview = canInteract && summary.totalSelectedQuantity > 0 && !summary.hasMissingActiveSoldPrice;
  const visibleMessage = screenErrorMessage ?? (showsValidation ? validationMessage : null);
  const reviewEntries = stage === 'review' ? summary.activeEntries : entries;
  const confirmationProgress = useMemo(() => sheetOffset.interpolate({
    inputRange: [0, Math.max(1, closedSheetOffset)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  }), [closedSheetOffset, sheetOffset]);

  const confirmationPromptOpacity = useMemo(() => confirmationProgress.interpolate({
    inputRange: [0, 0.73, 1],
    outputRange: [1, 0.16, 0.16],
    extrapolate: 'clamp',
  }), [confirmationProgress]);

  const confirmationPromptScale = useMemo(() => confirmationProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.9],
    extrapolate: 'clamp',
  }), [confirmationProgress]);

  const prompt = releaseToConfirmArmed
    ? 'Release to confirm sale'
    : 'Swipe up to confirm sale';
  const railIsDisabled = !canInteract;
  const railUsesDisabledVisual = false;

  const syncReleaseToConfirmState = useCallback((nextOffset: number) => {
    const nextState = isSellSwipeReleaseArmed(
      nextOffset,
      closedSheetOffsetRef.current,
      releaseArmThresholdRatio,
    );
    if (nextState === releaseToConfirmArmedRef.current) {
      return;
    }

    if (nextState) {
      void triggerSellHaptic('armed');
    }

    releaseToConfirmArmedRef.current = nextState;
    setReleaseToConfirmArmed(nextState);
  }, [releaseArmThresholdRatio]);

  const setSheetOffsetValue = useCallback((nextOffset: number) => {
    const clampedOffset = Math.min(Math.max(0, nextOffset), closedSheetOffsetRef.current);
    sheetOffset.setValue(clampedOffset);
    syncReleaseToConfirmState(clampedOffset);
  }, [sheetOffset, syncReleaseToConfirmState]);

  const animateSheetToOffset = useCallback((
    nextOffset: number,
    motion: 'open' | 'closed',
  ) => {
    const clampedOffset = Math.min(Math.max(0, nextOffset), closedSheetOffsetRef.current);
    syncReleaseToConfirmState(clampedOffset);
    Animated.spring(sheetOffset, {
      toValue: clampedOffset,
      stiffness: motion === 'open' ? 220 : 260,
      damping: motion === 'open' ? 24 : 30,
      mass: 1,
      overshootClamping: false,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        syncReleaseToConfirmState(clampedOffset);
      }
    });
  }, [sheetOffset, syncReleaseToConfirmState]);

  const beginGestureInteraction = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const scrollInputIntoView = useCallback((inputRef: { current: TextInput | null }) => {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    if (focusScrollTimerRef.current) {
      clearTimeout(focusScrollTimerRef.current);
    }

    focusScrollTimerRef.current = setTimeout(() => {
      const scrollView = scrollViewRef.current as (ScrollView & {
        scrollResponderScrollNativeHandleToKeyboard?: (
          nodeHandle: number,
          additionalOffset?: number,
          preventNegativeScrollOffset?: boolean,
        ) => void;
      }) | null;
      const nodeHandle = findNodeHandle(inputRef.current);
      if (!scrollView || nodeHandle == null) {
        return;
      }

      if (typeof scrollView.scrollResponderScrollNativeHandleToKeyboard === 'function') {
        scrollView.scrollResponderScrollNativeHandleToKeyboard(nodeHandle, 112, true);
      }
    }, 80);
  }, []);

  useEffect(() => {
    closedSheetOffsetRef.current = closedSheetOffset;
    if (!hasInitializedSheetRef.current) {
      hasInitializedSheetRef.current = true;
      setSheetOffsetValue(closedSheetOffset);
      return;
    }

    if (submitState === 'idle') {
      setSheetOffsetValue(closedSheetOffset);
    }
  }, [closedSheetOffset, setSheetOffsetValue, submitState]);

  const updateLine = useCallback((entryId: string, nextLine: BulkSellLineState) => {
    setLines((current) => ({
      ...current,
      [entryId]: nextLine,
    }));
    setShowsValidation(false);
    setScreenErrorMessage(null);
  }, []);

  const patchEntry = useCallback((nextEntry: InventoryCardEntry) => {
    setEntries((current) => current.map((entry) => (
      entry.id === nextEntry.id ? nextEntry : entry
    )));
  }, []);

  const submitSale = useCallback(() => {
    const nextError = validateBulkSellSubmission(entries, lines);
    if (nextError) {
      setShowsValidation(true);
      return;
    }

    setSubmitState('processing');
    setScreenErrorMessage(null);
    const payloads = buildBulkSellPayloads(entries, lines);
    const startedAt = Date.now();

    void spotlightRepository.createPortfolioSalesBatch(payloads)
      .then(() => {
        if (!isMountedRef.current) {
          return;
        }

        capturePostHogEvent('sale_batch_succeeded', {
          item_count: payloads.reduce((sum, payload) => sum + payload.quantity, 0),
        });
        refreshData();
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, sellOrderProcessingMinimumDurationMs - elapsed);

        processingTimerRef.current = scheduleSellStatusCompletion({
          onComplete: () => {
            if (!isMountedRef.current) {
              return;
            }

            onComplete();
          },
          onSuccess: () => {
            if (!isMountedRef.current) {
              return;
            }

            void triggerSellHaptic('success');
            setSubmitState('success');
          },
          processingDurationMs: remaining,
        });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current) {
          return;
        }

        setSubmitState('idle');
        animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
        setScreenErrorMessage(error instanceof Error ? error.message : 'Could not confirm this batch sale.');
      });
  }, [animateSheetToOffset, entries, lines, onComplete, refreshData, spotlightRepository]);

  const openReviewStep = useCallback(() => {
    if (!canReview) {
      setShowsValidation(true);
      return;
    }

    syncReleaseToConfirmState(closedSheetOffsetRef.current);
    animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
    setShowsValidation(false);
    setScreenErrorMessage(null);
    setStage('review');
  }, [animateSheetToOffset, canReview, syncReleaseToConfirmState]);

  const handleAccessibilityConfirm = useCallback(() => {
    if (!canInteract || stage !== 'review') {
      return;
    }

    animateSheetToOffset(0, 'open');
    submitSale();
  }, [animateSheetToOffset, canInteract, stage, submitSale]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      canInteract && stage === 'review' && canStartSellSwipeGesture(gestureState.dx, gestureState.dy)
    ),
    onPanResponderGrant: beginGestureInteraction,
    onPanResponderMove: (_, gestureState) => {
      if (!canInteract || stage !== 'review') {
        return;
      }

      setSheetOffsetValue(closedSheetOffsetRef.current + getResistedSellSwipeTranslation(gestureState.dy));
    },
    onPanResponderRelease: (_, gestureState) => {
      if (!canInteract || stage !== 'review') {
        return;
      }

      const upwardTravel = Math.max(0, -gestureState.dy);
      if (upwardTravel >= submitThreshold) {
        animateSheetToOffset(0, 'open');
        submitSale();
        return;
      }

      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
    },
    onPanResponderTerminate: () => {
      if (!canInteract) {
        return;
      }

      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
    },
  }), [
    animateSheetToOffset,
    beginGestureInteraction,
    canInteract,
    setSheetOffsetValue,
    stage,
    submitSale,
    submitThreshold,
  ]);

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading sell order...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (submitState !== 'idle') {
    return (
      <SafeAreaView
        edges={['top', 'left', 'right', 'bottom']}
        style={[styles.safeArea, { backgroundColor: theme.colors.brand }]}
      >
        <SellStatusOverlay
          detail={statusCopy.detail}
          headline={statusCopy.headline}
          state={submitState}
          testIDPrefix="bulk-sell"
          title={statusCopy.title}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <SellBackdrop imageUrl={entries[0]?.imageUrl} variant="bulk" />

      <View style={styles.viewport}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + sellOrderSwipeRailHeight + 48 },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          <TouchableWithoutFeedback
            accessible={false}
            onPress={() => {
              Keyboard.dismiss();
            }}
          >
            <View>
              <View style={styles.heroSection} testID="bulk-sell-summary-card">
                <TopChrome onClose={onClose} />

                <View style={styles.heroBody}>
                  <Text style={[theme.typography.caption, styles.heroKicker]}>
                    {stage === 'draft' ? 'Draft sale' : 'Review before confirm'}
                  </Text>
                  <Text style={[theme.typography.display, styles.heroValue]}>
                    {formatCurrency(summary.draftGrossTotal || 0, summary.currencyCode)}
                  </Text>
                  <Text style={[theme.typography.caption, styles.heroSelectedCount]}>
                    {selectedCountLabel}
                  </Text>
                  <Text style={[theme.typography.body, styles.heroDetail]}>
                    {stage === 'draft'
                      ? `${selectedCountLabel}. Set sold prices, then review the sale.`
                      : 'Everything looks right. Swipe up below to confirm this batch sale.'}
                  </Text>

                  <View style={styles.stackArt}>
                    {entries.slice(0, 3).map((entry, index) => (
                      <Image
                        key={entry.id}
                        source={{ uri: entry.imageUrl }}
                        style={[
                          styles.stackCard,
                          {
                            left: index === 0 ? 56 : index === 1 ? 8 : 104,
                            top: index === 0 ? 4 : 20,
                            transform: [{ rotate: `${index === 0 ? 0 : index === 1 ? -8 : 8}deg` }],
                          },
                        ]}
                      />
                    ))}
                  </View>

                  {stage === 'review' ? (
                    <Button
                      label="Back to edit"
                      onPress={() => setStage('draft')}
                      size="sm"
                      style={styles.reviewBackButton}
                      testID="bulk-sell-back-to-edit"
                      variant="secondary"
                    />
                  ) : null}
                </View>
              </View>

              {visibleMessage ? (
                <View
                  style={[
                    styles.messageCard,
                    {
                      borderColor: screenErrorMessage ? theme.colors.danger : 'rgba(15, 15, 18, 0.08)',
                    },
                  ]}
                  testID="bulk-sell-message-card"
                >
                  <Text style={[theme.typography.bodyStrong, styles.messageTitle]}>
                    {screenErrorMessage ? 'Action needed' : stage === 'draft' ? 'Finish the draft' : 'Review needs attention'}
                  </Text>
                  <Text style={[theme.typography.body, styles.messageText]}>{visibleMessage}</Text>
                </View>
              ) : null}

              <View style={styles.lineList}>
                {reviewEntries.length === 0 && stage === 'review' ? (
                  <SurfaceCard padding={18} radius={28} style={styles.emptyReviewCard}>
                    <Text style={[theme.typography.bodyStrong, styles.emptyReviewTitle]}>No cards selected</Text>
                    <Text style={[theme.typography.body, styles.emptyReviewText]}>
                      Go back to the draft step and choose at least one card before confirming the batch sale.
                    </Text>
                  </SurfaceCard>
                ) : null}

                {reviewEntries.map((entry) => {
                  const line = lines[entry.id];
                  if (!line) {
                    return null;
                  }

                  const metrics = getBulkSellLineMetrics(entry, line);

                  return (
                    stage === 'review' ? (
                      <ReviewLineCard
                        key={entry.id}
                        entry={entry}
                        line={line}
                      />
                    ) : (
                      <LineCard
                        key={entry.id}
                        entry={entry}
                        line={line}
                        onChangeLine={(nextLine) => updateLine(entry.id, nextLine)}
                        onEntryPatched={patchEntry}
                        onScrollBoughtPriceInputIntoView={scrollInputIntoView}
                        showsSellPriceValidation={
                          showsValidation && metrics.isActive && metrics.soldPrice == null
                        }
                      />
                    )
                  );
                })}

                {stage === 'review' && reviewEntries.length > 0 ? (
                  <SurfaceCard
                    padding={20}
                    radius={28}
                    style={styles.reviewTotalCard}
                    testID="bulk-sell-review-total-card"
                  >
                    <Text style={[theme.typography.caption, styles.reviewTotalLabel]}>Total sale</Text>
                    <Text style={[theme.typography.headline, styles.reviewTotalValue]}>
                      {formatCurrency(summary.draftGrossTotal, summary.currencyCode)}
                    </Text>
                    <Text style={[theme.typography.body, styles.reviewTotalDetail]}>
                      {selectedCountLabel}
                    </Text>
                  </SurfaceCard>
                ) : null}
              </View>
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>

        {stage === 'draft' ? (
          <View pointerEvents="box-none" style={styles.reviewButtonDock}>
            <View style={styles.reviewButtonDockBody}>
              <Button
                disabled={!canReview}
                label="Review sale"
                onPress={openReviewStep}
                size="lg"
                style={styles.reviewButton}
                testID="bulk-sell-review-sale"
              />
            </View>
          </View>
        ) : (
          <SellSwipeConfirmationSheet
            bottomInset={insets.bottom}
            disabled={railIsDisabled}
            onAccessibilityConfirm={handleAccessibilityConfirm}
            panHandlers={panResponder.panHandlers}
            prompt={prompt}
            promptOpacity={confirmationPromptOpacity}
            promptScale={confirmationPromptScale}
            swipeSheetHeight={swipeSheetHeight}
            testIDPrefix="bulk-sell"
            translateY={sheetOffset}
            usesDisabledVisual={railUsesDisabledVisual}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function buildStageValidationMessage(
  stage: 'draft' | 'review',
  totalSelectedQuantity: number,
  hasMissingActiveSoldPrice: boolean,
) {
  if (totalSelectedQuantity === 0) {
    return stage === 'draft'
      ? 'Choose at least one card before reviewing the sale.'
      : 'Choose at least one card before confirming the sale.';
  }

  if (hasMissingActiveSoldPrice) {
    return stage === 'draft'
      ? 'Enter a sell price for every selected card before reviewing the sale.'
      : 'Enter a sell price for every selected card before confirming the sale.';
  }

  return null;
}

const styles = StyleSheet.create({
  closeButton: {
    flexShrink: 0,
  },
  closeButtonSpacer: {
    width: chromeBackButtonSize,
  },
  content: {
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  divider: {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
    height: 1,
  },
  emptyReviewCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
  },
  emptyReviewText: {
    color: '#4D4F57',
  },
  emptyReviewTitle: {
    color: '#0F0F12',
    marginBottom: 6,
  },
  heroBody: {
    alignItems: 'center',
    paddingBottom: 28,
    paddingTop: 8,
  },
  heroDetail: {
    color: 'rgba(15, 15, 18, 0.68)',
    marginTop: 8,
    maxWidth: 280,
    textAlign: 'center',
  },
  heroKicker: {
    color: 'rgba(15, 15, 18, 0.62)',
    fontSize: 14,
    lineHeight: 18,
  },
  heroSection: {
    minHeight: 276,
  },
  heroSelectedCount: {
    color: 'rgba(15, 15, 18, 0.62)',
    fontSize: 14,
    lineHeight: 18,
    marginTop: 8,
  },
  heroValue: {
    fontSize: 40,
    lineHeight: 44,
    marginTop: 4,
    textAlign: 'center',
  },
  inactiveLine: {
    opacity: 0.64,
  },
  lineArt: {
    borderRadius: 12,
    height: 84,
    resizeMode: 'contain',
    width: 60,
  },
  lineCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    shadowColor: '#0F0F12',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
  },
  lineCopy: {
    flex: 1,
    gap: 6,
  },
  lineHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  lineHeaderSection: {
    gap: 12,
  },
  lineList: {
    gap: 8,
    marginTop: -20,
  },
  lineSubtitle: {
    color: 'rgba(15, 15, 18, 0.52)',
    fontSize: 13,
    lineHeight: 18,
  },
  lineTitle: {
    lineHeight: 28,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  messageCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 24,
    borderWidth: 1,
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  messageText: {
    color: '#4D4F57',
  },
  messageTitle: {
    color: '#0F0F12',
  },
  notIncludedBadge: {
    backgroundColor: 'rgba(15, 15, 18, 0.07)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  notIncludedText: {
    color: 'rgba(15, 15, 18, 0.62)',
    fontSize: 13,
    lineHeight: 18,
  },
  reviewBackButton: {
    marginTop: 16,
  },
  reviewButton: {
    width: '100%',
  },
  reviewButtonDock: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  reviewButtonDockBody: {
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    borderRadius: 32,
    padding: 14,
    shadowColor: '#0F0F12',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
  },
  reviewLineArt: {
    borderRadius: 14,
    height: 88,
    resizeMode: 'contain',
    width: 64,
  },
  reviewLineCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    gap: 14,
  },
  reviewLineCopy: {
    flex: 1,
    gap: 6,
  },
  reviewLineHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  reviewMetricLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  reviewMetricRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  reviewMetricValue: {
    color: '#0F0F12',
  },
  reviewTotalCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    gap: 6,
  },
  reviewTotalDetail: {
    color: 'rgba(15, 15, 18, 0.62)',
  },
  reviewTotalLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  reviewTotalValue: {
    color: '#0F0F12',
  },
  safeArea: {
    flex: 1,
  },
  stackArt: {
    height: 176,
    marginTop: 16,
    position: 'relative',
    width: 216,
  },
  stackCard: {
    borderRadius: 16,
    height: 152,
    position: 'absolute',
    width: 104,
  },
  topChrome: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 40,
  },
  topChromeTitle: {
    color: 'rgba(15, 15, 18, 0.9)',
    fontSize: 18,
    lineHeight: 22,
  },
  viewport: {
    flex: 1,
  },
});
