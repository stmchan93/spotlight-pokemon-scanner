import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  findNodeHandle,
  type GestureResponderHandlers,
  Image,
  Keyboard,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry, PaymentMethod, VendorWalletHandles } from '@spotlight/api-client';
import { Button, SurfaceCard, colors, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { formatCurrency, formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  buildSingleSellStatusCopy,
  canStartSellSheetDismissGesture,
  canStartSellSwipeGesture,
  formatEditableSellPrice,
  formatSellOrderBoughtPriceLabel,
  getSellSwipeArmThresholdRatio,
  getResistedSellSwipeTranslation,
  getSellSwipeConfirmThreshold,
  isSellSwipeReleaseArmed,
  parseSellPrice,
  scheduleSellStatusCompletion,
  slabGradeSummary,
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
import { MarketInfoSection } from '@/features/sell/components/market-info-section';
import { WalletHandleSetupModal } from '@/features/sell/components/wallet-handle-setup-modal';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

const sheetDismissPreviewDistance = 132;
const sheetDismissThreshold = 72;
const sheetDismissVelocityThreshold = 0.55;
const soldPriceValidationMessage = 'Enter a sell price before confirming sale.';

type SingleSellScreenProps = {
  entryId: string;
  cardId?: string;
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
      <ChromeBackButton
        onPress={onClose}
        style={styles.closeButton}
        testID={testID}
      />
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

export function SingleSellScreen({
  entryId,
  cardId,
  onClose,
  onComplete,
}: SingleSellScreenProps) {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { refreshData, spotlightRepository } = useAppServices();

  const [entry, setEntry] = useState<InventoryCardEntry | null>(null);
  const [lastResolvedEntry, setLastResolvedEntry] = useState<InventoryCardEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [soldPriceText, setSoldPriceText] = useState('');
  const [revealsBoughtPrice, setRevealsBoughtPrice] = useState(false);
  const [screenErrorMessage, setScreenErrorMessage] = useState<string | null>(null);
  const [showsSoldPriceValidation, setShowsSoldPriceValidation] = useState(false);
  const [submitState, setSubmitState] = useState<'idle' | 'processing' | 'success'>('idle');
  const [isEditingField, setIsEditingField] = useState(false);
  const [releaseToConfirmArmed, setReleaseToConfirmArmed] = useState(false);
  const [isBoughtPriceEditorVisible, setIsBoughtPriceEditorVisible] = useState(false);
  const [boughtPriceDraftText, setBoughtPriceDraftText] = useState('');
  const [boughtPriceErrorMessage, setBoughtPriceErrorMessage] = useState<string | null>(null);
  const [isSavingBoughtPrice, setIsSavingBoughtPrice] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [walletHandles, setWalletHandles] = useState<VendorWalletHandles | null>(null);
  const [walletSetupMethod, setWalletSetupMethod] = useState<PaymentMethod | null>(null);

  useEffect(() => {
    let cancelled = false;
    void spotlightRepository.getVendorWalletHandles()
      .then((next) => {
        if (cancelled) return;
        setWalletHandles(next);
      })
      .catch(() => {
        // best-effort; chip taps will re-prompt if a handle is missing
      });
    return () => {
      cancelled = true;
    };
  }, [spotlightRepository]);

  const handleHasMethod = useCallback((method: PaymentMethod, handles: VendorWalletHandles | null) => {
    if (!handles) return false;
    switch (method) {
      case 'venmo': return Boolean(handles.venmoHandle);
      case 'cashapp': return Boolean(handles.cashappHandle);
      case 'paypal': return Boolean(handles.paypalMeSlug);
      case 'zelle': return Boolean(handles.zelleEmailOrPhone);
      default: return true;
    }
  }, []);

  const handlePaymentChipPress = useCallback((next: PaymentMethod) => {
    if (next === 'cash' || next === 'other') {
      setPaymentMethod(next);
      return;
    }
    if (handleHasMethod(next, walletHandles)) {
      setPaymentMethod(next);
      return;
    }
    setWalletSetupMethod(next);
  }, [handleHasMethod, walletHandles]);

  const initialWalletValue = useMemo(() => {
    if (!walletSetupMethod || !walletHandles) return null;
    switch (walletSetupMethod) {
      case 'venmo': return walletHandles.venmoHandle;
      case 'cashapp': return walletHandles.cashappHandle;
      case 'paypal': return walletHandles.paypalMeSlug;
      case 'zelle': return walletHandles.zelleEmailOrPhone;
      default: return null;
    }
  }, [walletHandles, walletSetupMethod]);

  const handleWalletSetupSave = useCallback(async (update: { [key: string]: string | null | undefined }) => {
    const next = await spotlightRepository.updateVendorWalletHandles(update);
    setWalletHandles(next);
    if (walletSetupMethod) {
      setPaymentMethod(walletSetupMethod);
    }
    setWalletSetupMethod(null);
  }, [spotlightRepository, walletSetupMethod]);

  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const hasInitializedSheetRef = useRef(false);
  const closedSheetOffsetRef = useRef(0);
  const releaseToConfirmArmedRef = useRef(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const boughtPriceInputRef = useRef<TextInput | null>(null);
  const dismissOffset = useRef(new Animated.Value(0)).current;
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

    const loadEntry = async (): Promise<InventoryCardEntry | null> => {
      if (entryId !== 'new') {
        const inventory = await spotlightRepository.getInventoryEntries();
        return inventory.find((candidate) => candidate.id === entryId) ?? null;
      }
      if (!cardId) {
        return null;
      }
      const matches = await spotlightRepository.searchCatalogCards(cardId, 1);
      const match = matches.find((card) => card.cardId === cardId) ?? matches[0] ?? null;
      if (!match) {
        return null;
      }
      const stub: InventoryCardEntry = {
        id: 'new',
        cardId: match.cardId,
        name: match.name,
        cardNumber: match.cardNumber,
        setName: match.setName,
        imageUrl: match.imageUrl,
        marketPrice: match.marketPrice ?? 0,
        hasMarketPrice: typeof match.marketPrice === 'number',
        currencyCode: match.currencyCode ?? 'USD',
        quantity: 1,
        addedAt: new Date().toISOString(),
        kind: 'raw',
        conditionCode: 'near_mint',
        conditionLabel: 'Near Mint',
        conditionShortLabel: 'NM',
        costBasisPerUnit: null,
        costBasisTotal: 0,
      };
      return stub;
    };

    void loadEntry()
      .then((nextEntry) => {
        if (cancelled) {
          return;
        }
        setEntry(nextEntry);
        if (nextEntry) {
          setLastResolvedEntry(nextEntry);
        }
        setQuantity(1);
        setSoldPriceText('');
        setRevealsBoughtPrice(false);
        setScreenErrorMessage(null);
        setShowsSoldPriceValidation(false);
        setSubmitState('idle');
        setReleaseToConfirmArmed(false);
        setIsEditingField(false);
        setIsBoughtPriceEditorVisible(false);
        setBoughtPriceDraftText(
          nextEntry?.costBasisPerUnit != null ? formatEditableSellPrice(nextEntry.costBasisPerUnit) : '',
        );
        setBoughtPriceErrorMessage(null);
        setIsSavingBoughtPrice(false);
        setPaymentMethod('cash');
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setEntry(null);
        setScreenErrorMessage('Could not load this inventory card right now.');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      if (focusScrollTimerRef.current) {
        clearTimeout(focusScrollTimerRef.current);
      }
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
      }
    };
  }, [cardId, entryId, spotlightRepository]);

  const displayEntry = entry ?? lastResolvedEntry;
  const slabSubtitle = slabGradeSummary(displayEntry?.slabContext ?? null);

  const soldPrice = useMemo(() => parseSellPrice(soldPriceText), [soldPriceText]);
  const soldTotal = useMemo(() => {
    return (soldPrice ?? 0) * quantity;
  }, [quantity, soldPrice]);

  const containerHeight = Math.max(0, windowHeight - insets.top - insets.bottom);
  const submitThreshold = getSellSwipeConfirmThreshold(containerHeight);
  const closedSheetOffset = Math.max(0, containerHeight - sellOrderSwipeRailHeight);
  const releaseArmThresholdRatio = getSellSwipeArmThresholdRatio(containerHeight, closedSheetOffset);
  const contentLiftDistance = Math.max(0, Math.min(containerHeight, closedSheetOffset + sellOrderSwipeRailHeight));
  const swipeSheetHeight = containerHeight + insets.bottom;
  const canInteract = submitState === 'idle';
  const soldPriceErrorMessage = showsSoldPriceValidation ? soldPriceValidationMessage : null;

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
      setShowsSoldPriceValidation(true);
      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
      return;
    }

    setSubmitState('processing');
    setScreenErrorMessage(null);
    setShowsSoldPriceValidation(false);
    const startedAt = Date.now();

    const isStubEntry = displayEntry.id === 'new';
    const payload = {
      deckEntryID: isStubEntry ? null : displayEntry.id,
      cardID: displayEntry.cardId,
      slabContext: displayEntry.slabContext ?? null,
      quantity,
      unitPrice: soldPrice,
      currencyCode: displayEntry.currencyCode,
      paymentMethod,
      soldAt: new Date().toISOString(),
      showSessionID: null,
      note: null,
      sourceScanID: null,
    } as const;

    void spotlightRepository.createPortfolioSale(payload)
      .then((response) => {
        if (!isMountedRef.current) {
          return;
        }

        capturePostHogEvent('sale_single_succeeded', {
          kind: displayEntry.kind,
          quantity,
        });
        refreshData();

        const isPendingMethod = paymentMethod !== 'cash' && paymentMethod !== 'other';
        if (isPendingMethod) {
          router.replace({
            pathname: '/payments/[saleId]',
            params: {
              saleId: response.saleID,
              method: paymentMethod,
              amount: String(soldPrice * quantity),
              currencyCode: displayEntry.currencyCode,
              memo: `${displayEntry.name} ${displayEntry.cardNumber}`.trim(),
            },
          });
          return;
        }

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
        setScreenErrorMessage(error instanceof Error ? error.message : 'Could not confirm this sale.');
      });
  }, [animateSheetToOffset, displayEntry, onComplete, paymentMethod, quantity, refreshData, router, soldPrice, spotlightRepository]);

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
          setShowsSoldPriceValidation(true);
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
        setShowsSoldPriceValidation(true);
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

  const handleAccessibilityConfirm = useCallback(() => {
    if (!canInteract) {
      return;
    }

    if (soldPrice == null) {
      setShowsSoldPriceValidation(true);
      animateSheetToOffset(closedSheetOffsetRef.current, 'closed');
      return;
    }

    animateSheetToOffset(0, 'open');
    submitSale();
  }, [animateSheetToOffset, canInteract, soldPrice, submitSale]);

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading sell order...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!displayEntry) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Card unavailable</Text>
          <Text style={[theme.typography.body, styles.unavailableCopy]}>
            {screenErrorMessage ?? 'This inventory card could not be found.'}
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
          testIDPrefix="single-sell"
          title={statusCopy.title}
        />
      </SafeAreaView>
    );
  }

  const boughtPriceText = formatSellOrderBoughtPriceLabel(
    displayEntry.costBasisPerUnit,
    formatCurrency(displayEntry.costBasisPerUnit ?? 0, displayEntry.currencyCode),
    revealsBoughtPrice,
  );
  const confirmationPrompt = releaseToConfirmArmed ? 'Release to confirm sale' : 'Swipe up to confirm sale';
  const isSoldPriceMissing = soldPrice == null;
  const railIsDisabled = !canInteract || isSoldPriceMissing;
  const railUsesDisabledVisual = isSoldPriceMissing;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
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
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: insets.bottom + sellOrderSwipeRailHeight + 48,
            },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID="single-sell-scroll-view"
        >
          <TouchableWithoutFeedback
            accessible={false}
            onPress={() => {
              Keyboard.dismiss();
              setIsEditingField(false);
            }}
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

                <View style={styles.centeredHeroBody}>
                  <View style={styles.centeredHeroImageWrap}>
                    <Image source={{ uri: displayEntry.imageUrl }} style={styles.centeredHeroImage} />
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[theme.typography.title, styles.centeredHeroName]}
                  >
                    {displayEntry.name}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[theme.typography.bodyStrong, styles.centeredHeroMeta]}
                  >
                    {[
                      displayEntry.cardNumber,
                      slabSubtitle?.trim() || (!slabSubtitle && displayEntry.conditionShortLabel) || null,
                      displayEntry.setName,
                    ].filter(Boolean).join(' • ')}
                  </Text>
                </View>
              </View>

              {entryId === 'new' ? (
                <MarketInfoSection entry={displayEntry} />
              ) : null}

              {screenErrorMessage ? (
                <View
                  style={[styles.messageCard, { borderColor: theme.colors.danger }]}
                  testID="single-sell-global-error"
                >
                  <Text style={[theme.typography.bodyStrong, styles.messageTitle]}>Action needed</Text>
                  <Text style={[theme.typography.body, styles.messageText]}>{screenErrorMessage}</Text>
                </View>
              ) : null}

              <View style={styles.detailsCardWrap} testID="single-sell-summary-card">
                <SurfaceCard padding={18} radius={32} style={styles.detailsCard}>
                  <SellFormFields
                    boughtPriceInputRef={boughtPriceInputRef}
                    boughtPriceEditorErrorMessage={boughtPriceErrorMessage}
                    boughtPriceEditorText={boughtPriceDraftText}
                    boughtPriceEditorVisible={isBoughtPriceEditorVisible}
                    boughtPriceInputTestID="single-sell-bought-price-input"
                    boughtPriceLabel={boughtPriceText}
                    boughtPriceSaveDisabled={isSavingBoughtPrice}
                    boughtPriceToggleDisabled={displayEntry.costBasisPerUnit == null}
                    decrementDisabled={quantity <= 1}
                    incrementDisabled={quantity >= Math.max(1, displayEntry.quantity)}
                    marketPriceLabel={formatOptionalCurrency(
                      displayEntry.hasMarketPrice ? displayEntry.marketPrice : null,
                      displayEntry.currencyCode,
                    )}
                    onBlur={() => setIsEditingField(false)}
                    onBoughtPriceChangeText={(nextValue) => {
                      setBoughtPriceDraftText(nextValue);
                      setBoughtPriceErrorMessage(null);
                    }}
                    onBoughtPriceInputFocus={() => {
                      setIsEditingField(true);
                      scrollInputIntoView(boughtPriceInputRef);
                    }}
                    onCancelBoughtPriceEdit={() => {
                      setBoughtPriceDraftText(
                        displayEntry.costBasisPerUnit != null
                          ? formatEditableSellPrice(displayEntry.costBasisPerUnit)
                          : '',
                      );
                      setBoughtPriceErrorMessage(null);
                      setIsSavingBoughtPrice(false);
                      setIsBoughtPriceEditorVisible(false);
                    }}
                    onDecrement={() => {
                      setQuantity((current) => Math.max(1, current - 1));
                      setScreenErrorMessage(null);
                    }}
                    onEditBoughtPrice={() => {
                      setBoughtPriceDraftText(
                        displayEntry.costBasisPerUnit != null
                          ? formatEditableSellPrice(displayEntry.costBasisPerUnit)
                          : '',
                      );
                      setBoughtPriceErrorMessage(null);
                      setIsSavingBoughtPrice(false);
                      setIsBoughtPriceEditorVisible(true);
                      if (process.env.NODE_ENV === 'test') {
                        boughtPriceInputRef.current?.focus();
                        return;
                      }

                      focusScrollTimerRef.current = setTimeout(() => {
                        boughtPriceInputRef.current?.focus();
                        scrollInputIntoView(boughtPriceInputRef);
                      }, 80);
                    }}
                    onFocus={() => setIsEditingField(true)}
                    onIncrement={() => {
                      setQuantity((current) => Math.min(displayEntry.quantity, current + 1));
                      setScreenErrorMessage(null);
                    }}
                    onSaveBoughtPrice={() => {
                      if (!displayEntry) {
                        return;
                      }

                      const parsedBoughtPrice = parseSellPrice(boughtPriceDraftText);
                      if (parsedBoughtPrice == null) {
                        setBoughtPriceErrorMessage('Enter a valid bought price before saving.');
                        return;
                      }

                      setIsSavingBoughtPrice(true);
                      setBoughtPriceErrorMessage(null);
                      setScreenErrorMessage(null);

                      void spotlightRepository.replacePortfolioEntry({
                        deckEntryID: displayEntry.id,
                        cardID: displayEntry.cardId,
                        slabContext: displayEntry.slabContext ?? null,
                        variantName: displayEntry.variantName ?? null,
                        condition: displayEntry.kind === 'raw' ? displayEntry.conditionCode ?? null : null,
                        quantity: displayEntry.quantity,
                        unitPrice: parsedBoughtPrice,
                        currencyCode: displayEntry.currencyCode,
                        updatedAt: new Date().toISOString(),
                      }).then((response) => {
                        if (!isMountedRef.current) {
                          return;
                        }

                        const nextEntryId = response.deckEntryID || displayEntry.id;

                        setEntry((current) => (
                          current && current.id === displayEntry.id
                            ? patchEntryCostBasis(current, parsedBoughtPrice, nextEntryId)
                            : current
                        ));
                        setLastResolvedEntry((current) => (
                          current && current.id === displayEntry.id
                            ? patchEntryCostBasis(current, parsedBoughtPrice, nextEntryId)
                            : current
                        ));
                        setBoughtPriceDraftText(formatEditableSellPrice(parsedBoughtPrice));
                        setIsBoughtPriceEditorVisible(false);
                        setIsSavingBoughtPrice(false);
                        refreshData();
                      }).catch((error: unknown) => {
                        if (!isMountedRef.current) {
                          return;
                        }

                        setIsSavingBoughtPrice(false);
                        setBoughtPriceErrorMessage(error instanceof Error ? error.message : 'Could not update the bought price.');
                      });
                    }}
                    onSoldPriceChangeText={(nextValue) => {
                      setSoldPriceText(nextValue);
                      setScreenErrorMessage(null);
                      setShowsSoldPriceValidation(false);
                    }}
                    onSoldPriceFocus={() => setIsEditingField(false)}
                    onToggleBoughtPrice={() => setRevealsBoughtPrice((current) => !current)}
                    quantity={quantity}
                    revealsBoughtPrice={revealsBoughtPrice}
                    soldPriceErrorMessage={soldPriceErrorMessage}
                    soldPriceErrorTestID="single-sell-error-message"
                    soldPriceTestID="single-sell-sold-price"
                    soldPriceText={soldPriceText}
                    stepperTestIDs={{
                      decrement: 'single-sell-decrement',
                      increment: 'single-sell-increment',
                    }}
                    testIDPrefix="single-sell"
                    toggleBoughtPriceTestID="single-sell-toggle-bought-price"
                  />

                  <View style={styles.paymentMethodSection}>
                    <Text
                      style={[theme.typography.caption, styles.paymentMethodHeading]}
                      testID="single-sell-payment-method-heading"
                    >
                      How is buyer paying?
                    </Text>
                    <View style={styles.paymentMethodRow}>
                      {(['cash', 'venmo', 'cashapp', 'paypal', 'zelle'] as const).map((method) => {
                        const isSelected = paymentMethod === method;
                        return (
                          <Pressable
                            accessibilityLabel={`Pay with ${method}`}
                            accessibilityRole="button"
                            disabled={!canInteract}
                            key={method}
                            onPress={() => handlePaymentChipPress(method)}
                            style={({ pressed }) => [
                              styles.paymentMethodChip,
                              isSelected ? styles.paymentMethodChipSelected : null,
                              pressed ? styles.paymentMethodChipPressed : null,
                            ]}
                            testID={`single-sell-payment-method-${method}`}
                          >
                            <Text
                              style={[
                                theme.typography.control,
                                styles.paymentMethodChipLabel,
                                isSelected ? styles.paymentMethodChipLabelSelected : null,
                              ]}
                            >
                              {method}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  <Button
                    contentStyle={styles.tapSellButtonContent}
                    disabled={!canInteract || soldPrice == null}
                    label={
                      soldPrice != null
                        ? `Sell · ${formatCurrency(soldTotal, displayEntry.currencyCode)}`
                        : 'Sell'
                    }
                    onPress={submitSale}
                    size="lg"
                    style={styles.tapSellButton}
                    testID="single-sell-tap-confirm"
                    variant="primary"
                  />
                </SurfaceCard>
              </View>
            </Animated.View>
          </TouchableWithoutFeedback>
        </ScrollView>

        <SellSwipeConfirmationSheet
          bottomInset={insets.bottom}
          disabled={railIsDisabled}
          onAccessibilityConfirm={handleAccessibilityConfirm}
          panHandlers={panResponder.panHandlers}
          prompt={confirmationPrompt}
          promptOpacity={confirmationPromptOpacity}
          promptScale={confirmationPromptScale}
          swipeSheetHeight={swipeSheetHeight}
          testIDPrefix="single-sell"
          translateY={sheetOffset}
          usesDisabledVisual={railUsesDisabledVisual}
        />

        <WalletHandleSetupModal
          initialValue={initialWalletValue}
          method={walletSetupMethod ?? 'cash'}
          onCancel={() => setWalletSetupMethod(null)}
          onSave={handleWalletSetupSave}
          visible={walletSetupMethod != null}
        />
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    left: 0,
    position: 'absolute',
    top: 0,
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
    marginTop: -24,
  },
  centeredHeroBody: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  centeredHeroImage: {
    borderRadius: 18,
    height: 280,
    resizeMode: 'contain',
    width: 196,
  },
  centeredHeroImageWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredHeroMeta: {
    color: colors.textSecondary,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  centeredHeroName: {
    color: colors.textPrimary,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  paymentMethodChip: {
    backgroundColor: colors.surface,
    borderColor: colors.outlineSubtle,
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    minWidth: 64,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  paymentMethodChipLabel: {
    color: colors.textPrimary,
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  paymentMethodChipLabelSelected: {
    color: '#000000',
  },
  paymentMethodChipPressed: {
    opacity: 0.86,
  },
  paymentMethodChipSelected: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  paymentMethodHeading: {
    color: colors.textSecondary,
    marginBottom: 8,
  },
  paymentMethodRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  paymentMethodSection: {
    marginTop: 16,
  },
  tapSellButton: {
    marginTop: 16,
    width: '100%',
  },
  tapSellButtonContent: {
    justifyContent: 'center',
  },
  dismissLayer: {
    flex: 1,
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
  heroChipsWrap: {
    alignItems: 'center',
  },
  heroMetaText: {
    color: 'rgba(15, 15, 18, 0.68)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  heroName: {
    color: 'rgba(15, 15, 18, 0.88)',
    flexShrink: 1,
    fontSize: 28,
    lineHeight: 32,
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
  safeArea: {
    flex: 1,
  },
  topChrome: {
    alignItems: 'center',
    minHeight: 32,
    paddingTop: 4,
    position: 'relative',
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
