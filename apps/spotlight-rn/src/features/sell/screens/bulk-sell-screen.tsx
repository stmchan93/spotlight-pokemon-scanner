import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  type GestureResponderHandlers,
  Image,
  Keyboard,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton, chromeBackButtonSize } from '@/components/chrome-back-button';
import { formatCurrency, formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  buildBulkSellPayloads,
  buildBulkSellStatusCopy,
  buildInitialBulkSellLines,
  bulkSellEmptySelectionErrorMessage,
  bulkSellMissingPriceErrorMessage,
  getBulkSellLineMetrics,
  summarizeBulkSellSelection,
  validateBulkSellSubmission,
  type BulkSellLineState,
} from '@/features/sell/sell-batch-helpers';
import {
  collectionSummaryLine,
  formatSellOrderBoughtPriceLabel,
  canStartSellSheetDismissGesture,
  canStartSellSwipeGesture,
  getResistedSellSwipeTranslation,
  getSellSwipeConfirmThreshold,
  isSellSwipeReleaseArmed,
  sellOrderProcessingMinimumDurationMs,
  scheduleSellStatusCompletion,
  sellOrderSwipeRailHeight,
} from '@/features/sell/sell-order-helpers';
import {
  SellBackdrop,
  SellFormFields,
  SellStatusOverlay,
  triggerSellHaptic,
} from '@/features/sell/components/sell-ui';
import { useAppServices } from '@/providers/app-providers';

const sheetDismissPreviewDistance = 132;
const sheetDismissThreshold = 72;
const sheetDismissVelocityThreshold = 0.55;

type BulkSellScreenProps = {
  entryIds: string[];
  onClose: () => void;
  onComplete: () => void;
};

function TopChrome({
  onClose,
  panHandlers,
}: {
  onClose: () => void;
  panHandlers?: GestureResponderHandlers;
}) {
  const theme = useSpotlightTheme();

  return (
    <View
      {...panHandlers}
      style={styles.topChrome}
      testID="bulk-sell-top-chrome"
    >
      <ChromeBackButton
        onPress={onClose}
        style={styles.closeButton}
        testID="bulk-sell-close"
      />

      <View style={styles.topChromeCopy}>
        <View style={styles.topChromeHandle} />
        <Text style={[theme.typography.headline, styles.topChromeTitle]}>Sell order</Text>
      </View>

      <View style={styles.closeButtonSpacer} />
    </View>
  );
}

function LineCard({
  entry,
  line,
  onChangeLine,
  onFieldBlur,
  onFieldFocus,
  showsSellPriceValidation,
}: {
  entry: InventoryCardEntry;
  line: BulkSellLineState;
  onChangeLine: (nextLine: BulkSellLineState) => void;
  onFieldBlur: () => void;
  onFieldFocus: () => void;
  showsSellPriceValidation: boolean;
}) {
  const theme = useSpotlightTheme();
  const metrics = getBulkSellLineMetrics(entry, line);
  const collectionSummary = collectionSummaryLine(entry);
  const boughtPriceText = formatSellOrderBoughtPriceLabel(
    entry.costBasisPerUnit,
    formatCurrency(entry.costBasisPerUnit ?? 0, entry.currencyCode),
    line.revealsBoughtPrice,
  );

  return (
    <View testID={`bulk-sell-line-${entry.id}`}>
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
              {collectionSummary ? (
                <Text numberOfLines={1} style={[theme.typography.caption, styles.lineDescriptor]}>
                  {collectionSummary}
                </Text>
              ) : null}
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
          boughtPriceLabel={boughtPriceText}
          boughtPriceToggleDisabled={entry.costBasisPerUnit == null}
          decrementDisabled={metrics.quantity <= 0}
          incrementDisabled={metrics.quantity >= Math.max(0, entry.quantity)}
          marketPriceLabel={formatOptionalCurrency(
            entry.hasMarketPrice ? entry.marketPrice : null,
            entry.currencyCode,
          )}
          offerPriceTestID={`bulk-sell-offer-${entry.id}`}
          offerPriceText={line.offerPriceText}
          onBlur={onFieldBlur}
          onDecrement={() => onChangeLine({ ...line, quantity: Math.max(0, line.quantity - 1) })}
          onFocus={onFieldFocus}
          onIncrement={() => onChangeLine({ ...line, quantity: Math.min(entry.quantity, line.quantity + 1) })}
          onOfferPriceChangeText={(value) => onChangeLine({ ...line, offerPriceText: value })}
          onSoldPriceChangeText={(value) => onChangeLine({ ...line, soldPriceText: value })}
          onToggleBoughtPrice={() => onChangeLine({ ...line, revealsBoughtPrice: !line.revealsBoughtPrice })}
          onYourPriceChangeText={(value) => onChangeLine({ ...line, yourPriceText: value })}
          quantity={metrics.quantity}
          revealsBoughtPrice={line.revealsBoughtPrice}
          soldPriceErrorMessage={showsSellPriceValidation ? 'Enter a sell price before confirming sale.' : null}
          soldPriceTestID={`bulk-sell-sold-price-${entry.id}`}
          soldPriceText={line.soldPriceText}
          stepperTestIDs={{
            decrement: `bulk-sell-decrement-${entry.id}`,
            increment: `bulk-sell-increment-${entry.id}`,
          }}
          testIDPrefix={`bulk-sell-${entry.id}`}
          toggleBoughtPriceTestID={`bulk-sell-toggle-bought-price-${entry.id}`}
          ypPercentText={metrics.ypPercentText}
          yourPriceTestID={`bulk-sell-your-price-${entry.id}`}
          yourPriceText={line.yourPriceText}
        />
      </SurfaceCard>
    </View>
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitState, setSubmitState] = useState<'idle' | 'processing' | 'success'>('idle');
  const [isEditingField, setIsEditingField] = useState(false);
  const [releaseToConfirmArmed, setReleaseToConfirmArmed] = useState(false);

  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const hasInitializedSheetRef = useRef(false);
  const closedSheetOffsetRef = useRef(0);
  const releaseToConfirmArmedRef = useRef(false);
  const dismissOffset = useRef(new Animated.Value(0)).current;
  const sheetOffset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
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
        setErrorMessage(selectedEntries.length === 0 ? 'No inventory cards were selected for this sale.' : null);
        setSubmitState('idle');
        setReleaseToConfirmArmed(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setEntries([]);
        setLines({});
        setErrorMessage('Could not load these cards right now.');
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
  const showsGlobalMessage = errorMessage != null && errorMessage !== bulkSellMissingPriceErrorMessage;
  const selectedCountLabel =
    summary.totalSelectedQuantity === 1 ? '1 card selected' : `${summary.totalSelectedQuantity} cards selected`;
  const showsStatusSheet = submitState !== 'idle';
  const submitThreshold = getSellSwipeConfirmThreshold();
  const containerHeight = Math.max(0, windowHeight - insets.top - insets.bottom);
  const closedSheetOffset = Math.max(0, containerHeight - sellOrderSwipeRailHeight);
  const contentLiftDistance = Math.max(0, Math.min(containerHeight, closedSheetOffset + sellOrderSwipeRailHeight));
  const swipeSheetHeight = containerHeight + insets.bottom;
  const canInteract = submitState === 'idle';

  const confirmationProgress = useMemo(() => sheetOffset.interpolate({
    inputRange: [0, Math.max(1, closedSheetOffset)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  }), [closedSheetOffset, sheetOffset]);

  const confirmationContentLift = useMemo(() => confirmationProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -contentLiftDistance],
    extrapolate: 'clamp',
  }), [confirmationProgress, contentLiftDistance]);

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

  const syncReleaseToConfirmState = useCallback((nextOffset: number) => {
    const nextState = isSellSwipeReleaseArmed(nextOffset, closedSheetOffsetRef.current);
    if (nextState === releaseToConfirmArmedRef.current) {
      return;
    }

    if (nextState) {
      void triggerSellHaptic('armed');
    }

    releaseToConfirmArmedRef.current = nextState;
    setReleaseToConfirmArmed(nextState);
  }, []);

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

  const resetDismissOffset = useCallback(() => {
    Animated.spring(dismissOffset, {
      toValue: 0,
      stiffness: 280,
      damping: 28,
      mass: 1,
      overshootClamping: false,
      useNativeDriver: true,
    }).start();
  }, [dismissOffset]);

  const beginGestureInteraction = useCallback(() => {
    if (!isEditingField) {
      return;
    }

    Keyboard.dismiss();
    setIsEditingField(false);
  }, [isEditingField]);

  const dismissSheet = useCallback(() => {
    Animated.timing(dismissOffset, {
      toValue: containerHeight + insets.bottom,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        return;
      }

      dismissOffset.setValue(0);
      onClose();
    });
  }, [containerHeight, dismissOffset, insets.bottom, onClose]);

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

  useEffect(() => {
    if (!isEditingField || submitState !== 'idle') {
      return;
    }

    animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
  }, [animateSheetToOffset, isEditingField, submitState]);

  const dismissPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      submitState === 'idle' &&
      canStartSellSheetDismissGesture(gestureState.dx, gestureState.dy)
    ),
    onPanResponderGrant: beginGestureInteraction,
    onPanResponderMove: (_, gestureState) => {
      if (submitState !== 'idle') {
        return;
      }

      dismissOffset.setValue(Math.min(sheetDismissPreviewDistance, Math.max(0, gestureState.dy)));
    },
    onPanResponderRelease: (_, gestureState) => {
      if (submitState !== 'idle') {
        return;
      }

      if (gestureState.dy >= sheetDismissThreshold || gestureState.vy >= sheetDismissVelocityThreshold) {
        dismissSheet();
        return;
      }

      resetDismissOffset();
    },
    onPanResponderTerminate: () => {
      if (submitState !== 'idle') {
        return;
      }

      resetDismissOffset();
    },
  }), [beginGestureInteraction, dismissOffset, dismissSheet, resetDismissOffset, submitState]);

  const updateLine = useCallback((entryId: string, nextLine: BulkSellLineState) => {
    setLines((current) => ({
      ...current,
      [entryId]: nextLine,
    }));
    setErrorMessage((current) => {
      if (current === null) {
        return null;
      }

      if (
        current === bulkSellMissingPriceErrorMessage ||
        current === bulkSellEmptySelectionErrorMessage ||
        current.startsWith('Could not')
      ) {
        return null;
      }

      return current;
    });
  }, []);

  const submitSale = useCallback(() => {
    const nextError = validateBulkSellSubmission(entries, lines);
    setErrorMessage(nextError);
    if (nextError) {
      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
      return;
    }

    setSubmitState('processing');
    const payloads = buildBulkSellPayloads(entries, lines);
    const startedAt = Date.now();

    void spotlightRepository.createPortfolioSalesBatch(payloads)
      .then(() => {
        if (!isMountedRef.current) {
          return;
        }

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
        setErrorMessage(error instanceof Error ? error.message : 'Could not confirm this batch sale.');
      });
  }, [animateSheetToOffset, entries, lines, onComplete, refreshData, spotlightRepository]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      canInteract && canStartSellSwipeGesture(gestureState.dx, gestureState.dy)
    ),
    onPanResponderGrant: beginGestureInteraction,
    onPanResponderMove: (_, gestureState) => {
      if (!canInteract) {
        return;
      }

      const upwardTravel = Math.max(0, -gestureState.dy);
      if (summary.totalSelectedQuantity === 0) {
        if (upwardTravel > 6) {
          setErrorMessage(bulkSellEmptySelectionErrorMessage);
        }
        setSheetOffsetValue(closedSheetOffsetRef.current);
        return;
      }

      if (summary.hasMissingActiveSoldPrice) {
        if (upwardTravel > 6) {
          setErrorMessage(bulkSellMissingPriceErrorMessage);
        }
        setSheetOffsetValue(closedSheetOffsetRef.current);
        return;
      }

      setSheetOffsetValue(closedSheetOffsetRef.current + getResistedSellSwipeTranslation(gestureState.dy));
    },
    onPanResponderRelease: (_, gestureState) => {
      if (!canInteract) {
        return;
      }

      const upwardTravel = Math.max(0, -gestureState.dy);
      if (summary.totalSelectedQuantity === 0) {
        setErrorMessage(bulkSellEmptySelectionErrorMessage);
        animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
        return;
      }

      if (summary.hasMissingActiveSoldPrice) {
        setErrorMessage(bulkSellMissingPriceErrorMessage);
        animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
        return;
      }

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
    submitSale,
    submitThreshold,
    summary.hasMissingActiveSoldPrice,
    summary.totalSelectedQuantity,
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

  if (showsStatusSheet) {
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

  const confirmationPrompt = releaseToConfirmArmed ? 'Release to confirm sale' : 'Swipe up to confirm sale';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <SellBackdrop imageUrl={entries[0]?.imageUrl} variant="bulk" />

      <Animated.View
        style={[
          styles.dismissLayer,
          {
            transform: [{ translateY: dismissOffset }],
          },
        ]}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: insets.bottom + sellOrderSwipeRailHeight + 48,
            },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[
              styles.contentBody,
              {
                minHeight: containerHeight,
                transform: [{ translateY: confirmationContentLift }],
              },
            ]}
          >
            <View style={styles.heroSection} testID="bulk-sell-summary-card">
              <TopChrome
                onClose={onClose}
                panHandlers={dismissPanResponder.panHandlers}
              />

              <View style={styles.heroBody}>
                <Text style={[theme.typography.caption, styles.heroKicker]}>{selectedCountLabel}</Text>
                <Text style={[theme.typography.display, styles.heroValue]}>
                  {formatCurrency(summary.draftGrossTotal || 0, summary.currencyCode)}
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
              </View>
            </View>

            {showsGlobalMessage ? (
              <View style={styles.validationMessageRow}>
                <Text style={[theme.typography.caption, styles.validationMessageText, { color: theme.colors.danger }]}>
                  {errorMessage}
                </Text>
              </View>
            ) : null}

            <View style={styles.lineList}>
              {entries.map((entry) => {
                const line = lines[entry.id];
                if (!line) {
                  return null;
                }

                const metrics = getBulkSellLineMetrics(entry, line);

                return (
                  <LineCard
                    key={entry.id}
                    entry={entry}
                    line={line}
                    onChangeLine={(nextLine) => updateLine(entry.id, nextLine)}
                    onFieldBlur={() => setIsEditingField(false)}
                    onFieldFocus={() => setIsEditingField(true)}
                    showsSellPriceValidation={
                      errorMessage === bulkSellMissingPriceErrorMessage && metrics.isActive && metrics.soldPrice == null
                    }
                  />
                );
              })}
            </View>
          </Animated.View>
        </ScrollView>

        <View pointerEvents="box-none" style={styles.swipeSheetWrap}>
          <Animated.View
            {...panResponder.panHandlers}
            style={[
              styles.swipeSheet,
              {
                backgroundColor: theme.colors.brand,
                height: swipeSheetHeight,
                paddingBottom: insets.bottom + 16,
                transform: [{ translateY: sheetOffset }],
              },
            ]}
            testID="bulk-sell-swipe-rail"
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.confirmationPrompt,
                {
                  opacity: confirmationPromptOpacity,
                  transform: [{ scale: confirmationPromptScale }],
                },
              ]}
              testID="bulk-sell-confirmation-prompt"
            >
              <Text style={styles.swipeChevron}>⌃</Text>
              <Text style={[theme.typography.body, styles.swipeRailTitle]}>{confirmationPrompt}</Text>
            </Animated.View>
          </Animated.View>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    flexShrink: 0,
  },
  closeButtonSpacer: {
    width: chromeBackButtonSize,
  },
  confirmationPrompt: {
    alignItems: 'center',
    borderTopColor: 'rgba(0, 0, 0, 0.05)',
    borderTopWidth: 1,
    gap: 8,
    justifyContent: 'center',
    minHeight: sellOrderSwipeRailHeight,
    paddingTop: 4,
    width: '100%',
  },
  dismissLayer: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  contentBody: {
    gap: 12,
  },
  divider: {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
    height: 1,
  },
  heroBody: {
    alignItems: 'center',
    paddingBottom: 36,
    paddingTop: 8,
  },
  heroKicker: {
    color: 'rgba(15, 15, 18, 0.62)',
    fontSize: 14,
    lineHeight: 18,
  },
  heroSection: {
    minHeight: 276,
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
    gap: 4,
  },
  lineDescriptor: {
    color: 'rgba(15, 15, 18, 0.52)',
    fontSize: 13,
    lineHeight: 18,
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
  swipeChevron: {
    color: 'rgba(15, 15, 18, 0.7)',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 13,
  },
  swipeRailTitle: {
    color: 'rgba(15, 15, 18, 0.86)',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  swipeSheet: {
    alignItems: 'center',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    justifyContent: 'flex-start',
    overflow: 'hidden',
    width: '100%',
  },
  swipeSheetWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  topChrome: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 40,
  },
  topChromeCopy: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
  },
  topChromeHandle: {
    backgroundColor: 'rgba(15, 15, 18, 0.14)',
    borderRadius: 999,
    height: 4,
    width: 44,
  },
  topChromeTitle: {
    color: 'rgba(15, 15, 18, 0.9)',
    fontSize: 18,
    lineHeight: 22,
  },
  validationMessageRow: {
    marginTop: -8,
    paddingHorizontal: 8,
  },
  validationMessageText: {
    textAlign: 'center',
  },
});
