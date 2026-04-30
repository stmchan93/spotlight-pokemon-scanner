import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  LayoutAnimation,
  PanResponder,
  type PanResponderGestureState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  Vibration,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  isSpotlightRepositoryRequestError,
  type CatalogSearchResult,
  type InventoryCardEntry,
} from '@spotlight/api-client';
import {
  Button,
  colors,
  SegmentedControl,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  clampRecentCaptureSwipeTranslate,
  recentCaptureDeleteRevealWidth,
  shouldCollapseRecentCaptureDeleteFromSwipe,
  shouldRevealRecentCaptureDeleteFromSwipe,
  shouldSetRecentCaptureSwipeResponder,
} from '@/features/scanner/recent-capture-swipe';
import {
  saveScanCandidateReviewSession,
  type ScanSourceImageCrop,
  type ScanSourceImageDimensions,
} from '@/features/scanner/scan-candidate-review-session';
import {
  buildNormalizedScannerTarget,
  makeOrientationFixedSourceImageDimensions,
  makeReticleSourceImageCrop,
  type NormalizedScannerTarget,
} from '@/features/scanner/scanner-normalized-target';
import {
  chooseRawVisualPictureSize,
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
  rawScannerTrayReservedHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
import { loadRawScannerSmokeFixture } from '@/features/scanner/scanner-smoke-fixtures';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeBoolean, resolveRuntimeValue } from '@/lib/runtime-config';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

type ScannerMode = 'raw' | 'slabs';

type RecentCapture = {
  candidates: CatalogSearchResult[];
  hasTrackedSelectionEvent: boolean;
  id: string;
  isAddingToInventory: boolean;
  isLoadingCandidates: boolean;
  matchReviewDisposition: string | null;
  matchReviewReason: string | null;
  mode: ScannerMode;
  normalizedImageDimensions: ScanSourceImageDimensions | null;
  normalizedImageUri: string | null;
  scanID: string | null;
  sourceImageCrop: ScanSourceImageCrop | null;
  sourceImageDimensions: ScanSourceImageDimensions | null;
  sourceImageRotationDegrees: number;
  uri: string;
  activeCandidateIndex: number;
};

type CaptureMatchParams = {
  captureId: string;
  captureMs: number;
  captureSource: 'camera' | 'smoke_fixture';
  mode: ScannerMode;
  normalizeMs: number;
  normalizedTarget: NormalizedScannerTarget;
  rawSourceImageDimensions: ScanSourceImageDimensions;
  scanStartedAt: number;
  sourceImageDimensions: ScanSourceImageDimensions;
};

const scannerModes: readonly { label: string; value: ScannerMode }[] = [
  { label: 'RAW', value: 'raw' },
  { label: 'SLABS', value: 'slabs' },
];

const maxStoredCaptures = 12;
const collapsedVisibleCaptures = 1;
const captureRowHeight = 74;
const captureRowGap = 8;
const traySwipeThreshold = 20;
const trayVelocityThreshold = 0.22;
const scannerTrayLayoutAnimation = {
  create: {
    property: LayoutAnimation.Properties.opacity,
    type: LayoutAnimation.Types.easeInEaseOut,
  },
  delete: {
    property: LayoutAnimation.Properties.opacity,
    type: LayoutAnimation.Types.easeInEaseOut,
  },
  duration: 240,
  update: {
    springDamping: 0.88,
    type: LayoutAnimation.Types.easeInEaseOut,
  },
} as const;

function scannerErrorMessage(error: unknown) {
  if (isSpotlightRepositoryRequestError(error)) {
    return `${error.kind}:${error.status ?? 'n/a'}:${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown scanner error';
}

function scannerErrorKind(error: unknown) {
  if (isSpotlightRepositoryRequestError(error)) {
    return error.kind;
  }

  if (error instanceof Error) {
    const trimmedMessage = error.message.trim();
    if (/^[a-z0-9_:-]+$/i.test(trimmedMessage) && trimmedMessage.length > 0) {
      return trimmedMessage;
    }

    return error.name || error.constructor.name || 'Error';
  }

  return 'UnknownError';
}

function logScannerDiagnostic(message: string, error?: unknown) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  // Keep scanner failures out of React Native LogBox. These are expected runtime
  // failures when the network/auth/backend flakes and should not appear as UI.
  const suffix = error ? ` native=${scannerErrorMessage(error)}` : '';
  console.info(`${message}${suffix}`);
}

function alignToFourPointGrid(value: number) {
  return Math.max(0, Math.round(value / 4) * 4);
}

function capturePrimaryLabel(mode: ScannerMode) {
  return mode === 'slabs' ? 'SLAB scan' : 'RAW scan';
}

function captureFailureSubtitle(capture: RecentCapture) {
  const reviewReason = capture.matchReviewReason?.trim();
  if (reviewReason) {
    return reviewReason;
  }

  return 'Photo captured, but matches could not load';
}

function activeCandidateForCapture(capture: RecentCapture) {
  return capture.candidates[capture.activeCandidateIndex] ?? null;
}

function buildScanSelectionProperties(capture: RecentCapture) {
  return {
    candidate_count: capture.candidates.length,
    mode: capture.mode,
    selection_rank: capture.activeCandidateIndex + 1,
  };
}

function buildScanMatchSuccessProperties(params: {
  candidateCount: number;
  mode: ScannerMode;
  requestAttemptCount?: number | null;
  reviewDisposition?: string | null;
  roundTripMs?: number | null;
  serverProcessingMs?: number | null;
}) {
  const properties: Record<string, number | string> = {
    candidate_count: params.candidateCount,
    mode: params.mode,
  };

  if (typeof params.requestAttemptCount === 'number') {
    properties.request_attempt_count = params.requestAttemptCount;
  }

  if (typeof params.reviewDisposition === 'string' && params.reviewDisposition.length > 0) {
    properties.review_disposition = params.reviewDisposition;
  }

  if (typeof params.roundTripMs === 'number') {
    properties.round_trip_ms = params.roundTripMs;
  }

  if (typeof params.serverProcessingMs === 'number') {
    properties.server_processing_ms = params.serverProcessingMs;
  }

  return properties;
}

function formatCurrency(amount: number, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function withOptimisticInventoryAdd(
  entries: InventoryCardEntry[],
  candidate: CatalogSearchResult,
  addedAt: string,
): InventoryCardEntry[] {
  const existingIndex = entries.findIndex((entry) => (
    entry.cardId === candidate.cardId
    && entry.kind === 'raw'
    && (entry.conditionCode ?? 'near_mint') === 'near_mint'
    && !entry.variantName
  ));

  if (existingIndex >= 0) {
    return entries.map((entry, index) => (
      index === existingIndex
        ? { ...entry, quantity: entry.quantity + 1 }
        : entry
    ));
  }

  return [
    {
      addedAt,
      cardId: candidate.cardId,
      cardNumber: candidate.cardNumber,
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: 0,
      currencyCode: candidate.currencyCode ?? 'USD',
      hasMarketPrice: candidate.marketPrice != null,
      id: `optimistic|raw|${candidate.cardId}`,
      imageUrl: candidate.imageUrl,
      kind: 'raw',
      marketPrice: candidate.marketPrice ?? 0,
      name: candidate.name,
      quantity: 1,
      setName: candidate.setName,
      slabContext: null,
      variantName: null,
    },
    ...entries,
  ];
}


async function triggerScannerHaptic() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  try {
    const Haptics = await import('expo-haptics');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    if (Platform.OS !== 'web') {
      Vibration.vibrate(10);
    }
  }
}

type RecentCaptureSwipeRowProps = {
  children: ReactNode;
  onDelete: () => void;
  testID: string;
};

function RecentCaptureSwipeRow({ children, onDelete, testID }: RecentCaptureSwipeRowProps) {
  const [isDeleteRevealed, setIsDeleteRevealed] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const deleteOpacity = useMemo(() => translateX.interpolate({
    extrapolate: 'clamp',
    inputRange: [0, 1],
    outputRange: [0, 1],
  }), [translateX]);

  const settleClosed = useCallback(() => {
    setIsDeleteRevealed(false);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 16,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  const revealDeleteAction = useCallback(() => {
    setIsDeleteRevealed(true);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 18,
      toValue: recentCaptureDeleteRevealWidth,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  const handleSwipeMove = useCallback((gestureState: PanResponderGestureState) => {
    translateX.setValue(clampRecentCaptureSwipeTranslate(gestureState.dx, isDeleteRevealed));
  }, [isDeleteRevealed, translateX]);

  const handleSwipeEnd = useCallback((gestureState: PanResponderGestureState) => {
    if (isDeleteRevealed) {
      if (shouldCollapseRecentCaptureDeleteFromSwipe(gestureState)) {
        settleClosed();
        return;
      }

      revealDeleteAction();
      return;
    }

    if (shouldRevealRecentCaptureDeleteFromSwipe(gestureState)) {
      revealDeleteAction();
      return;
    }

    settleClosed();
  }, [isDeleteRevealed, revealDeleteAction, settleClosed]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => shouldSetRecentCaptureSwipeResponder(gestureState, isDeleteRevealed),
    onPanResponderMove: (_, gestureState) => handleSwipeMove(gestureState),
    onPanResponderRelease: (_, gestureState) => handleSwipeEnd(gestureState),
    onPanResponderTerminate: () => {
      settleClosed();
    },
  }), [handleSwipeEnd, handleSwipeMove, isDeleteRevealed, settleClosed]);

  return (
    <View
      style={styles.captureSwipeShell}
      testID={testID}
      {...panResponder.panHandlers}
    >
      {process.env.NODE_ENV === 'test' ? (
        <>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={revealDeleteAction}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-reveal-delete`}
          />
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={settleClosed}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-collapse-delete`}
          />
        </>
      ) : null}
      <Animated.View
        pointerEvents={isDeleteRevealed ? 'auto' : 'none'}
        style={[styles.captureDeleteUnderlay, { opacity: deleteOpacity }]}
        testID={`${testID}-delete-underlay`}
      >
        <Pressable
          accessibilityElementsHidden={!isDeleteRevealed}
          accessibilityLabel="Delete recent scan"
          accessibilityRole="button"
          accessibilityState={{ disabled: !isDeleteRevealed }}
          importantForAccessibility={isDeleteRevealed ? 'auto' : 'no-hide-descendants'}
          onPress={isDeleteRevealed ? onDelete : undefined}
          style={({ pressed }) => [
            styles.captureDeleteButton,
            pressed ? styles.captureDeleteUnderlayPressed : null,
          ]}
          testID={`${testID}-delete-button`}
        >
          <Text style={styles.captureDeleteLabel}>DELETE</Text>
        </Pressable>
      </Animated.View>
      <Animated.View style={[styles.captureSwipeContent, { transform: [{ translateX }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

function RefreshIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 18 18" width={size}>
      <Path
        d="M14.6 8.25A5.6 5.6 0 1 1 12.9 4.2"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      <Path
        d="M11.95 2.9H14.9V5.85"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </Svg>
  );
}

export function ScannerScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { currentUser } = useAuth();
  const { dataVersion, refreshData, spotlightRepository } = useAppServices();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [scannerMode, setScannerMode] = useState<ScannerMode>('raw');
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryCardEntry[]>([]);
  const [recentCaptures, setRecentCaptures] = useState<RecentCapture[]>([]);
  const [isTrayExpanded, setIsTrayExpanded] = useState(false);
  const [rawVisualPictureSize, setRawVisualPictureSize] = useState<string | undefined>(undefined);
  const [cameraSessionKey, setCameraSessionKey] = useState(0);
  const hasFocusedScannerRef = useRef(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<CameraView | null>(null);
  const isResolvingPictureSizeRef = useRef(false);
  const trayGestureCommittedRef = useRef(false);
  const reticleSnapshotRef = useRef({ height: 0, previewHeight: 0, previewWidth: 0, width: 0, x: 0, y: 0 });

  const trayBottomInset = insets.bottom + 14;
  const captureSurfaceLayout = makeRawScannerCaptureLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    safeAreaTop: insets.top,
    trayReservedHeight: rawScannerTrayReservedHeight,
  });
  const runtimeAppEnv = resolveRuntimeValue([], ['spotlightAppEnv']);
  reticleSnapshotRef.current = {
    height: captureSurfaceLayout.reticle.height,
    previewHeight: captureSurfaceLayout.previewHeight,
    previewWidth: captureSurfaceLayout.previewWidth,
    width: captureSurfaceLayout.reticle.width,
    x: captureSurfaceLayout.reticle.x,
    y: captureSurfaceLayout.reticle.y,
  };
  const hasCameraAccess = permission?.granted ?? false;
  const canStartLabelingSession = !!(currentUser?.labelerEnabled || currentUser?.adminEnabled);
  const scannerSmokeEnabled = resolveRuntimeBoolean(
    ['EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED'],
    ['spotlightScannerSmokeEnabled'],
  ) && (runtimeAppEnv === 'staging' || __DEV__);
  const canCapture = hasCameraAccess && isCameraReady && !isCapturing;
  const canToggleTray = recentCaptures.length > 0;
  const collapsedCaptures = recentCaptures.slice(0, collapsedVisibleCaptures);
  const visibleCaptures = isTrayExpanded ? recentCaptures : collapsedCaptures;
  const trayExpandedBodyHeight = alignToFourPointGrid(
    Math.min(Math.max((windowHeight - insets.top - insets.bottom) * 0.5, 272), 428),
  );
  const trayScrollViewportHeight = Math.max(140, trayExpandedBodyHeight);
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight) + ((recentCaptures.length - 1) * captureRowGap);
  const trayScrollEnabled = trayContentHeight > trayScrollViewportHeight;
  const shouldLoadInventory = recentCaptures.length > 0 || dataVersion > 0;

  useEffect(() => {
    if (!shouldLoadInventory) {
      return undefined;
    }

    let isActive = true;

    const loadInventoryEntries = async () => {
      try {
        const nextEntries = await spotlightRepository.getInventoryEntries();
        if (isActive) {
          setInventoryEntries(nextEntries);
        }
      } catch {
        if (isActive) {
          setInventoryEntries([]);
        }
      }
    };

    void loadInventoryEntries();

    return () => {
      isActive = false;
    };
  }, [dataVersion, shouldLoadInventory, spotlightRepository]);

  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain || hasPromptedForPermissionRef.current) {
      return;
    }

    hasPromptedForPermissionRef.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      UIManager.setLayoutAnimationEnabledExperimental?.(true);
    }
  }, []);

  useEffect(() => {
    if (recentCaptures.length === 0 && isTrayExpanded) {
      setIsTrayExpanded(false);
    }
  }, [isTrayExpanded, recentCaptures.length]);

  useFocusEffect(useCallback(() => {
    trayGestureCommittedRef.current = false;
    isResolvingPictureSizeRef.current = false;

    if (hasFocusedScannerRef.current) {
      setIsCameraReady(false);
      setIsCapturing(false);
      setRawVisualPictureSize(undefined);
      setCameraSessionKey((current) => current + 1);
    } else {
      hasFocusedScannerRef.current = true;
    }

    return () => {
      trayGestureCommittedRef.current = false;
      isResolvingPictureSizeRef.current = false;
      setIsCameraReady(false);
      setIsCapturing(false);
    };
  }, []));

  const commitTrayExpandedState = useCallback((nextExpanded: boolean) => {
    setIsTrayExpanded((current) => {
      if (current === nextExpanded) {
        return current;
      }

      if (Platform.OS !== 'web') {
        LayoutAnimation.configureNext(scannerTrayLayoutAnimation);
      }

      return nextExpanded;
    });
  }, []);

  const resolveRawVisualPictureSize = useCallback(() => {
    if (isResolvingPictureSizeRef.current) {
      return;
    }

    isResolvingPictureSizeRef.current = true;
    void (async () => {
      try {
        const sizes = await cameraRef.current?.getAvailablePictureSizesAsync?.();
        const selectedSize = chooseRawVisualPictureSize(Array.isArray(sizes) ? sizes : []);
        setRawVisualPictureSize(selectedSize ?? undefined);
        if (selectedSize && process.env.NODE_ENV !== 'test') {
          console.info(`[SCANNER VISUAL TEST] rawPictureSize=${selectedSize}`);
        }
      } catch {
        setRawVisualPictureSize(undefined);
      } finally {
        isResolvingPictureSizeRef.current = false;
      }
    })();
  }, []);

  const inventoryByCardId = useMemo(() => {
    const lookup = new Map<string, { entryIds: string[]; quantity: number }>();

    inventoryEntries.forEach((entry) => {
      const current = lookup.get(entry.cardId);
      if (current) {
        current.quantity += entry.quantity;
        current.entryIds.push(entry.id);
        return;
      }

      lookup.set(entry.cardId, {
        entryIds: [entry.id],
        quantity: entry.quantity,
      });
    });

    return lookup;
  }, [inventoryEntries]);

  const trayValue = useMemo(() => {
    return recentCaptures.reduce((sum, capture) => {
      return sum + (activeCandidateForCapture(capture)?.marketPrice ?? 0);
    }, 0);
  }, [recentCaptures]);

  const clearRecentCaptures = useCallback(() => {
    setRecentCaptures([]);
    setIsTrayExpanded(false);
  }, []);

  const deleteRecentCapture = useCallback((captureId: string) => {
    setRecentCaptures((current) => current.filter((capture) => capture.id !== captureId));
  }, []);

  const updateRecentCapture = useCallback((
    captureId: string,
    transform: (capture: RecentCapture) => RecentCapture,
  ) => {
    setRecentCaptures((current) => current.map((capture) => (
      capture.id === captureId ? transform(capture) : capture
    )));
  }, []);

  const trackCandidateSelectionIfNeeded = useCallback((capture: RecentCapture) => {
    if (capture.hasTrackedSelectionEvent) {
      return;
    }

    capturePostHogEvent('scan_candidate_selected', buildScanSelectionProperties(capture));
    updateRecentCapture(capture.id, (current) => {
      if (current.hasTrackedSelectionEvent) {
        return current;
      }

      return {
        ...current,
        hasTrackedSelectionEvent: true,
      };
    });
  }, [updateRecentCapture]);

  const runMatchForCapture = useCallback(async ({
    captureId,
    captureMs,
    captureSource,
    mode,
    normalizeMs,
    normalizedTarget,
    rawSourceImageDimensions,
    scanStartedAt,
    sourceImageDimensions,
  }: CaptureMatchParams) => {
    try {
      capturePostHogEvent('scan_match_requested', {
        mode,
      });
      const matchStartedAt = Date.now();
      const estimatedPayloadKB = Math.round((normalizedTarget.normalizedImageBase64.length * 0.75) / 1024);
      if (mode === 'raw' && process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] dispatch `
          + `captureSource=${captureSource} `
          + `nativeSource=${normalizedTarget.nativeSourceImageDimensions.width}x${normalizedTarget.nativeSourceImageDimensions.height} `
          + `rotate=${normalizedTarget.normalizationRotationDegrees} `
          + `normalized=${normalizedTarget.normalizedImageDimensions.width}x${normalizedTarget.normalizedImageDimensions.height} `
          + `payloadKB=${estimatedPayloadKB} `
          + `quality=${captureSource === 'camera' ? rawVisualCaptureQuality : 'fixture'}`,
        );
      }
      const matchResult = await spotlightRepository.matchScannerCapture({
        height: normalizedTarget.normalizedImageDimensions.height,
        jpegBase64: normalizedTarget.normalizedImageBase64,
        mode,
        width: normalizedTarget.normalizedImageDimensions.width,
      });
      if (mode === 'raw' && process.env.NODE_ENV !== 'test') {
        const clientMatchMs = Date.now() - matchStartedAt;
        const endToEndMs = Date.now() - scanStartedAt;
        console.info(
          `[SCANNER VISUAL TEST] captureMs=${captureMs} `
          + `captureSource=${captureSource} `
          + `source=${rawSourceImageDimensions.width}x${rawSourceImageDimensions.height} `
          + `oriented=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `nativeSource=${normalizedTarget.nativeSourceImageDimensions.width}x${normalizedTarget.nativeSourceImageDimensions.height} `
          + `rotate=${normalizedTarget.normalizationRotationDegrees} `
          + `crop=${normalizedTarget.sourceImageCrop.width}x${normalizedTarget.sourceImageCrop.height} `
          + `normalized=${normalizedTarget.normalizedImageDimensions.width}x${normalizedTarget.normalizedImageDimensions.height} `
          + `payloadKB=${estimatedPayloadKB} `
          + `quality=${captureSource === 'camera' ? rawVisualCaptureQuality : 'fixture'} `
          + `normalizeMs=${normalizeMs} `
          + `matchMs=${clientMatchMs} `
          + `endpoint=/${matchResult.endpointPath ?? 'unknown'} `
          + `requestUrl=${matchResult.requestUrl ?? 'n/a'} `
          + `attempts=${matchResult.requestAttemptCount ?? 'n/a'} `
          + `serverMs=${matchResult.serverProcessingMs ?? 'n/a'} `
          + `roundTripMs=${matchResult.roundTripMs ?? 'n/a'} `
          + `endToEndMs=${endToEndMs} `
          + `candidates=${matchResult.candidates.length}`,
        );
      }

      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        activeCandidateIndex: 0,
        candidates: matchResult.candidates,
        isLoadingCandidates: false,
        matchReviewDisposition: matchResult.reviewDisposition ?? null,
        matchReviewReason: matchResult.reviewReason ?? null,
        normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
        normalizedImageUri: normalizedTarget.normalizedImageUri,
        scanID: matchResult.scanID,
        sourceImageCrop: normalizedTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: normalizedTarget.normalizationRotationDegrees,
        uri: normalizedTarget.normalizedImageUri,
      }));
      capturePostHogEvent('scan_match_succeeded', buildScanMatchSuccessProperties({
        candidateCount: matchResult.candidates.length,
        mode,
        requestAttemptCount: matchResult.requestAttemptCount,
        reviewDisposition: matchResult.reviewDisposition,
        roundTripMs: matchResult.roundTripMs,
        serverProcessingMs: matchResult.serverProcessingMs,
      }));
    } catch (error) {
      if (mode === 'raw') {
        logScannerDiagnostic(
          `[SCANNER VISUAL TEST] matchError `
          + `message=${scannerErrorMessage(error)} `
          + `captureSource=${captureSource} `
          + `nativeSource=${normalizedTarget.nativeSourceImageDimensions.width}x${normalizedTarget.nativeSourceImageDimensions.height} `
          + `rotate=${normalizedTarget.normalizationRotationDegrees} `
          + `normalized=${normalizedTarget.normalizedImageDimensions.width}x${normalizedTarget.normalizedImageDimensions.height} `
          + `payloadKB=${Math.round((normalizedTarget.normalizedImageBase64.length * 0.75) / 1024)}`,
          error,
        );
      }

      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        candidates: [],
        isLoadingCandidates: false,
        matchReviewDisposition: null,
        matchReviewReason: null,
        normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
        normalizedImageUri: normalizedTarget.normalizedImageUri,
        scanID: null,
        sourceImageCrop: normalizedTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: normalizedTarget.normalizationRotationDegrees,
        uri: normalizedTarget.normalizedImageUri,
      }));
      capturePostHogEvent('scan_match_failed', {
        error_kind: scannerErrorKind(error),
        mode,
      });
    }
  }, [spotlightRepository, updateRecentCapture]);

  const handleCapture = useCallback(async () => {
    if (!permission?.granted) {
      if (permission?.canAskAgain) {
        await requestPermission();
      }
      return;
    }

    if (!cameraRef.current || !isCameraReady || isCapturing) {
      return;
    }

    void triggerScannerHaptic();
    capturePostHogEvent('scan_capture_started', {
      mode: scannerMode,
    });
    const scanStartedAt = Date.now();
    setIsCapturing(true);

    const captureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRecentCaptures((current) => [
      {
        activeCandidateIndex: 0,
        candidates: [],
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
        matchReviewDisposition: null,
        matchReviewReason: null,
        mode: scannerMode,
        normalizedImageDimensions: null,
        normalizedImageUri: null,
        scanID: null,
        sourceImageCrop: null,
        sourceImageDimensions: null,
        sourceImageRotationDegrees: 0,
        uri: '',
      },
      ...current,
    ].slice(0, maxStoredCaptures));

    let capturedPhotoUri = '';
    let capturedSourceImageCrop: ScanSourceImageCrop | null = null;
    let capturedSourceImageDimensions: ScanSourceImageDimensions | null = null;

    try {
      const captureStartedAt = Date.now();
      const photo = await cameraRef.current.takePictureAsync({
        exif: false,
        quality: scannerMode === 'raw' ? rawVisualCaptureQuality : 0.7,
        skipProcessing: false,
      });
      const captureMs = Date.now() - captureStartedAt;

      setIsCapturing(false);

      if (!photo?.uri) {
        capturePostHogEvent('scan_match_failed', {
          error_kind: 'source_capture_unavailable',
          mode: scannerMode,
        });
        setRecentCaptures((current) => current.map((capture) => {
          if (capture.id !== captureId) {
            return capture;
          }

          return {
            ...capture,
            isLoadingCandidates: false,
            normalizedImageDimensions: null,
            normalizedImageUri: null,
            matchReviewDisposition: null,
            matchReviewReason: null,
            sourceImageCrop: null,
            sourceImageDimensions: photo?.width && photo.height
              ? { height: photo.height, width: photo.width }
              : null,
            sourceImageRotationDegrees: 0,
            uri: photo?.uri ?? '',
          };
        }));
        return;
      }

      capturedPhotoUri = photo.uri;
      const rawSourceImageDimensions: ScanSourceImageDimensions = {
        height: photo.height ?? 1,
        width: photo.width ?? 1,
      };
      const sourceImageDimensions = makeOrientationFixedSourceImageDimensions(rawSourceImageDimensions);
      capturedSourceImageDimensions = sourceImageDimensions;
      const sourceImageCrop = makeReticleSourceImageCrop({
        previewLayout: {
          height: reticleSnapshotRef.current.previewHeight,
          width: reticleSnapshotRef.current.previewWidth,
        },
        reticle: {
          height: reticleSnapshotRef.current.height,
          width: reticleSnapshotRef.current.width,
          x: reticleSnapshotRef.current.x,
          y: reticleSnapshotRef.current.y,
        },
        sourceImageDimensions,
      });
      capturedSourceImageCrop = sourceImageCrop;

      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          matchReviewDisposition: null,
          matchReviewReason: null,
          normalizedImageDimensions: null,
          normalizedImageUri: null,
          sourceImageCrop,
          sourceImageDimensions,
          sourceImageRotationDegrees: 0,
          uri: photo.uri,
        };
      }));

      const normalizeStartedAt = Date.now();
      if (scannerMode === 'raw' && process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] normalizeStart `
          + `reportedSource=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `preview=${reticleSnapshotRef.current.previewWidth}x${reticleSnapshotRef.current.previewHeight} `
          + `reticle=${reticleSnapshotRef.current.width}x${reticleSnapshotRef.current.height}@${reticleSnapshotRef.current.x},${reticleSnapshotRef.current.y} `
          + `crop=${sourceImageCrop ? `${sourceImageCrop.width}x${sourceImageCrop.height}@${sourceImageCrop.x},${sourceImageCrop.y}` : 'n/a'}`,
        );
      }
      const normalizedTarget = await buildNormalizedScannerTarget({
        previewLayout: {
          height: reticleSnapshotRef.current.previewHeight,
          width: reticleSnapshotRef.current.previewWidth,
        },
        reticle: {
          height: reticleSnapshotRef.current.height,
          width: reticleSnapshotRef.current.width,
          x: reticleSnapshotRef.current.x,
          y: reticleSnapshotRef.current.y,
        },
        sourceImageDimensions,
        sourceImageUri: photo.uri,
      });
      const normalizeMs = Date.now() - normalizeStartedAt;
      if (!normalizedTarget) {
        throw new Error('normalized_target_unavailable');
      }

      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
          normalizedImageUri: normalizedTarget.normalizedImageUri,
          sourceImageCrop: normalizedTarget.sourceImageCrop,
          sourceImageDimensions,
          sourceImageRotationDegrees: normalizedTarget.normalizationRotationDegrees,
          uri: photo.uri,
        };
      }));

      void runMatchForCapture({
        captureId,
        captureMs,
        captureSource: 'camera',
        mode: scannerMode,
        normalizeMs,
        normalizedTarget,
        rawSourceImageDimensions,
        scanStartedAt,
        sourceImageDimensions,
      });
    } catch (error) {
      if (scannerMode === 'raw') {
        logScannerDiagnostic(
          `[SCANNER VISUAL TEST] capturePrepError `
          + `message=${scannerErrorMessage(error)} `
          + `photoUri=${capturedPhotoUri || 'n/a'} `
          + `source=${capturedSourceImageDimensions ? `${capturedSourceImageDimensions.width}x${capturedSourceImageDimensions.height}` : 'n/a'} `
          + `crop=${capturedSourceImageCrop ? `${capturedSourceImageCrop.width}x${capturedSourceImageCrop.height}@${capturedSourceImageCrop.x},${capturedSourceImageCrop.y}` : 'n/a'}`,
          error,
        );
      }
      capturePostHogEvent('scan_match_failed', {
        error_kind: scannerErrorKind(error),
        mode: scannerMode,
      });
      setIsCapturing(false);
      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          isLoadingCandidates: false,
          matchReviewDisposition: null,
          matchReviewReason: null,
          normalizedImageDimensions: null,
          normalizedImageUri: null,
          sourceImageCrop: capturedSourceImageCrop,
          sourceImageDimensions: capturedSourceImageDimensions,
          sourceImageRotationDegrees: 0,
          uri: capturedPhotoUri,
        };
      }));
    }
  }, [
    isCameraReady,
    isCapturing,
    permission,
    requestPermission,
    scannerMode,
    runMatchForCapture,
  ]);

  const handleTriggerSmokeFixture = useCallback(async () => {
    if (!scannerSmokeEnabled || scannerMode !== 'raw' || isCapturing) {
      return;
    }

    void triggerScannerHaptic();
    capturePostHogEvent('scan_capture_started', {
      mode: 'raw',
    });
    const scanStartedAt = Date.now();
    setIsCapturing(true);

    const captureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRecentCaptures((current) => [
      {
        activeCandidateIndex: 0,
        candidates: [],
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
        matchReviewDisposition: null,
        matchReviewReason: null,
        mode: 'raw' as const,
        normalizedImageDimensions: null,
        normalizedImageUri: null,
        scanID: null,
        sourceImageCrop: null,
        sourceImageDimensions: null,
        sourceImageRotationDegrees: 0,
        uri: '',
      },
      ...current,
    ].slice(0, maxStoredCaptures));

    try {
      const normalizedTarget = await loadRawScannerSmokeFixture();
      const sourceImageDimensions = normalizedTarget.normalizedImageDimensions;
      setIsCapturing(false);

      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
        normalizedImageUri: normalizedTarget.normalizedImageUri,
        sourceImageCrop: normalizedTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: normalizedTarget.normalizationRotationDegrees,
        uri: normalizedTarget.normalizedImageUri,
      }));

      void runMatchForCapture({
        captureId,
        captureMs: 0,
        captureSource: 'smoke_fixture',
        mode: 'raw',
        normalizeMs: 0,
        normalizedTarget,
        rawSourceImageDimensions: normalizedTarget.normalizedImageDimensions,
        scanStartedAt,
        sourceImageDimensions,
      });
    } catch (error) {
      logScannerDiagnostic(
        `[SCANNER SMOKE] fixturePrepError message=${scannerErrorMessage(error)}`,
        error,
      );
      setIsCapturing(false);
      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        isLoadingCandidates: false,
        matchReviewDisposition: 'unsupported',
        matchReviewReason: 'Scanner smoke fixture could not load.',
      }));
      capturePostHogEvent('scan_match_failed', {
        error_kind: scannerErrorKind(error),
        mode: 'raw',
      });
    }
  }, [isCapturing, scannerMode, scannerSmokeEnabled, runMatchForCapture, updateRecentCapture]);

  const cycleCandidate = useCallback((captureId: string) => {
    setRecentCaptures((current) => current.map((capture) => {
      if (capture.id !== captureId || capture.candidates.length <= 1) {
        return capture;
      }

      return {
        ...capture,
        activeCandidateIndex: (capture.activeCandidateIndex + 1) % capture.candidates.length,
      };
    }));
  }, []);

  const handleAddToInventory = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((candidate) => candidate.id === captureId);
    const activeCandidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !activeCandidate || capture.isLoadingCandidates || capture.isAddingToInventory) {
      return;
    }

    setRecentCaptures((current) => current.map((entry) => {
      if (entry.id !== captureId) {
        return entry;
      }

      return {
        ...entry,
        isAddingToInventory: true,
      };
    }));

    const addedAt = new Date().toISOString();
    let previousInventoryEntries: InventoryCardEntry[] = [];
    setInventoryEntries((current) => {
      previousInventoryEntries = current;
      return withOptimisticInventoryAdd(current, activeCandidate, addedAt);
    });

    try {
      trackCandidateSelectionIfNeeded(capture);
      await spotlightRepository.createInventoryEntry({
        addedAt,
        cardID: activeCandidate.cardId,
        condition: 'near_mint',
        quantity: 1,
        selectedRank: capture.activeCandidateIndex + 1,
        selectionSource: capture.activeCandidateIndex === 0 ? 'top' : 'alternate',
        slabContext: null,
        sourceScanID: capture.scanID ?? null,
        variantName: null,
        wasTopPrediction: capture.activeCandidateIndex === 0,
      });
      capturePostHogEvent('scan_inventory_add_succeeded', {
        mode: capture.mode,
      });
      const nextEntries = await spotlightRepository.getInventoryEntries();
      setInventoryEntries(nextEntries);
      refreshData();
    } catch (error) {
      setInventoryEntries(previousInventoryEntries);
      capturePostHogEvent('scan_inventory_add_failed', {
        error_kind: scannerErrorKind(error),
        mode: capture.mode,
      });
      logScannerDiagnostic(`[SCANNER] addToInventory failed: ${scannerErrorMessage(error)}`, error);
    } finally {
      setRecentCaptures((current) => current.map((entry) => {
        if (entry.id !== captureId) {
          return entry;
        }

        return {
          ...entry,
          isAddingToInventory: false,
        };
      }));
    }
  }, [recentCaptures, refreshData, spotlightRepository, trackCandidateSelectionIfNeeded]);

  const handleOpenCard = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !candidate || capture.isLoadingCandidates) {
      return;
    }

    const matchingInventoryEntries = inventoryByCardId.get(candidate.cardId)?.entryIds ?? [];
    const scanReviewId = saveScanCandidateReviewSession({
      candidates: capture.candidates,
      id: capture.id,
      normalizedImageDimensions: capture.normalizedImageDimensions,
      normalizedImageUri: capture.normalizedImageUri,
      selectedCardId: candidate.cardId,
      sourceImageCrop: capture.sourceImageCrop,
      sourceImageDimensions: capture.sourceImageDimensions,
      sourceImageRotationDegrees: capture.sourceImageRotationDegrees,
      sourceImageUri: capture.uri || null,
    });
    trackCandidateSelectionIfNeeded(capture);
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: candidate.cardId,
        entryId: matchingInventoryEntries[0],
        scanReviewId,
      },
    });
  }, [inventoryByCardId, recentCaptures, router, trackCandidateSelectionIfNeeded]);

  const toggleTrayExpanded = useCallback(() => {
    if (!canToggleTray) {
      return;
    }

    commitTrayExpandedState(!isTrayExpanded);
  }, [canToggleTray, commitTrayExpandedState, isTrayExpanded]);

  const handleExitScanner = useCallback(() => {
    router.replace('/portfolio');
  }, [router]);

  const handleOpenLabelingSession = useCallback(() => {
    router.push('/labeling/session');
  }, [router]);

  const trayHeaderPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) =>
      Math.abs(gestureState.dy) > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
    onPanResponderGrant: () => {
      trayGestureCommittedRef.current = false;
    },
    onPanResponderMove: (_, gestureState) => {
      if (trayGestureCommittedRef.current) {
        return;
      }

      const shouldExpand = canToggleTray
        && !isTrayExpanded
        && gestureState.dy <= -traySwipeThreshold;
      const shouldCollapse = isTrayExpanded
        && gestureState.dy >= traySwipeThreshold;

      if (shouldExpand) {
        trayGestureCommittedRef.current = true;
        commitTrayExpandedState(true);
        return;
      }

      if (shouldCollapse) {
        trayGestureCommittedRef.current = true;
        commitTrayExpandedState(false);
      }
    },
    onPanResponderRelease: (_, gestureState) => {
      if (trayGestureCommittedRef.current) {
        trayGestureCommittedRef.current = false;
        return;
      }

      const shouldExpand = canToggleTray
        && !isTrayExpanded
        && (gestureState.dy <= -traySwipeThreshold || gestureState.vy <= -trayVelocityThreshold);
      const shouldCollapse = isTrayExpanded
        && (gestureState.dy >= traySwipeThreshold || gestureState.vy >= trayVelocityThreshold);

      if (shouldExpand) {
        commitTrayExpandedState(true);
        return;
      }
      if (shouldCollapse) {
        commitTrayExpandedState(false);
        return;
      }
    },
    onPanResponderTerminate: () => {
      trayGestureCommittedRef.current = false;
    },
    onPanResponderTerminationRequest: () => false,
  }), [canToggleTray, commitTrayExpandedState, isTrayExpanded]);

  const promptCopy = !permission
    ? 'Starting camera...'
    : !permission.granted
      ? 'Allow camera access to scan'
      : isCapturing
        ? 'Capturing scan...'
        : 'Tap inside frame to scan';

  const renderCaptureRow = (capture: RecentCapture, index: number) => {
    const candidate = activeCandidateForCapture(capture);
    const inventoryMatch = candidate ? inventoryByCardId.get(candidate.cardId) : null;
    const quantity = inventoryMatch?.quantity ?? 0;
    const marketPrice = candidate?.marketPrice ?? 0;
    const currencyCode = candidate?.currencyCode ?? 'USD';
    const canCycleCandidate = !!candidate && capture.candidates.length > 1;

    return (
      <RecentCaptureSwipeRow
        key={capture.id}
        onDelete={() => {
          deleteRecentCapture(capture.id);
        }}
        testID={`scanner-tray-swipe-${index}`}
      >
        <View style={styles.captureRow} testID={`scanner-tray-row-${index}`}>
          <Pressable
            accessibilityLabel={canCycleCandidate ? `Refresh match for ${candidate?.name ?? `recent scan ${index + 1}`}` : undefined}
            accessibilityRole={canCycleCandidate ? 'button' : undefined}
            disabled={!canCycleCandidate}
            onPress={() => {
              if (canCycleCandidate) {
                cycleCandidate(capture.id);
              }
            }}
            style={({ pressed }) => [
              styles.captureThumbPressable,
              pressed && canCycleCandidate ? styles.captureThumbPressed : null,
            ]}
            testID={`scanner-tray-thumb-${index}`}
          >
            {candidate?.imageUrl || capture.uri ? (
              <Image
                source={{ uri: candidate?.imageUrl || capture.uri }}
                style={styles.captureThumb}
                testID={`scanner-tray-image-${index}`}
              />
            ) : (
              <View style={styles.captureThumb} testID={`scanner-tray-image-${index}`} />
            )}
            {canCycleCandidate ? (
              <Pressable
                accessibilityLabel="Refresh match"
                onPress={() => {
                  cycleCandidate(capture.id);
                }}
                style={styles.captureRefreshButton}
                testID={`scanner-tray-refresh-${index}`}
                hitSlop={10}
              >
                {({ pressed }) => (
                  <View style={[styles.captureRefreshChip, pressed ? styles.captureRefreshPressed : null]}>
                    <RefreshIcon color="#FFFFFF" size={16} />
                  </View>
                )}
              </Pressable>
            ) : null}
          </Pressable>

          <Pressable
            accessibilityLabel={candidate ? `Open ${candidate.name}` : `Open recent scan ${index + 1}`}
            accessibilityRole="button"
            onPress={() => {
              void handleOpenCard(capture.id);
            }}
            style={({ pressed }) => [
              styles.captureMainButton,
              pressed ? styles.captureMainButtonPressed : null,
            ]}
            testID={`scanner-tray-open-card-${index}`}
          >
            <View style={styles.captureCopy}>
              {capture.isLoadingCandidates ? (
                <>
                  <View style={styles.captureLoadingRow}>
                    <ActivityIndicator color={theme.colors.brand} size="small" />
                    <Text style={styles.captureTitle}>Finding match</Text>
                  </View>
                  <Text style={styles.captureSubtitle}>Photo captured and queued for scan review</Text>
                </>
              ) : candidate ? (
                <>
                  <Text numberOfLines={1} style={styles.captureTitle}>{candidate.name}</Text>
                  <Text numberOfLines={1} style={styles.captureSubtitle}>
                    {candidate.setName}
                    {' • '}
                    {candidate.cardNumber}
                  </Text>
                </>
              ) : (
                <>
                  <Text numberOfLines={1} style={styles.captureTitle}>{capturePrimaryLabel(capture.mode)}</Text>
                  <Text numberOfLines={2} style={styles.captureSubtitle}>{captureFailureSubtitle(capture)}</Text>
                </>
              )}
            </View>

            {candidate ? (
              <View style={styles.capturePriceWrap}>
                <Text style={styles.capturePriceLabel}>MARKET</Text>
                <Text style={styles.capturePriceValue}>{formatCurrency(marketPrice, currencyCode)}</Text>
                {quantity > 0 ? (
                  <Text style={styles.captureQuantityText} testID={`scanner-tray-qty-${index}`}>QTY {quantity}</Text>
                ) : null}
              </View>
            ) : null}
          </Pressable>

        {candidate ? (
          <View style={styles.captureActionWrap}>
            <Pressable
              accessibilityLabel={`Add ${candidate.name} to inventory`}
              accessibilityRole="button"
              disabled={capture.isAddingToInventory}
              onPress={() => {
                void handleAddToInventory(capture.id);
              }}
              style={({ pressed }) => [
                styles.captureAddButton,
                pressed ? styles.captureAddButtonPressed : null,
                capture.isAddingToInventory ? styles.captureAddButtonDisabled : null,
              ]}
              testID={`scanner-tray-add-${index}`}
            >
              {capture.isAddingToInventory ? (
                <ActivityIndicator color={colors.scannerCanvas} size="small" />
              ) : (
                <Text style={styles.captureAddIcon}>+</Text>
              )}
            </Pressable>
            <Text style={styles.captureAddLabel}>ADD</Text>
          </View>
        ) : null}
        </View>
      </RecentCaptureSwipeRow>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
      <RawScannerCaptureSurface
        cameraRef={cameraRef}
        cameraSessionKey={cameraSessionKey}
        canCapture={canCapture}
        hasCameraAccess={hasCameraAccess}
        layout={captureSurfaceLayout}
        onCameraReady={() => {
          setIsCameraReady(true);
          resolveRawVisualPictureSize();
          void cameraRef.current?.resumePreview?.();
        }}
        onCapture={() => {
          void handleCapture();
        }}
        onRequestPermission={() => {
          void requestPermission();
        }}
        permissionCanAskAgain={permission?.canAskAgain}
        permissionResolved={!!permission}
        pictureSize={scannerMode === 'raw' ? rawVisualPictureSize : undefined}
        prompt={promptCopy}
        showSlabGuide={scannerMode === 'slabs'}
        testIDPrefix="scanner"
      >
        <View
          style={[
            styles.backButtonWrap,
            {
              left: 18,
              top: captureSurfaceLayout.backButtonTop,
            },
          ]}
        >
          <ChromeBackButton
            accessibilityLabel="Exit scanner"
            onPress={handleExitScanner}
            testID="scanner-back-button"
          />
        </View>

        {canStartLabelingSession || (scannerSmokeEnabled && scannerMode === 'raw') ? (
          <View
            style={[
              styles.topActionStack,
              {
                right: 18,
                top: captureSurfaceLayout.backButtonTop,
              },
            ]}
          >
            {canStartLabelingSession ? (
              <Button
                label="New label session"
                labelStyleVariant="caption"
                onPress={handleOpenLabelingSession}
                size="sm"
                testID="labeler-entry-button"
                variant="secondary"
              />
            ) : null}
            {scannerSmokeEnabled && scannerMode === 'raw' ? (
              <Button
                label="Smoke fixture"
                labelStyleVariant="caption"
                onPress={() => {
                  void handleTriggerSmokeFixture();
                }}
                size="sm"
                testID="scanner-smoke-fixture-trigger"
                variant="secondary"
              />
            ) : null}
          </View>
        ) : null}

        <View
          style={[
            styles.modeToggleWrap,
            {
              top: captureSurfaceLayout.controlsTop,
            },
          ]}
        >
          <View style={{ width: captureSurfaceLayout.modeToggleWidth }}>
            <SegmentedControl
              items={scannerModes}
              onChange={setScannerMode}
              size="scanner"
              testID="scanner-mode-toggle"
              tone="inverted"
              value={scannerMode}
            />
          </View>
        </View>

        <View style={styles.trayShell} testID="scanner-tray">
          <View
            style={styles.trayHeader}
            testID="scanner-tray-header"
            {...trayHeaderPanResponder.panHandlers}
          >
            {canToggleTray ? (
              <Pressable
                accessibilityLabel={isTrayExpanded ? 'Collapse recent scans' : 'Expand recent scans'}
                accessibilityRole="button"
                onPress={toggleTrayExpanded}
                style={styles.sheetHandleButton}
                testID="scanner-tray-toggle"
              >
                <View style={styles.sheetHandle} />
              </Pressable>
            ) : (
              <View style={styles.sheetHandleButton}>
                <View style={styles.sheetHandle} />
              </View>
            )}

            <View style={styles.recentScansRow}>
              <View style={styles.recentScansMetaRow}>
                <Text style={styles.recentScansTitle} testID="scanner-recent-title">Recent scans</Text>
                {recentCaptures.length > 0 ? (
                  <Pressable
                    accessibilityLabel="Clear recent scans"
                    accessibilityRole="button"
                    onPress={clearRecentCaptures}
                    style={({ pressed }) => [
                      styles.clearPill,
                      pressed ? styles.clearPillPressed : null,
                    ]}
                    testID="scanner-clear-button"
                  >
                    <Text style={styles.clearPillText}>CLEAR</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.recentScansActions}>
                <View style={styles.valuePill}>
                  <Text style={styles.valuePillText} testID="scanner-value-pill-text">
                    {formatCurrency(trayValue)}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          <View
            style={[
              styles.trayBody,
              {
                paddingBottom: trayBottomInset,
              },
              isTrayExpanded ? styles.trayBodyExpanded : null,
            ]}
            testID="scanner-tray-body"
          >
            {recentCaptures.length === 0 ? (
              <View style={styles.trayEmptyFill} />
            ) : (
              <View
                style={[
                  styles.trayViewport,
                  {
                    height: isTrayExpanded ? trayScrollViewportHeight : captureRowHeight,
                  },
                ]}
                testID="scanner-tray-viewport"
              >
                <ScrollView
                  nestedScrollEnabled
                  scrollEnabled={isTrayExpanded && trayScrollEnabled}
                  showsVerticalScrollIndicator={isTrayExpanded && trayScrollEnabled}
                  style={styles.trayScroll}
                  contentContainerStyle={styles.trayScrollContent}
                  testID="scanner-tray-scroll"
                >
                  {visibleCaptures.map(renderCaptureRow)}
                </ScrollView>
              </View>
            )}
          </View>
        </View>
      </RawScannerCaptureSurface>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backButtonWrap: {
    position: 'absolute',
    zIndex: 5,
  },
  topActionStack: {
    alignItems: 'flex-end',
    gap: 8,
    position: 'absolute',
    zIndex: 5,
  },
  captureActionWrap: {
    alignItems: 'center',
    gap: 4,
    justifyContent: 'center',
    width: 56,
  },
  captureAddButton: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    borderRadius: 10,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  captureAddButtonDisabled: {
    opacity: 0.52,
  },
  captureAddButtonPressed: {
    opacity: 0.86,
  },
  captureAddIcon: {
    color: colors.scannerCanvas,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 30,
    marginTop: -2,
    textAlign: 'center',
  },
  captureAddLabel: {
    ...textStyles.control,
    color: colors.brand,
    fontSize: 12,
    lineHeight: 14,
  },
  captureCopy: {
    flex: 1,
    gap: 4,
  },
  captureLoadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  captureMeta: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  captureMainButton: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  captureMainButtonPressed: {
    opacity: 0.9,
  },
  capturePriceLabel: {
    ...textStyles.caption,
    color: colors.scannerTextMeta,
    letterSpacing: 0.7,
  },
  capturePriceValue: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
    textAlign: 'right',
  },
  capturePriceWrap: {
    alignItems: 'flex-end',
    gap: 4,
    justifyContent: 'center',
    minWidth: 96,
  },
  captureQuantityText: {
    ...textStyles.control,
    color: colors.scannerTextPrimary,
    fontSize: 12,
    lineHeight: 14,
    textAlign: 'right',
  },
  captureRow: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceMuted,
    borderColor: colors.scannerOutlineSubtle,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: captureRowHeight,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: '100%',
  },
  captureDeleteLabel: {
    ...textStyles.control,
    color: '#FFFFFF',
    fontSize: 11,
    lineHeight: 13,
  },
  captureDeleteUnderlay: {
    alignItems: 'center',
    backgroundColor: '#B91C1C',
    borderRadius: 18,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
    width: recentCaptureDeleteRevealWidth,
  },
  captureDeleteButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    width: '100%',
  },
  captureDeleteUnderlayPressed: {
    opacity: 0.82,
  },
  captureRefreshButton: {
    alignItems: 'center',
    bottom: 0,
    height: 32,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    width: 32,
    zIndex: 2,
  },
  captureRefreshChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(12, 12, 14, 0.82)',
    borderRadius: 999,
    height: 25,
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.34,
    shadowRadius: 8,
    width: 25,
    elevation: 8,
  },
  captureRefreshPressed: {
    opacity: 0.82,
  },
  captureSubtitle: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  captureSwipeShell: {
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  captureSwipeContent: {
    width: '100%',
  },
  captureThumb: {
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 14,
    height: 54,
    width: 44,
  },
  captureThumbPressed: {
    opacity: 0.9,
  },
  captureThumbPressable: {
    height: 54,
    position: 'relative',
    width: 44,
  },
  captureThumbWrap: {
    height: 54,
    position: 'relative',
    width: 44,
  },
  captureSwipeTestControl: {
    height: 1,
    left: -1000,
    opacity: 0,
    position: 'absolute',
    top: -1000,
    width: 1,
  },
  captureTitle: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  clearPill: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 28,
    paddingHorizontal: 14,
  },
  clearPillPressed: {
    opacity: 0.82,
  },
  clearPillText: {
    ...textStyles.control,
    color: colors.scannerTextMeta,
    fontSize: 12,
    lineHeight: 14,
  },
  modeToggleWrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  recentScansActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
  },
  recentScansMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 8,
  },
  recentScansRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  recentScansTitle: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
  },
  safeArea: {
    backgroundColor: colors.scannerCanvas,
    flex: 1,
  },
  matchesButton: {
    minWidth: 116,
  },
  matchesPanel: {
    backgroundColor: colors.scannerSurfaceMuted,
    borderColor: colors.scannerOutlineSubtle,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  matchesPanelList: {
    gap: 8,
  },
  matchesPanelTitle: {
    ...textStyles.control,
    color: colors.scannerTextPrimary,
  },
  matchOptionCopy: {
    flex: 1,
    gap: 2,
  },
  matchOptionMeta: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  matchOptionPrice: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  matchOptionRow: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 14,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  matchOptionRowPressed: {
    opacity: 0.86,
  },
  matchOptionThumb: {
    backgroundColor: colors.scannerSurface,
    borderRadius: 10,
    height: 52,
    width: 40,
  },
  matchOptionTitle: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: colors.scannerTextMeta,
    borderRadius: 999,
    height: 5,
    width: 54,
  },
  sheetHandleButton: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 6,
  },
  trayBody: {
    gap: 12,
    minHeight: 104,
    paddingHorizontal: 4,
    paddingTop: 0,
  },
  trayBodyExpanded: {
    minHeight: 0,
  },
  trayEmptyFill: {
    flex: 1,
    minHeight: 32,
  },
  trayHeader: {
    backgroundColor: colors.scannerTray,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  trayScroll: {
    width: '100%',
  },
  trayScrollContent: {
    gap: captureRowGap,
  },
  trayViewport: {
    width: '100%',
  },
  trayShell: {
    backgroundColor: colors.scannerTray,
    borderColor: colors.scannerOutlineSubtle,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: '#000000',
    shadowOffset: {
      height: -12,
      width: 0,
    },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 12,
  },
  valuePill: {
    backgroundColor: colors.scannerValuePill,
    borderColor: colors.scannerOutline,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 28,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  valuePillText: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
});
