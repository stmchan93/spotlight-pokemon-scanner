import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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

import { ChromeBackButton } from '@/components/chrome-back-button';
import { formatCurrency, formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  buildOfferToYourPricePercentText,
  buildSingleSellStatusCopy,
  canStartSellSheetDismissGesture,
  canStartSellSwipeGesture,
  formatEditableSellPrice,
  formatSellOrderBoughtPriceLabel,
  getResistedSellSwipeTranslation,
  getSellSwipeConfirmThreshold,
  isSellSwipeReleaseArmed,
  parseSellPrice,
  sellOrderProcessingMinimumDurationMs,
  sellOrderSwipeRailHeight,
} from '@/features/sell/sell-order-helpers';
import {
  SellBackdrop,
  SellFormFields,
  triggerSellHaptic,
} from '@/features/sell/components/sell-ui';
import { useAppServices } from '@/providers/app-providers';

const sheetDismissPreviewDistance = 132;
const sheetDismissThreshold = 72;
const sheetDismissVelocityThreshold = 0.55;

type SingleSellScreenProps = {
  entryId: string;
  onClose: () => void;
  onComplete: () => void;
};

function SellTopChrome({
  onClose,
  panHandlers,
  testID,
}: {
  onClose: () => void;
  panHandlers?: GestureResponderHandlers;
  testID: string;
}) {
  return (
    <View
      {...panHandlers}
      style={styles.topChrome}
      testID="single-sell-top-chrome"
    >
      <View style={styles.topChromeCopy}>
        <View style={styles.topChromeHandle} />
      </View>

      <ChromeBackButton
        onPress={onClose}
        style={styles.closeButton}
        testID={testID}
      />
    </View>
  );
}

export function SingleSellScreen({
  entryId,
  onClose,
  onComplete,
}: SingleSellScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { refreshData, spotlightRepository } = useAppServices();

  const [entry, setEntry] = useState<InventoryCardEntry | null>(null);
  const [lastResolvedEntry, setLastResolvedEntry] = useState<InventoryCardEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [offerPriceText, setOfferPriceText] = useState('');
  const [yourPriceText, setYourPriceText] = useState('');
  const [soldPriceText, setSoldPriceText] = useState('');
  const [revealsBoughtPrice, setRevealsBoughtPrice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
        const nextEntry = inventory.find((candidate) => candidate.id === entryId) ?? null;
        setEntry(nextEntry);
        if (nextEntry) {
          setLastResolvedEntry(nextEntry);
        }
        setQuantity(1);
        setOfferPriceText('');
        setYourPriceText(
          nextEntry && nextEntry.hasMarketPrice
            ? formatEditableSellPrice(nextEntry.marketPrice)
            : '',
        );
        setSoldPriceText('');
        setRevealsBoughtPrice(false);
        setErrorMessage(null);
        setSubmitState('idle');
        setReleaseToConfirmArmed(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setEntry(null);
        setErrorMessage('Could not load this inventory card right now.');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
    };
  }, [entryId, spotlightRepository]);

  const displayEntry = entry ?? lastResolvedEntry;

  const soldPrice = useMemo(() => parseSellPrice(soldPriceText), [soldPriceText]);
  const offerPrice = useMemo(() => parseSellPrice(offerPriceText), [offerPriceText]);
  const yourPrice = useMemo(() => {
    if (!entry) {
      return null;
    }
    if (yourPriceText.trim().length > 0) {
      return parseSellPrice(yourPriceText);
    }

    return entry.hasMarketPrice ? entry.marketPrice : null;
  }, [entry, yourPriceText]);

  const ypPercentText = useMemo(() => {
    return buildOfferToYourPricePercentText(offerPrice, yourPrice);
  }, [offerPrice, yourPrice]);

  const soldTotal = useMemo(() => {
    return (soldPrice ?? 0) * quantity;
  }, [quantity, soldPrice]);

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

  const statusCopy = useMemo(() => {
    if (!displayEntry) {
      return {
        title: '',
        headline: '',
        detail: '',
      };
    }

    return buildSingleSellStatusCopy({
      currencyCode: displayEntry.currencyCode,
      entryName: displayEntry.name,
      quantity,
      soldTotal,
      submitState: submitState === 'success' ? 'success' : 'processing',
    });
  }, [displayEntry, quantity, soldTotal, submitState]);

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

  const submitSale = useCallback(() => {
    if (!displayEntry) {
      return;
    }
    if (soldPrice == null) {
      setErrorMessage('Enter a sell price before confirming sale.');
      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
      return;
    }

    setSubmitState('processing');
    setErrorMessage(null);
    const startedAt = Date.now();

    const payload = {
      deckEntryID: displayEntry.id,
      cardID: displayEntry.cardId,
      slabContext: displayEntry.slabContext ?? null,
      quantity,
      unitPrice: soldPrice,
      currencyCode: displayEntry.currencyCode,
      paymentMethod: null,
      soldAt: new Date().toISOString(),
      showSessionID: null,
      note: null,
      sourceScanID: null,
    } as const;

    void spotlightRepository.createPortfolioSale(payload)
      .then(() => {
        if (!isMountedRef.current) {
          return;
        }

        refreshData();
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, sellOrderProcessingMinimumDurationMs - elapsed);

        processingTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current) {
            return;
          }

          void triggerSellHaptic('success');
          setSubmitState('success');
          onComplete();
        }, remaining);
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current) {
          return;
        }

        setSubmitState('idle');
        animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
        setErrorMessage(error instanceof Error ? error.message : 'Could not confirm this sale.');
      });
  }, [animateSheetToOffset, displayEntry, onComplete, quantity, refreshData, soldPrice, spotlightRepository]);

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
      if (soldPrice == null) {
        if (upwardTravel > 6) {
          setErrorMessage('Enter a sell price before confirming sale.');
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
      if (soldPrice == null) {
        setErrorMessage('Enter a sell price before confirming sale.');
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
    soldPrice,
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

  if (!displayEntry) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Card unavailable</Text>
          <Text style={[theme.typography.body, styles.unavailableCopy]}>
            {errorMessage ?? 'This inventory card could not be found.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={[styles.unavailableButton, { backgroundColor: theme.colors.brand }]}
          >
            <Text style={theme.typography.control}>Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const boughtPriceText = formatSellOrderBoughtPriceLabel(
    displayEntry.costBasisPerUnit,
    formatCurrency(displayEntry.costBasisPerUnit ?? 0, displayEntry.currencyCode),
    revealsBoughtPrice,
  );
  const showsStatusSheet = submitState !== 'idle';
  const confirmationPrompt = releaseToConfirmArmed ? 'Release to confirm sale' : 'Swipe up to confirm sale';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <SellBackdrop imageUrl={displayEntry.imageUrl} variant="single" />

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
            <View style={styles.heroSection}>
              <SellTopChrome
                onClose={onClose}
                panHandlers={dismissPanResponder.panHandlers}
                testID="single-sell-close"
              />

              <View style={styles.heroBody}>
                <View style={styles.heroTitleWrap}>
                  <Text style={[theme.typography.display, styles.heroName]}>{displayEntry.name}</Text>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.caption, styles.heroMetaText]}
                  >
                    {displayEntry.cardNumber}
                    {' • '}
                    {displayEntry.setName}
                  </Text>
                </View>
                <View style={styles.heroArtShadow}>
                  <Image source={{ uri: displayEntry.imageUrl }} style={styles.heroArt} />
                </View>
              </View>
            </View>

            <View style={styles.detailsCardWrap} testID="single-sell-summary-card">
              <SurfaceCard padding={18} radius={32} style={styles.detailsCard}>
                <SellFormFields
                  boughtPriceLabel={boughtPriceText}
                  boughtPriceToggleDisabled={displayEntry.costBasisPerUnit == null}
                  decrementDisabled={quantity <= 1}
                  incrementDisabled={quantity >= Math.max(1, displayEntry.quantity)}
                  marketPriceLabel={formatOptionalCurrency(
                    displayEntry.hasMarketPrice ? displayEntry.marketPrice : null,
                    displayEntry.currencyCode,
                  )}
                  offerPriceTestID="single-sell-offer-price"
                  offerPriceText={offerPriceText}
                  onBlur={() => setIsEditingField(false)}
                  onDecrement={() => {
                    setQuantity((current) => Math.max(1, current - 1));
                    setErrorMessage(null);
                  }}
                  onFocus={() => setIsEditingField(true)}
                  onIncrement={() => {
                    setQuantity((current) => Math.min(displayEntry.quantity, current + 1));
                    setErrorMessage(null);
                  }}
                  onOfferPriceChangeText={(nextValue) => {
                    setOfferPriceText(nextValue);
                    setErrorMessage(null);
                  }}
                  onSoldPriceChangeText={(nextValue) => {
                    setSoldPriceText(nextValue);
                    setErrorMessage(null);
                  }}
                  onToggleBoughtPrice={() => setRevealsBoughtPrice((current) => !current)}
                  onYourPriceChangeText={(nextValue) => {
                    setYourPriceText(nextValue);
                    setErrorMessage(null);
                  }}
                  quantity={quantity}
                  revealsBoughtPrice={revealsBoughtPrice}
                  soldPriceErrorMessage={errorMessage}
                  soldPriceErrorTestID="single-sell-error-message"
                  soldPriceTestID="single-sell-sold-price"
                  soldPriceText={soldPriceText}
                  stepperTestIDs={{
                    decrement: 'single-sell-decrement',
                    increment: 'single-sell-increment',
                  }}
                  testIDPrefix="single-sell"
                  toggleBoughtPriceTestID="single-sell-toggle-bought-price"
                  ypPercentText={ypPercentText}
                  yourPriceTestID="single-sell-your-price"
                  yourPriceText={yourPriceText}
                />
              </SurfaceCard>
            </View>
          </Animated.View>
        </ScrollView>

        <View pointerEvents="box-none" style={styles.swipeSheetWrap}>
          <Animated.View
            {...(showsStatusSheet ? {} : panResponder.panHandlers)}
            style={[
              styles.swipeSheet,
              {
                backgroundColor: theme.colors.brand,
                height: swipeSheetHeight,
                paddingBottom: insets.bottom + 16,
                transform: [{ translateY: sheetOffset }],
              },
            ]}
            testID="single-sell-swipe-rail"
          >
            {showsStatusSheet ? (
              <View style={styles.statusScreen}>
                <View style={styles.statusBody}>
                  <View style={styles.statusIconWrap}>
                    {submitState === 'success' ? (
                      <Text style={styles.statusCheckmark}>✓</Text>
                    ) : (
                      <ActivityIndicator color="rgba(0, 0, 0, 0.78)" size="large" />
                    )}
                  </View>
                  <Text style={[theme.typography.caption, styles.statusTitle]}>{statusCopy.title}</Text>
                  <Text style={[theme.typography.bodyStrong, styles.statusHeadline]}>{statusCopy.headline}</Text>
                  <Text style={[theme.typography.body, styles.statusDetail]}>{statusCopy.detail}</Text>
                </View>
              </View>
            ) : (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.confirmationPrompt,
                  {
                    opacity: confirmationPromptOpacity,
                    transform: [{ scale: confirmationPromptScale }],
                  },
                ]}
                testID="single-sell-confirmation-prompt"
              >
                <Text style={styles.swipeChevron}>⌃</Text>
                <Text style={[theme.typography.body, styles.swipeRailTitle]}>{confirmationPrompt}</Text>
              </Animated.View>
            )}
          </Animated.View>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    position: 'absolute',
    left: 0,
    top: 0,
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
    paddingTop: 8,
  },
  contentBody: {
    gap: 12,
  },
  detailsCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    shadowColor: '#0F0F12',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
  },
  detailsCardWrap: {
    marginTop: -40,
  },
  heroArt: {
    borderRadius: 20,
    height: 240,
    resizeMode: 'contain',
    width: 172,
  },
  heroArtShadow: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
  },
  heroBody: {
    alignItems: 'center',
    gap: 16,
    justifyContent: 'center',
    paddingBottom: 40,
    paddingTop: 20,
  },
  heroName: {
    color: 'rgba(15, 15, 18, 0.88)',
    flexShrink: 1,
    fontSize: 28,
    lineHeight: 32,
    textAlign: 'center',
  },
  heroMetaText: {
    color: 'rgba(15, 15, 18, 0.68)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  heroSection: {
    minHeight: 340,
  },
  heroTitleWrap: {
    gap: 8,
    paddingHorizontal: 12,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  safeArea: {
    flex: 1,
  },
  statusBody: {
    alignItems: 'center',
    maxWidth: 320,
    paddingBottom: 96,
    paddingHorizontal: 28,
    paddingTop: 148,
  },
  statusCheckmark: {
    color: 'rgba(0, 0, 0, 0.84)',
    fontSize: 32,
    fontWeight: '800',
    lineHeight: 36,
  },
  statusDetail: {
    color: 'rgba(0, 0, 0, 0.66)',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  statusHeadline: {
    color: 'rgba(0, 0, 0, 0.9)',
    fontSize: 18,
    lineHeight: 22,
    textAlign: 'center',
  },
  statusIconWrap: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    marginBottom: 20,
  },
  statusScreen: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    width: '100%',
  },
  statusTitle: {
    color: 'rgba(0, 0, 0, 0.58)',
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 10,
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
    minHeight: 32,
    paddingTop: 4,
    position: 'relative',
  },
  topChromeCopy: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'center',
  },
  topChromeHandle: {
    backgroundColor: 'rgba(15, 15, 18, 0.16)',
    borderRadius: 999,
    height: 4,
    width: 56,
  },
  unavailableButton: {
    alignItems: 'center',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 46,
    minWidth: 112,
    paddingHorizontal: 18,
  },
  unavailableCopy: {
    color: '#4D4F57',
    textAlign: 'center',
  },
});
