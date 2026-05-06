import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconHeart,
  IconHeartFilled,
  IconMinus,
  IconSearch,
} from '@tabler/icons-react-native';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
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
  type ScannerCapturePayload,
  type ScannerSlabAnalysisPayload,
  type SlabContext,
} from '@spotlight/api-client';
import {
  Button,
  colors,
  SearchField,
  SegmentedControl,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useTabsPage } from '@/contexts/tabs-page-context';
import {
  clampRecentCaptureSwipeTranslate,
  recentCaptureActionRailRevealWidth,
  recentCaptureDeleteRevealWidth,
  recentCaptureFavoriteRevealWidth,
  shouldCollapseRecentCaptureDeleteFromSwipe,
  shouldRevealRecentCaptureDeleteFromSwipe,
  shouldSetRecentCaptureSwipeResponder,
} from '@/features/scanner/recent-capture-swipe';
import {
  shouldSetRecentCaptureTrayShellResponder,
  shouldSetRecentCaptureTrayVerticalResponder,
} from '@/features/scanner/recent-capture-tray-gesture';
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
  getRawScannerCollapsedTrayReservedHeight,
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
  rawScannerTrayEmptyPeekHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
import { analyzePSASlabCapture } from '@/features/scanner/slab-native-analysis';
import { buildSlabScannerTarget } from '@/features/scanner/scanner-slab-target';
import { loadRawScannerSmokeFixture } from '@/features/scanner/scanner-smoke-fixtures';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeValue, resolveStagingSmokeModeEnabled } from '@/lib/runtime-config';
import { useAppServices } from '@/providers/app-providers';

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
  slabContext: SlabContext | null;
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
  matchPayload: ScannerCapturePayload;
  matchTarget: NormalizedScannerTarget;
  mode: ScannerMode;
  normalizeMs: number;
  rawSourceImageDimensions: ScanSourceImageDimensions;
  scanStartedAt: number;
  slabAnalysisMs?: number | null;
  sourceImageDimensions: ScanSourceImageDimensions;
};

const scannerModes: readonly { label: string; value: ScannerMode }[] = [
  { label: 'RAW', value: 'raw' },
  { label: 'SLABS', value: 'slabs' },
];

const unsupportedSlabTitle = 'Slab type is currently not supported';
const unsupportedSlabSubtitle = 'We currently only support PSA slabs for now.';

const maxStoredCaptures = 12;
const collapsedVisibleCaptures = 1;
const captureRowHeight = 74;
const captureRowGap = 8;
const favoriteHeartColor = '#E83E8C';
const traySwipeThreshold = 20;
const trayVelocityThreshold = 0.22;
const trayHeaderHitSlop = { bottom: 10, left: 12, right: 12, top: 12 } as const;
let cachedRawVisualPictureSize: string | undefined;
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

  if (
    error != null
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
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

function isNonPSAUnsupportedSlabCapture(capture: RecentCapture) {
  if (capture.mode !== 'slabs' || capture.matchReviewDisposition !== 'unsupported') {
    return false;
  }

  const reviewReason = capture.matchReviewReason?.trim();
  return reviewReason === 'PSA only for now.' || reviewReason === unsupportedSlabSubtitle;
}

function captureFailureTitle(capture: RecentCapture) {
  if (isNonPSAUnsupportedSlabCapture(capture)) {
    return unsupportedSlabTitle;
  }

  return capturePrimaryLabel(capture.mode);
}

function captureFailureSubtitle(capture: RecentCapture) {
  if (isNonPSAUnsupportedSlabCapture(capture)) {
    return unsupportedSlabSubtitle;
  }

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
  artifactUploadMs?: number | null;
  candidateCount: number;
  captureMs?: number | null;
  endToEndMs?: number | null;
  mode: ScannerMode;
  normalizeMs?: number | null;
  requestAttemptCount?: number | null;
  reviewDisposition?: string | null;
  roundTripMs?: number | null;
  slabAnalysisMs?: number | null;
  serverProcessingMs?: number | null;
}) {
  const properties: Record<string, number | string> = {
    candidate_count: params.candidateCount,
    mode: params.mode,
  };

  if (typeof params.requestAttemptCount === 'number') {
    properties.request_attempt_count = params.requestAttemptCount;
  }

  if (typeof params.captureMs === 'number') {
    properties.capture_ms = params.captureMs;
  }

  if (typeof params.normalizeMs === 'number') {
    properties.normalize_ms = params.normalizeMs;
  }

  if (typeof params.slabAnalysisMs === 'number') {
    properties.slab_analysis_ms = params.slabAnalysisMs;
  }

  if (typeof params.endToEndMs === 'number') {
    properties.end_to_end_ms = params.endToEndMs;
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

  if (typeof params.artifactUploadMs === 'number') {
    properties.artifact_upload_ms = params.artifactUploadMs;
  }

  return properties;
}

function buildScanMatchFailureProperties(params: {
  captureMs?: number | null;
  endToEndMs?: number | null;
  errorKind: string;
  mode: ScannerMode;
  normalizeMs?: number | null;
  slabAnalysisMs?: number | null;
}) {
  const properties: Record<string, number | string> = {
    error_kind: params.errorKind,
    mode: params.mode,
  };

  if (typeof params.captureMs === 'number') {
    properties.capture_ms = params.captureMs;
  }

  if (typeof params.normalizeMs === 'number') {
    properties.normalize_ms = params.normalizeMs;
  }

  if (typeof params.slabAnalysisMs === 'number') {
    properties.slab_analysis_ms = params.slabAnalysisMs;
  }

  if (typeof params.endToEndMs === 'number') {
    properties.end_to_end_ms = params.endToEndMs;
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

function isFinitePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatOptionalCurrency(amount: number | null | undefined, currencyCode = 'USD') {
  if (!isFinitePrice(amount)) {
    return '—';
  }

  return formatCurrency(amount, currencyCode);
}

function withOptimisticInventoryAdd(
  entries: InventoryCardEntry[],
  candidate: CatalogSearchResult,
  addedAt: string,
  options: {
    mode: ScannerMode;
    slabContext: SlabContext | null;
  },
): InventoryCardEntry[] {
  const slabContext = options.slabContext;
  const isSlab = options.mode === 'slabs';
  const existingIndex = entries.findIndex((entry) => (
    entry.cardId === candidate.cardId
    && (
      isSlab
        ? entry.kind === 'graded' && sameSlabContext(entry.slabContext ?? null, slabContext)
        : entry.kind === 'raw'
          && (entry.conditionCode ?? 'near_mint') === 'near_mint'
          && !entry.variantName
    )
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
      conditionCode: isSlab ? null : 'near_mint',
      conditionLabel: isSlab ? null : 'Near Mint',
      conditionShortLabel: isSlab ? null : 'NM',
      costBasisPerUnit: null,
      costBasisTotal: 0,
      currencyCode: candidate.currencyCode ?? 'USD',
      hasMarketPrice: candidate.marketPrice != null,
      id: isSlab
        ? `optimistic|graded|${candidate.cardId}|${slabContext?.grader ?? 'unknown'}|${slabContext?.grade ?? 'unknown'}|${slabContext?.certNumber ?? 'uncertified'}`
        : `optimistic|raw|${candidate.cardId}`,
      imageUrl: candidate.imageUrl,
      kind: isSlab ? 'graded' : 'raw',
      marketPrice: candidate.marketPrice ?? 0,
      name: candidate.name,
      quantity: 1,
      setName: candidate.setName,
      slabContext,
      isFavorite: candidate.isFavorite,
      variantName: slabContext?.variantName ?? null,
    },
    ...entries,
  ];
}

function withUpdatedInventoryFavoriteState(
  entries: InventoryCardEntry[],
  cardId: string,
  isFavorite: boolean,
) {
  return entries.map((entry) => (
    entry.cardId === cardId
      ? { ...entry, isFavorite }
      : entry
  ));
}

function withUpdatedCaptureFavoriteState(
  captures: RecentCapture[],
  cardId: string,
  isFavorite: boolean,
) {
  return captures.map((capture) => ({
    ...capture,
    candidates: capture.candidates.map((candidate) => (
      candidate.cardId === cardId
        ? { ...candidate, isFavorite }
        : candidate
    )),
  }));
}

function normalizeSlabText(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSlabNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSlabTextList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalized = normalizeSlabText(entry);
    return normalized ? [normalized] : [];
  });
}

function sameSlabContext(left: SlabContext | null, right: SlabContext | null) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    normalizeSlabText(left.grader)?.toUpperCase() === normalizeSlabText(right.grader)?.toUpperCase()
    && normalizeSlabText(left.grade) === normalizeSlabText(right.grade)
    && normalizeSlabText(left.certNumber) === normalizeSlabText(right.certNumber)
    && normalizeSlabText(left.variantName) === normalizeSlabText(right.variantName)
  );
}

function normalizeScannerSlabAnalysis(
  value: ScannerSlabAnalysisPayload | null | undefined,
): ScannerSlabAnalysisPayload {
  return {
    slabGrader: normalizeSlabText(value?.slabGrader),
    slabGrade: normalizeSlabText(value?.slabGrade),
    slabCertNumber: normalizeSlabText(value?.slabCertNumber),
    slabBarcodePayloads: normalizeSlabTextList(value?.slabBarcodePayloads),
    slabParsedLabelText: normalizeSlabTextList(value?.slabParsedLabelText),
    slabCardNumberRaw: normalizeSlabText(value?.slabCardNumberRaw),
    slabGraderConfidence: normalizeSlabNumber(value?.slabGraderConfidence),
    slabGradeConfidence: normalizeSlabNumber(value?.slabGradeConfidence),
    slabCertConfidence: normalizeSlabNumber(value?.slabCertConfidence),
    slabClassifierReasons: normalizeSlabTextList(value?.slabClassifierReasons),
    slabRecommendedLookupPath: value?.slabRecommendedLookupPath ?? null,
    ocrAnalysis: value?.ocrAnalysis ?? null,
  };
}

async function analyzeSlabCapture(imageUri: string): Promise<ScannerSlabAnalysisPayload> {
  const result = await analyzePSASlabCapture(imageUri);
  if (result.parsed.unsupportedReason === 'non_psa_slab_not_supported_yet') {
    throw new Error('psa_only_for_now');
  }

  if (!result) {
    throw new Error('slab_analysis_empty');
  }

  return normalizeScannerSlabAnalysis(result.scannerMatchFields);
}

function slabContextFromAnalysis(analysis: ScannerSlabAnalysisPayload): SlabContext | null {
  const grader = normalizeSlabText(analysis.slabGrader);
  if (!grader) {
    return null;
  }

  const grade = normalizeSlabText(analysis.slabGrade);
  const certNumber = normalizeSlabText(analysis.slabCertNumber);
  return {
    grader,
    grade,
    certNumber,
    variantName: grade ? `${grader} ${grade}` : grader,
  };
}

function scannerSlabInlineLabel(capture: RecentCapture) {
  const grader = normalizeSlabText(capture.slabContext?.grader);
  const grade = normalizeSlabText(capture.slabContext?.grade);
  if (grader && grade) {
    return `${grader} • ${grade}`;
  }
  return grader ?? normalizeSlabText(capture.slabContext?.variantName);
}

function scannerSlabSubtitle(capture: RecentCapture, candidate: CatalogSearchResult) {
  void capture;
  return [candidate.cardNumber?.trim(), candidate.setName].filter(Boolean).join(' • ');
}

function scannerCapturePriceLabel(capture: RecentCapture) {
  void capture;
  return 'MARKET';
}

function scannerCaptureThumbUri(capture: RecentCapture, candidate: CatalogSearchResult | null) {
  if (capture.mode === 'slabs') {
    return candidate?.imageUrl || capture.uri || null;
  }

  return candidate?.imageUrl || capture.uri || null;
}

function scannerPreparationReviewReason(mode: ScannerMode, error: unknown) {
  if (mode !== 'slabs') {
    return null;
  }

  const errorKind = scannerErrorKind(error);
  switch (errorKind) {
    case 'native_module_unavailable':
    case 'unsupported_platform':
      return 'Slab analysis is unavailable on this build.';
    case 'invalid_image_uri':
      return 'Could not prepare this slab capture for analysis.';
    case 'native_analysis_failed':
      return 'Could not read this slab label strongly enough.';
    case 'slab_analysis_empty':
      return 'Could not read this slab label strongly enough.';
    case 'normalized_target_unavailable':
      return 'Could not isolate the PSA label inside the guide.';
    case 'psa_only_for_now':
      return unsupportedSlabSubtitle;
    default:
      return error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : 'Could not analyze this slab label.';
  }
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
  actionRailKey: string;
  children: ReactNode;
  onActionRailVisibilityChange?: (key: string, visible: boolean) => void;
  onDelete: () => void;
  onFavorite: () => void;
  isFavorite: boolean;
  testID: string;
};

function RecentCaptureSwipeRow({
  actionRailKey,
  children,
  isFavorite,
  onActionRailVisibilityChange,
  onDelete,
  onFavorite,
  testID,
}: RecentCaptureSwipeRowProps) {
  const [isActionRailRevealed, setIsActionRailRevealed] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const deleteOpacity = useMemo(() => translateX.interpolate({
    extrapolate: 'clamp',
    inputRange: [-recentCaptureActionRailRevealWidth, 0],
    outputRange: [1, 0],
  }), [translateX]);

  const settleClosed = useCallback(() => {
    setIsActionRailRevealed(false);
    onActionRailVisibilityChange?.(actionRailKey, false);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 16,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [actionRailKey, onActionRailVisibilityChange, translateX]);

  const revealActionRail = useCallback(() => {
    setIsActionRailRevealed(true);
    onActionRailVisibilityChange?.(actionRailKey, true);
    Animated.spring(translateX, {
      bounciness: 0,
      speed: 18,
      toValue: -recentCaptureActionRailRevealWidth,
      useNativeDriver: true,
    }).start();
  }, [actionRailKey, onActionRailVisibilityChange, translateX]);

  const handleSwipeMove = useCallback((gestureState: PanResponderGestureState) => {
    translateX.setValue(clampRecentCaptureSwipeTranslate(gestureState.dx, isActionRailRevealed));
  }, [isActionRailRevealed, translateX]);

  const handleSwipeEnd = useCallback((gestureState: PanResponderGestureState) => {
    if (isActionRailRevealed) {
      if (shouldCollapseRecentCaptureDeleteFromSwipe(gestureState)) {
        settleClosed();
        return;
      }

      revealActionRail();
      return;
    }

    if (shouldRevealRecentCaptureDeleteFromSwipe(gestureState)) {
      revealActionRail();
      return;
    }

    settleClosed();
  }, [isActionRailRevealed, revealActionRail, settleClosed]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => shouldSetRecentCaptureSwipeResponder(gestureState, isActionRailRevealed),
    onPanResponderMove: (_, gestureState) => handleSwipeMove(gestureState),
    onPanResponderRelease: (_, gestureState) => handleSwipeEnd(gestureState),
    onPanResponderTerminate: () => {
      settleClosed();
    },
  }), [handleSwipeEnd, handleSwipeMove, isActionRailRevealed, settleClosed]);

  useEffect(() => {
    return () => {
      onActionRailVisibilityChange?.(actionRailKey, false);
    };
  }, [actionRailKey, onActionRailVisibilityChange]);

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
            onPress={revealActionRail}
            style={styles.captureSwipeTestControl}
            testID={`${testID}-reveal-actions`}
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
        pointerEvents={isActionRailRevealed ? 'auto' : 'none'}
        style={[styles.captureDeleteUnderlay, { opacity: deleteOpacity }]}
        testID={`${testID}-actions-underlay`}
      >
        <View style={styles.captureActionRail}>
          <Pressable
            accessibilityElementsHidden={!isActionRailRevealed}
            accessibilityLabel={isFavorite ? 'Remove favorite' : 'Favorite recent scan'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !isActionRailRevealed }}
            importantForAccessibility={isActionRailRevealed ? 'auto' : 'no-hide-descendants'}
            onPress={isActionRailRevealed
              ? () => {
                  onFavorite();
                  settleClosed();
                }
              : undefined}
            style={({ pressed }) => [
              styles.captureFavoriteButton,
              pressed ? styles.captureFavoriteButtonPressed : null,
            ]}
            testID={`${testID}-favorite-button`}
          >
            {isFavorite ? (
              <IconHeartFilled color={favoriteHeartColor} size={16} />
            ) : (
              <IconHeart color={favoriteHeartColor} size={16} strokeWidth={2} />
            )}
            <Text style={styles.captureFavoriteLabel}>FAVORITE</Text>
          </Pressable>
          <Pressable
            accessibilityElementsHidden={!isActionRailRevealed}
            accessibilityLabel="Delete recent scan"
            accessibilityRole="button"
            accessibilityState={{ disabled: !isActionRailRevealed }}
            importantForAccessibility={isActionRailRevealed ? 'auto' : 'no-hide-descendants'}
            onPress={isActionRailRevealed ? onDelete : undefined}
            style={({ pressed }) => [
              styles.captureDeleteButton,
              pressed ? styles.captureDeleteUnderlayPressed : null,
            ]}
            testID={`${testID}-delete-button`}
          >
            <IconMinus color="#FFFFFF" size={18} strokeWidth={2.4} />
            <Text style={styles.captureDeleteLabel}>DELETE</Text>
          </Pressable>
        </View>
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

function ScannerSearchLauncher({
  onChangeText,
  onFocusChange,
  onSubmit,
  value,
}: {
  onChangeText: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: () => void;
  value: string;
}) {
  return (
    <SearchField
      autoCapitalize="none"
      autoCorrect={false}
      containerStyle={[
        styles.searchLauncher,
        {
          backgroundColor: colors.scannerSurfaceStrong,
          borderColor: colors.scannerTextPrimary,
        },
      ]}
      containerTestID="scanner-search-launcher"
      inputStyle={styles.searchLauncherInput}
      leading={<IconSearch color={colors.scannerTextSecondary} size={18} strokeWidth={2} />}
      onBlur={() => {
        onFocusChange(false);
      }}
      onChangeText={onChangeText}
      onFocus={() => {
        onFocusChange(true);
      }}
      onSubmitEditing={onSubmit}
      placeholder="Search card to add"
      placeholderTextColor={colors.scannerTextSecondary}
      returnKeyType="search"
      value={value}
    />
  );
}

type ScannerScreenProps = {
  onExitToPortfolio?: () => void;
  onTopLevelSwipeEnabledChange?: (enabled: boolean) => void;
};

function ScannerKeepAwake() {
  useKeepAwake('scanner-screen');
  return null;
}

export function ScannerScreen({
  onExitToPortfolio,
  onTopLevelSwipeEnabledChange,
}: ScannerScreenProps = {}) {
  const isTestEnv = process.env.NODE_ENV === 'test';
  const { activePage } = useTabsPage();
  const isActiveTab = activePage === 'scanner';
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { dataVersion, refreshData, spotlightRepository } = useAppServices();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [scannerMode, setScannerMode] = useState<ScannerMode>('raw');
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraReady, setIsCameraReady] = useState(isTestEnv);
  const [isCapturing, setIsCapturing] = useState(false);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryCardEntry[]>([]);
  const [recentCaptures, setRecentCaptures] = useState<RecentCapture[]>([]);
  const [openActionRailKeys, setOpenActionRailKeys] = useState<Record<string, true>>({});
  const [isTrayExpanded, setIsTrayExpanded] = useState(false);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState('');
  const [isCatalogSearchFocused, setIsCatalogSearchFocused] = useState(false);
  const [isRawPictureConfigReady, setIsRawPictureConfigReady] = useState(
    isTestEnv || cachedRawVisualPictureSize != null,
  );
  const [rawVisualPictureSize, setRawVisualPictureSize] = useState<string | undefined>(
    cachedRawVisualPictureSize,
  );
  const [cameraSessionKey, setCameraSessionKey] = useState(0);
  const [availableBackLenses, setAvailableBackLenses] = useState<string[]>([]);
  const hasFocusedScannerRef = useRef(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<CameraView | null>(null);
  const isResolvingPictureSizeRef = useRef(false);
  const trayGestureCommittedRef = useRef(false);
  const trayScrollOffsetYRef = useRef(0);
  const reticleSnapshotRef = useRef({ height: 0, previewHeight: 0, previewWidth: 0, width: 0, x: 0, y: 0 });

  const trayBottomInset = insets.bottom + 14;
  const collapsedTrayReservedHeight = getRawScannerCollapsedTrayReservedHeight({
    bottomInset: trayBottomInset,
  });
  const captureSurfaceLayout = makeRawScannerCaptureLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    safeAreaTop: insets.top,
    trayReservedHeight: collapsedTrayReservedHeight,
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
  const hasCameraPermission = permission?.granted ?? false;
  const shouldMountCamera = hasCameraPermission && isActiveTab;
  const preferredScannerLens = useMemo(() => {
    if (Platform.OS !== 'ios') {
      return undefined;
    }

    if (availableBackLenses.includes('builtInWideAngleCamera')) {
      return 'builtInWideAngleCamera';
    }

    return undefined;
  }, [availableBackLenses]);
  const scannerSmokeEnabled = resolveStagingSmokeModeEnabled({ allowDevelopment: true });
  const canCapture = shouldMountCamera
    && isCameraReady
    && !isCapturing
    && (scannerMode !== 'raw' || isRawPictureConfigReady);
  const canToggleTray = recentCaptures.length > 0;
  const isTopLevelSwipeEnabled = Object.keys(openActionRailKeys).length === 0;
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

  useEffect(() => {
    onTopLevelSwipeEnabledChange?.(isTopLevelSwipeEnabled);

    return () => {
      onTopLevelSwipeEnabledChange?.(true);
    };
  }, [isTopLevelSwipeEnabled, onTopLevelSwipeEnabledChange]);

  useFocusEffect(useCallback(() => {
    trayGestureCommittedRef.current = false;
    isResolvingPictureSizeRef.current = false;

    if (hasFocusedScannerRef.current) {
      setIsCameraReady(false);
      setIsCapturing(false);
      setIsRawPictureConfigReady(isTestEnv || cachedRawVisualPictureSize != null);
      setRawVisualPictureSize(cachedRawVisualPictureSize);
      setCameraSessionKey((current) => current + 1);
    } else {
      hasFocusedScannerRef.current = true;
    }

    return () => {
      trayGestureCommittedRef.current = false;
      isResolvingPictureSizeRef.current = false;
      setIsCameraReady(false);
      setIsCapturing(false);
      setIsRawPictureConfigReady(isTestEnv || cachedRawVisualPictureSize != null);
    };
  }, [isTestEnv]));

  // Manage camera lifecycle when the pager switches between portfolio and scanner pages.
  // useFocusEffect handles route-level focus (navigating to card detail and back).
  // This effect handles pager-level page switches where the route never changes.
  const prevIsActiveTabRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevIsActiveTabRef.current;
    prevIsActiveTabRef.current = isActiveTab;
    // Skip initial mount — camera is already in the right state from component init.
    if (prev === null) {
      return;
    }
    if (isActiveTab && !prev) {
      // Returning to scanner from portfolio — restart camera session.
      setIsCameraReady(false);
      setIsCapturing(false);
      setIsRawPictureConfigReady(isTestEnv || cachedRawVisualPictureSize != null);
      setRawVisualPictureSize(cachedRawVisualPictureSize);
      setCameraSessionKey((current) => current + 1);
    } else if (!isActiveTab && prev) {
      // Leaving scanner for portfolio — stop capture state.
      setIsCameraReady(false);
      setIsCapturing(false);
      setIsRawPictureConfigReady(isTestEnv || cachedRawVisualPictureSize != null);
    }
  }, [isActiveTab, isTestEnv]);

  const commitTrayExpandedState = useCallback((nextExpanded: boolean) => {
    setIsTrayExpanded((current) => {
      if (current === nextExpanded) {
        return current;
      }

      if (!nextExpanded) {
        trayScrollOffsetYRef.current = 0;
      }

      if (Platform.OS !== 'web') {
        LayoutAnimation.configureNext(scannerTrayLayoutAnimation);
      }

      return nextExpanded;
    });
  }, []);

  const resolveRawVisualPictureSize = useCallback(() => {
    if (isTestEnv) {
      setRawVisualPictureSize(undefined);
      setIsRawPictureConfigReady(true);
      isResolvingPictureSizeRef.current = false;
      return;
    }

    if (cachedRawVisualPictureSize != null) {
      setRawVisualPictureSize(cachedRawVisualPictureSize);
      setIsRawPictureConfigReady(true);
      isResolvingPictureSizeRef.current = false;
      return;
    }

    if (isResolvingPictureSizeRef.current) {
      return;
    }

    setIsRawPictureConfigReady(false);
    isResolvingPictureSizeRef.current = true;
    void (async () => {
      try {
        const sizes = await cameraRef.current?.getAvailablePictureSizesAsync?.();
        const selectedSize = chooseRawVisualPictureSize(Array.isArray(sizes) ? sizes : []);
        cachedRawVisualPictureSize = selectedSize ?? undefined;
        setRawVisualPictureSize(selectedSize ?? undefined);
        if (selectedSize && process.env.NODE_ENV !== 'test') {
          console.info(`[SCANNER VISUAL TEST] rawPictureSize=${selectedSize}`);
        }
      } catch {
        setRawVisualPictureSize(undefined);
      } finally {
        setIsRawPictureConfigReady(true);
        isResolvingPictureSizeRef.current = false;
      }
    })();
  }, [isTestEnv]);

  const handleAvailableLensesChanged = useCallback((event: { lenses: string[] }) => {
    const nextLenses = Array.isArray(event.lenses)
      ? event.lenses.filter((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
      : [];

    setAvailableBackLenses((current) => {
      if (
        current.length === nextLenses.length
        && current.every((candidate, index) => candidate === nextLenses[index])
      ) {
        return current;
      }

      return nextLenses;
    });

    if (process.env.NODE_ENV !== 'test' && nextLenses.length > 0) {
      console.info(
        `[SCANNER VISUAL TEST] availableLenses=${nextLenses.join(',')} selectedLens=${
          nextLenses.includes('builtInWideAngleCamera')
            ? 'builtInWideAngleCamera'
            : 'default'
        }`,
      );
    }
  }, []);

  useEffect(() => {
    if (
      scannerMode !== 'raw'
      || !isCameraReady
      || rawVisualPictureSize != null
    ) {
      return;
    }

    resolveRawVisualPictureSize();
  }, [isCameraReady, rawVisualPictureSize, resolveRawVisualPictureSize, scannerMode]);

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

  const trayPriceSummary = useMemo(() => {
    let hasPricedCapture = false;
    const total = recentCaptures.reduce((sum, capture) => {
      const marketPrice = activeCandidateForCapture(capture)?.marketPrice;
      if (!isFinitePrice(marketPrice)) {
        return sum;
      }
      hasPricedCapture = true;
      return sum + marketPrice;
    }, 0);

    return {
      hasPricedCapture,
      total,
    };
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
    matchPayload,
    matchTarget,
    mode,
    normalizeMs,
    rawSourceImageDimensions,
    scanStartedAt,
    slabAnalysisMs,
    sourceImageDimensions,
  }: CaptureMatchParams) => {
    try {
      capturePostHogEvent('scan_match_requested', {
        mode,
        ...(typeof slabAnalysisMs === 'number' ? { slab_analysis_ms: slabAnalysisMs } : {}),
      });
      const matchStartedAt = Date.now();
      const estimatedPayloadKB = Math.round((matchTarget.normalizedImageBase64.length * 0.75) / 1024);
      if (mode === 'raw' && process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] dispatch `
          + `captureSource=${captureSource} `
          + `nativeSource=${matchTarget.nativeSourceImageDimensions.width}x${matchTarget.nativeSourceImageDimensions.height} `
          + `rotate=${matchTarget.normalizationRotationDegrees} `
          + `normalized=${matchTarget.normalizedImageDimensions.width}x${matchTarget.normalizedImageDimensions.height} `
          + `payloadKB=${estimatedPayloadKB} `
          + `quality=${captureSource === 'camera' ? rawVisualCaptureQuality : 'fixture'}`,
        );
      }
      const matchResult = await spotlightRepository.matchScannerCapture(matchPayload);
      const endToEndMs = Date.now() - scanStartedAt;
      if (mode === 'raw' && process.env.NODE_ENV !== 'test') {
        const clientMatchMs = Date.now() - matchStartedAt;
        console.info(
          `[SCANNER VISUAL TEST] captureMs=${captureMs} `
          + `captureSource=${captureSource} `
          + `source=${rawSourceImageDimensions.width}x${rawSourceImageDimensions.height} `
          + `oriented=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `nativeSource=${matchTarget.nativeSourceImageDimensions.width}x${matchTarget.nativeSourceImageDimensions.height} `
          + `rotate=${matchTarget.normalizationRotationDegrees} `
          + `crop=${matchTarget.sourceImageCrop.width}x${matchTarget.sourceImageCrop.height} `
          + `normalized=${matchTarget.normalizedImageDimensions.width}x${matchTarget.normalizedImageDimensions.height} `
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

      if (mode === 'slabs' && matchResult.artifactUpload) {
        if (matchResult.artifactUpload.status === 'uploaded') {
          capturePostHogEvent('scan_artifact_upload_succeeded', {
            mode,
            ...(typeof matchResult.artifactUpload.roundTripMs === 'number'
              ? { upload_ms: matchResult.artifactUpload.roundTripMs }
              : {}),
          });
        } else if (matchResult.artifactUpload.status === 'failed') {
          capturePostHogEvent('scan_artifact_upload_failed', {
            error_kind: matchResult.artifactUpload.errorKind ?? 'request_failed',
            mode,
            ...(typeof matchResult.artifactUpload.roundTripMs === 'number'
              ? { upload_ms: matchResult.artifactUpload.roundTripMs }
              : {}),
          });
        }
      }

      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        activeCandidateIndex: 0,
        candidates: matchResult.candidates,
        isLoadingCandidates: false,
        matchReviewDisposition: matchResult.reviewDisposition ?? null,
        matchReviewReason: matchResult.reviewReason ?? null,
        normalizedImageDimensions: matchTarget.normalizedImageDimensions,
        normalizedImageUri: matchTarget.normalizedImageUri,
        scanID: matchResult.scanID,
        slabContext: matchResult.slabContext ?? capture.slabContext,
        sourceImageCrop: matchTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: matchTarget.normalizationRotationDegrees,
        uri: mode === 'slabs' ? capture.uri : matchTarget.normalizedImageUri,
      }));
      capturePostHogEvent('scan_match_succeeded', buildScanMatchSuccessProperties({
        artifactUploadMs: matchResult.artifactUpload?.roundTripMs ?? null,
        candidateCount: matchResult.candidates.length,
        captureMs,
        endToEndMs,
        mode,
        normalizeMs,
        requestAttemptCount: matchResult.requestAttemptCount,
        reviewDisposition: matchResult.reviewDisposition,
        roundTripMs: matchResult.roundTripMs,
        slabAnalysisMs,
        serverProcessingMs: matchResult.serverProcessingMs,
      }));
    } catch (error) {
      if (mode === 'raw') {
        logScannerDiagnostic(
          `[SCANNER VISUAL TEST] matchError `
          + `message=${scannerErrorMessage(error)} `
          + `captureSource=${captureSource} `
          + `nativeSource=${matchTarget.nativeSourceImageDimensions.width}x${matchTarget.nativeSourceImageDimensions.height} `
          + `rotate=${matchTarget.normalizationRotationDegrees} `
          + `normalized=${matchTarget.normalizedImageDimensions.width}x${matchTarget.normalizedImageDimensions.height} `
          + `payloadKB=${Math.round((matchTarget.normalizedImageBase64.length * 0.75) / 1024)}`,
          error,
        );
      }

      updateRecentCapture(captureId, (capture) => ({
        ...capture,
        candidates: [],
        isLoadingCandidates: false,
        matchReviewDisposition: null,
        matchReviewReason: null,
        normalizedImageDimensions: matchTarget.normalizedImageDimensions,
        normalizedImageUri: matchTarget.normalizedImageUri,
        scanID: null,
        sourceImageCrop: matchTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: matchTarget.normalizationRotationDegrees,
        uri: mode === 'slabs' ? capture.uri : matchTarget.normalizedImageUri,
      }));
      capturePostHogEvent('scan_match_failed', buildScanMatchFailureProperties({
        captureMs,
        endToEndMs: Date.now() - scanStartedAt,
        errorKind: scannerErrorKind(error),
        mode,
        normalizeMs,
        slabAnalysisMs,
      }));
    }
  }, [spotlightRepository, updateRecentCapture]);

  const handleCapture = useCallback(async () => {
    if (isCatalogSearchFocused) {
      setIsCatalogSearchFocused(false);
      Keyboard.dismiss();
      return;
    }

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
        slabContext: null,
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
    let captureMsForAnalytics: number | null = null;
    let normalizeMsForAnalytics: number | null = null;
    let slabAnalysisMsForAnalytics: number | null = null;

    try {
      const captureStartedAt = Date.now();
      const photo = await cameraRef.current.takePictureAsync({
        base64: scannerMode === 'slabs',
        exif: false,
        quality: scannerMode === 'raw' ? rawVisualCaptureQuality : 0.7,
        skipProcessing: false,
      });
      const captureMs = Date.now() - captureStartedAt;
      captureMsForAnalytics = captureMs;

      setIsCapturing(false);

      if (!photo?.uri) {
        capturePostHogEvent('scan_match_failed', buildScanMatchFailureProperties({
          captureMs,
          endToEndMs: Date.now() - scanStartedAt,
          errorKind: 'source_capture_unavailable',
          mode: scannerMode,
        }));
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
            slabContext: null,
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
          slabContext: null,
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
      const previewLayout = {
        height: reticleSnapshotRef.current.previewHeight,
        width: reticleSnapshotRef.current.previewWidth,
      };
      const reticleLayout = {
        height: reticleSnapshotRef.current.height,
        width: reticleSnapshotRef.current.width,
        x: reticleSnapshotRef.current.x,
        y: reticleSnapshotRef.current.y,
      };
      const normalizedTarget = scannerMode === 'raw'
        ? await buildNormalizedScannerTarget({
          previewLayout,
          reticle: reticleLayout,
          sourceImageDimensions,
          sourceImageUri: photo.uri,
        })
        : await buildSlabScannerTarget({
          previewLayout,
          reticle: reticleLayout,
          sourceImageDimensions,
          sourceImageUri: photo.uri,
        });
      const normalizeMs = Date.now() - normalizeStartedAt;
      normalizeMsForAnalytics = normalizeMs;
      if (!normalizedTarget) {
        throw new Error('normalized_target_unavailable');
      }

      let matchPayload: ScannerCapturePayload = {
        height: normalizedTarget.normalizedImageDimensions.height,
        jpegBase64: normalizedTarget.normalizedImageBase64,
        mode: scannerMode,
        width: normalizedTarget.normalizedImageDimensions.width,
      };

      let slabContext: SlabContext | null = null;
      if (scannerMode === 'slabs') {
        capturePostHogEvent('scan_slab_analysis_requested', {
          mode: 'slabs',
        });
        const analysisStartedAt = Date.now();
        const slabAnalysis = await analyzeSlabCapture(normalizedTarget.normalizedImageUri);
        slabAnalysisMsForAnalytics = Date.now() - analysisStartedAt;
        slabContext = slabContextFromAnalysis(slabAnalysis);
        capturePostHogEvent('scan_slab_analysis_succeeded', {
          cert_present: slabAnalysis.slabCertNumber ? 1 : 0,
          grade_present: slabAnalysis.slabGrade ? 1 : 0,
          mode: 'slabs',
          slab_analysis_ms: slabAnalysisMsForAnalytics,
          ...(slabAnalysis.slabGrader ? { grader: slabAnalysis.slabGrader } : {}),
          ...(slabAnalysis.slabRecommendedLookupPath
            ? { lookup_path: slabAnalysis.slabRecommendedLookupPath }
            : {}),
        });
        matchPayload = {
          ...matchPayload,
          captureSource: 'camera',
          normalizedImage: {
            jpegBase64: normalizedTarget.normalizedImageBase64,
            width: normalizedTarget.normalizedImageDimensions.width,
            height: normalizedTarget.normalizedImageDimensions.height,
          },
          slabAnalysis,
          sourceImage: photo.base64
            ? {
              jpegBase64: photo.base64,
              width: normalizedTarget.nativeSourceImageDimensions.width,
              height: normalizedTarget.nativeSourceImageDimensions.height,
            }
            : null,
          submittedAt: new Date(scanStartedAt).toISOString(),
        };
      }

      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
          normalizedImageUri: normalizedTarget.normalizedImageUri,
          slabContext,
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
        matchPayload,
        matchTarget: normalizedTarget,
        mode: scannerMode,
        normalizeMs,
        rawSourceImageDimensions,
        scanStartedAt,
        slabAnalysisMs: slabAnalysisMsForAnalytics,
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
      if (scannerMode === 'slabs') {
        capturePostHogEvent('scan_slab_analysis_failed', {
          error_kind: scannerErrorKind(error),
          mode: 'slabs',
          ...(typeof slabAnalysisMsForAnalytics === 'number'
            ? { slab_analysis_ms: slabAnalysisMsForAnalytics }
            : {}),
        });
      }
      capturePostHogEvent('scan_match_failed', buildScanMatchFailureProperties({
        captureMs: captureMsForAnalytics,
        endToEndMs: Date.now() - scanStartedAt,
        errorKind: scannerErrorKind(error),
        mode: scannerMode,
        normalizeMs: normalizeMsForAnalytics,
        slabAnalysisMs: slabAnalysisMsForAnalytics,
      }));
      setIsCapturing(false);
      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          isLoadingCandidates: false,
          matchReviewDisposition: scannerMode === 'slabs' ? 'unsupported' : null,
          matchReviewReason: scannerPreparationReviewReason(scannerMode, error),
          normalizedImageDimensions: null,
          normalizedImageUri: null,
          slabContext: null,
          sourceImageCrop: capturedSourceImageCrop,
          sourceImageDimensions: capturedSourceImageDimensions,
          sourceImageRotationDegrees: 0,
          uri: capturedPhotoUri,
        };
      }));
    }
  }, [
    isCatalogSearchFocused,
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
        slabContext: null,
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
        slabContext: null,
        sourceImageCrop: normalizedTarget.sourceImageCrop,
        sourceImageDimensions,
        sourceImageRotationDegrees: normalizedTarget.normalizationRotationDegrees,
        uri: normalizedTarget.normalizedImageUri,
      }));

      void runMatchForCapture({
        captureId,
        captureMs: 0,
        captureSource: 'smoke_fixture',
        matchPayload: {
          height: normalizedTarget.normalizedImageDimensions.height,
          jpegBase64: normalizedTarget.normalizedImageBase64,
          mode: 'raw',
          width: normalizedTarget.normalizedImageDimensions.width,
        },
        matchTarget: normalizedTarget,
        mode: 'raw',
        normalizeMs: 0,
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
      capturePostHogEvent('scan_match_failed', buildScanMatchFailureProperties({
        captureMs: 0,
        endToEndMs: Date.now() - scanStartedAt,
        errorKind: scannerErrorKind(error),
        mode: 'raw',
        normalizeMs: 0,
      }));
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

  const handleToggleFavorite = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!candidate) {
      return;
    }

    try {
      const nextFavorite = await spotlightRepository.setCardFavorite(
        candidate.cardId,
        !(candidate.isFavorite ?? false),
      );
      setRecentCaptures((current) => withUpdatedCaptureFavoriteState(
        current,
        nextFavorite.cardId,
        nextFavorite.isFavorite,
      ));
      setInventoryEntries((current) => withUpdatedInventoryFavoriteState(
        current,
        nextFavorite.cardId,
        nextFavorite.isFavorite,
      ));
      refreshData();
    } catch (error) {
      logScannerDiagnostic(
        `[SCANNER] favorite toggle failed cardID=${candidate.cardId} message=${scannerErrorMessage(error)}`,
        error,
      );
    }
  }, [recentCaptures, refreshData, spotlightRepository]);

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
      return withOptimisticInventoryAdd(current, activeCandidate, addedAt, {
        mode: capture.mode,
        slabContext: capture.slabContext,
      });
    });

    try {
      trackCandidateSelectionIfNeeded(capture);
      await spotlightRepository.createInventoryEntry({
        addedAt,
        cardID: activeCandidate.cardId,
        condition: capture.mode === 'slabs' ? null : 'near_mint',
        quantity: 1,
        selectedRank: capture.activeCandidateIndex + 1,
        selectionSource: capture.activeCandidateIndex === 0 ? 'top' : 'alternate',
        slabContext: capture.slabContext,
        sourceScanID: capture.scanID ?? null,
        variantName: capture.slabContext?.variantName ?? null,
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
      slabContext: capture.slabContext,
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

  const handleCaptureActionRailVisibilityChange = useCallback((key: string, visible: boolean) => {
    setOpenActionRailKeys((current) => {
      if (visible) {
        if (current[key]) {
          return current;
        }

        return {
          ...current,
          [key]: true,
        };
      }

      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const handleExitScanner = useCallback(() => {
    if (onExitToPortfolio) {
      onExitToPortfolio();
      return;
    }

    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/portfolio');
  }, [onExitToPortfolio, router]);

  const handleSubmitCatalogSearch = useCallback(() => {
    const trimmedQuery = catalogSearchQuery.trim();
    if (!trimmedQuery) {
      return;
    }

    router.push({
      pathname: '/catalog/search',
      params: {
        q: trimmedQuery,
      },
    });
  }, [catalogSearchQuery, router]);

  const trayHeaderPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) =>
      shouldSetRecentCaptureTrayVerticalResponder(gestureState),
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

  const trayShellPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gestureState) =>
      shouldSetRecentCaptureTrayShellResponder(gestureState, {
        isTopLevelSwipeEnabled,
        isTrayExpanded,
        scrollOffsetY: trayScrollOffsetYRef.current,
      }),
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
        && trayScrollOffsetYRef.current <= 0
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
        && trayScrollOffsetYRef.current <= 0
        && (gestureState.dy >= traySwipeThreshold || gestureState.vy >= trayVelocityThreshold);

      if (shouldExpand) {
        commitTrayExpandedState(true);
        return;
      }

      if (shouldCollapse) {
        commitTrayExpandedState(false);
      }
    },
    onPanResponderTerminate: () => {
      trayGestureCommittedRef.current = false;
    },
    onPanResponderTerminationRequest: () => false,
  }), [canToggleTray, commitTrayExpandedState, isTopLevelSwipeEnabled, isTrayExpanded]);

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
    const marketPrice = candidate?.marketPrice;
    const currencyCode = candidate?.currencyCode ?? 'USD';
    const canCycleCandidate = !!candidate && capture.candidates.length > 1;
    return (
      <RecentCaptureSwipeRow
        actionRailKey={capture.id}
        isFavorite={candidate?.isFavorite ?? false}
        key={capture.id}
        onActionRailVisibilityChange={handleCaptureActionRailVisibilityChange}
        onDelete={() => {
          deleteRecentCapture(capture.id);
        }}
        onFavorite={() => {
          void handleToggleFavorite(capture.id);
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
            {scannerCaptureThumbUri(capture, candidate) ? (
              <Image
                source={{ uri: scannerCaptureThumbUri(capture, candidate) ?? '' }}
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
            accessibilityLabel={candidate
              ? `Open ${capture.mode === 'slabs'
                ? [candidate.name, scannerSlabInlineLabel(capture)].filter(Boolean).join(' • ')
                : candidate.name}`
              : `Open recent scan ${index + 1}`}
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
                  {capture.mode === 'slabs' ? (
                    <>
                      <Text numberOfLines={1} style={[styles.captureTitle, styles.captureTitleSlab]}>
                        {candidate.name}
                      </Text>
                      {scannerSlabInlineLabel(capture) ? (
                        <Text numberOfLines={1} style={styles.captureSubtitle}>
                          {scannerSlabInlineLabel(capture)}
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <Text numberOfLines={1} style={styles.captureTitle}>
                      {candidate.name}
                    </Text>
                  )}
                  <Text numberOfLines={1} style={styles.captureSubtitle}>
                    {capture.mode === 'slabs'
                      ? scannerSlabSubtitle(capture, candidate)
                      : `${candidate.setName} • ${candidate.cardNumber}`}
                  </Text>
                </>
              ) : (
                <>
                  <Text numberOfLines={1} style={styles.captureTitle}>{captureFailureTitle(capture)}</Text>
                  <Text numberOfLines={2} style={styles.captureSubtitle}>{captureFailureSubtitle(capture)}</Text>
                </>
              )}
            </View>

            {candidate ? (
              <View style={styles.capturePriceWrap}>
                <Text style={styles.capturePriceLabel}>{scannerCapturePriceLabel(capture)}</Text>
                <Text style={styles.capturePriceValue}>
                  {formatOptionalCurrency(marketPrice, currencyCode)}
                </Text>
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
      {isActiveTab ? <ScannerKeepAwake /> : null}
      <StatusBar style="light" />
      <RawScannerCaptureSurface
        availableLensesChanged={handleAvailableLensesChanged}
        cameraRef={cameraRef}
        cameraSessionKey={cameraSessionKey}
        canCapture={canCapture}
        hasCameraPermission={hasCameraPermission}
        layout={captureSurfaceLayout}
        onCameraReady={() => {
          if (!isTestEnv) {
            setIsCameraReady(true);
            resolveRawVisualPictureSize();
          }
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
        selectedLens={preferredScannerLens}
        shouldMountCamera={shouldMountCamera}
        showSlabGuide={scannerMode === 'slabs'}
        testIDPrefix="scanner"
      >
        <View
          pointerEvents="none"
          style={[
            styles.topChromeBackdrop,
            {
              height: Math.max(
                captureSurfaceLayout.backButtonTop + 46,
                captureSurfaceLayout.reticle.y - 12,
              ),
            },
          ]}
        />
        <View
          style={[
            styles.topChromeRow,
            {
              left: 20,
              right: 20,
              top: captureSurfaceLayout.backButtonTop,
            },
          ]}
        >
          <ChromeBackButton
            accessibilityLabel="Exit scanner"
            onPress={handleExitScanner}
            testID="scanner-back-button"
          />
          <ScannerSearchLauncher
            onChangeText={setCatalogSearchQuery}
            onFocusChange={setIsCatalogSearchFocused}
            onSubmit={handleSubmitCatalogSearch}
            value={catalogSearchQuery}
          />
        </View>

        {scannerSmokeEnabled && scannerMode === 'raw' ? (
          <View
            style={[
              styles.topActionStack,
              {
                right: 18,
                top: captureSurfaceLayout.backButtonTop + 56,
              },
            ]}
          >
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
          testID="scanner-mode-toggle-wrap"
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

        <View style={styles.trayShell} testID="scanner-tray" {...trayShellPanResponder.panHandlers}>
          <Pressable
            accessibilityLabel={isTrayExpanded ? 'Collapse recent scans' : 'Expand recent scans'}
            accessibilityRole="button"
            disabled={!canToggleTray}
            hitSlop={trayHeaderHitSlop}
            onPress={toggleTrayExpanded}
            style={({ pressed }) => [
              styles.trayHeader,
              pressed && canToggleTray ? styles.trayHeaderPressed : null,
            ]}
            testID="scanner-tray-header"
            {...trayHeaderPanResponder.panHandlers}
          >
            <View style={styles.trayHandleWrap} testID="scanner-tray-handle">
              <View style={styles.trayHandle} />
            </View>
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
                    {trayPriceSummary.hasPricedCapture ? formatCurrency(trayPriceSummary.total) : '—'}
                  </Text>
                </View>
              </View>
            </View>
          </Pressable>

          <View
            style={[
              styles.trayBody,
              recentCaptures.length === 0 ? styles.trayBodyEmpty : null,
              {
                paddingBottom: trayBottomInset,
              },
              isTrayExpanded ? styles.trayBodyExpanded : null,
            ]}
            testID="scanner-tray-body"
          >
            {recentCaptures.length === 0 ? (
              <View style={styles.trayEmptyFill} testID="scanner-tray-empty-fill" />
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
                  onScroll={(event) => {
                    trayScrollOffsetYRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
                  }}
                  scrollEnabled={isTrayExpanded && trayScrollEnabled}
                  scrollEventThrottle={16}
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
  searchLauncher: {
    borderRadius: 18,
    flex: 1,
    minHeight: 40,
    minWidth: 0,
  },
  searchLauncherInput: {
    color: colors.scannerTextPrimary,
  },
  topChromeBackdrop: {
    backgroundColor: colors.scannerTray,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  topChromeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
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
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'center',
  },
  captureDeleteUnderlay: {
    alignItems: 'center',
    borderRadius: 18,
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: recentCaptureActionRailRevealWidth,
  },
  captureDeleteButton: {
    alignItems: 'center',
    backgroundColor: '#B91C1C',
    gap: 6,
    justifyContent: 'center',
    minHeight: captureRowHeight,
    width: recentCaptureDeleteRevealWidth,
  },
  captureDeleteUnderlayPressed: {
    opacity: 0.82,
  },
  captureActionRail: {
    alignItems: 'stretch',
    borderRadius: 18,
    flexDirection: 'row',
    overflow: 'hidden',
    width: recentCaptureActionRailRevealWidth,
  },
  captureFavoriteButton: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    gap: 6,
    justifyContent: 'center',
    minHeight: captureRowHeight,
    width: recentCaptureFavoriteRevealWidth,
  },
  captureFavoriteButtonPressed: {
    opacity: 0.84,
  },
  captureFavoriteLabel: {
    ...textStyles.control,
    color: colors.scannerCanvas,
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'center',
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
  captureSlabBadge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: colors.scannerOutlineSubtle,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    maxWidth: 76,
    minHeight: 22,
    paddingHorizontal: 8,
  },
  captureSlabBadgeText: {
    ...textStyles.control,
    color: colors.scannerTextPrimary,
    fontSize: 11,
    lineHeight: 13,
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
  captureTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  captureTitleSlab: {
    flex: 1,
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
  trayBody: {
    gap: 12,
    minHeight: 82,
    paddingHorizontal: 4,
    paddingTop: 0,
  },
  trayBodyEmpty: {
    minHeight: rawScannerTrayEmptyPeekHeight,
  },
  trayBodyExpanded: {
    minHeight: 0,
  },
  trayEmptyFill: {
    flex: 1,
    minHeight: rawScannerTrayEmptyPeekHeight,
  },
  trayHeader: {
    backgroundColor: colors.scannerTray,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 4,
    paddingTop: 10,
  },
  trayHeaderPressed: {
    opacity: 0.94,
  },
  trayHandle: {
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 999,
    height: 5,
    width: 48,
  },
  trayHandleWrap: {
    alignItems: 'center',
    paddingBottom: 4,
    paddingTop: 2,
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
