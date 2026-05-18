import { BlurView } from 'expo-blur';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconCheck,
  IconChevronLeft,
  IconPlus,
} from '@tabler/icons-react-native';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  LayoutAnimation,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  type CatalogSearchResult,
  type InventoryCardEntry,
  type ScannerCapturePayload,
  type SlabContext,
} from '@spotlight/api-client';
import {
  Button,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useTabsPage } from '@/contexts/tabs-page-context';
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
} from '@/features/scanner/scanner-normalized-target';
import {
  chooseRawVisualPictureSize,
  getRawScannerCollapsedTrayReservedHeight,
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
  rawScannerTrayEmptyPeekHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
import { quickClassifyCapture } from '@/features/scanner/slab-scanner-native';
import { buildSlabScannerTarget } from '@/features/scanner/scanner-slab-target';
import { loadRawScannerSmokeFixture } from '@/features/scanner/scanner-smoke-fixtures';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeValue, resolveStagingSmokeModeEnabled } from '@/lib/runtime-config';
import { useAppServices } from '@/providers/app-providers';

import { RecentCaptureSwipeRow } from './recent-capture-swipe-row';
import { ScannerSearchLauncher } from './scanner-search-launcher';
import {
  activeCandidateForCapture,
  alignToFourPointGrid,
  analyzeSlabCapture,
  buildScanMatchFailureProperties,
  buildScanMatchSuccessProperties,
  buildScanSelectionProperties,
  capturePrimaryLabel,
  captureFailureSubtitle,
  captureFailureTitle,
  formatCurrency,
  isFinitePrice,
  isNonPSAUnsupportedSlabCapture,
  logScannerDiagnostic,
  scannerCapturePriceLabel,
  scannerCaptureThumbUri,
  scannerErrorKind,
  scannerErrorMessage,
  scannerPreparationReviewReason,
  scannerSlabInlineLabel,
  scannerSlabSubtitle,
  slabContextFromAnalysis,
  triggerScannerHaptic,
  unsupportedSlabSubtitle,
  unsupportedSlabTitle,
  withOptimisticInventoryAdd,
  withUpdatedCaptureFavoriteState,
  withUpdatedInventoryFavoriteState,
} from './scanner-screen-helpers';
import type {
  CaptureMatchParams,
  RecentCapture,
} from './scanner-screen-types';

const maxStoredCaptures = 12;
const collapsedVisibleCaptures = 1;
const captureRowHeight = 88;
const captureRowGap = 8;
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
  const [ebayTrayState, setEbayTrayState] = useState<Map<string, { loading: boolean; url: string | null }>>(new Map());
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
    && isRawPictureConfigReady;
  const canToggleTray = recentCaptures.length > 0;
  const isTopLevelSwipeEnabled = Object.keys(openActionRailKeys).length === 0;
  const collapsedCaptures = recentCaptures.slice(0, collapsedVisibleCaptures);
  const visibleCaptures = isTrayExpanded ? recentCaptures : collapsedCaptures;
  const trayExpandedBodyHeight = alignToFourPointGrid(
    Math.min(Math.max((windowHeight - insets.top - insets.bottom) * 0.5, 272), 428),
  );
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight) + ((recentCaptures.length - 1) * captureRowGap);
  const trayScrollViewportHeight = recentCaptures.length > 0
    ? Math.min(trayContentHeight, trayExpandedBodyHeight)
    : Math.max(140, trayExpandedBodyHeight);
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
      !isCameraReady
      || rawVisualPictureSize != null
    ) {
      return;
    }

    resolveRawVisualPictureSize();
  }, [isCameraReady, rawVisualPictureSize, resolveRawVisualPictureSize]);

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
    const total = recentCaptures.reduce((sum, capture) => {
      const marketPrice = activeCandidateForCapture(capture)?.marketPrice;
      return isFinitePrice(marketPrice) ? sum + marketPrice : sum;
    }, 0);

    return { total };
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
      const matchResult = await spotlightRepository.matchScannerCapture(matchPayload, {
        onArtifactUploadComplete: (artifactUpload) => {
          if (!artifactUpload) {
            return;
          }
          if (artifactUpload.status === 'uploaded') {
            capturePostHogEvent('scan_artifact_upload_succeeded', {
              mode,
              ...(typeof artifactUpload.roundTripMs === 'number'
                ? { upload_ms: artifactUpload.roundTripMs }
                : {}),
            });
          } else if (artifactUpload.status === 'failed') {
            capturePostHogEvent('scan_artifact_upload_failed', {
              error_kind: artifactUpload.errorKind ?? 'request_failed',
              mode,
              ...(typeof artifactUpload.roundTripMs === 'number'
                ? { upload_ms: artifactUpload.roundTripMs }
                : {}),
            });
          }
        },
      });
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

    let capturedPhotoUri = '';
    let capturedSourceImageCrop: ScanSourceImageCrop | null = null;
    let capturedSourceImageDimensions: ScanSourceImageDimensions | null = null;
    let captureMsForAnalytics: number | null = null;
    let normalizeMsForAnalytics: number | null = null;
    let slabAnalysisMsForAnalytics: number | null = null;
    let isSlab = false;

    try {
      const captureStartedAt = Date.now();
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        exif: false,
        quality: rawVisualCaptureQuality,
        skipProcessing: false,
      });
      const captureMs = Date.now() - captureStartedAt;
      captureMsForAnalytics = captureMs;

      capturePostHogEvent('scan_capture_started', {
        mode: isSlab ? 'slabs' : 'raw',
      });

      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          mode: isSlab ? 'slabs' : 'raw',
        };
      }));

      setIsCapturing(false);

      if (!photo?.uri) {
        capturePostHogEvent('scan_match_failed', buildScanMatchFailureProperties({
          captureMs,
          endToEndMs: Date.now() - scanStartedAt,
          errorKind: 'source_capture_unavailable',
          mode: isSlab ? 'slabs' : 'raw',
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

      // Always crop to the reticle first so the classifier sees the card/slab
      // content rather than the full camera frame (where the reticle sits in the
      // center, making top/bottom strip analysis unreliable on the full photo).
      const rawNormalizedTarget = await buildNormalizedScannerTarget({
        previewLayout,
        reticle: reticleLayout,
        sourceImageDimensions,
        sourceImageUri: photo.uri,
      });
      if (!rawNormalizedTarget) {
        throw new Error('normalized_target_unavailable');
      }

      try {
        const hint = await quickClassifyCapture(rawNormalizedTarget.normalizedImageUri);
        isSlab = hint.isSlabLikely;
        capturePostHogEvent('scan_classifier_decided', {
          is_slab_likely: hint.isSlabLikely,
          confidence: hint.confidence,
          red_band_score: hint.redBandScore,
          barcode_region_score: hint.barcodeRegionScore,
          decode_ms: hint.decodeMs,
          classify_ms: hint.classifyMs,
        });
      } catch (classifierError) {
        console.warn('[SCANNER] quickClassifyCapture failed, defaulting to raw', classifierError);
        isSlab = false;
      }

      if (process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] normalizeStart `
          + `reportedSource=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `preview=${reticleSnapshotRef.current.previewWidth}x${reticleSnapshotRef.current.previewHeight} `
          + `reticle=${reticleSnapshotRef.current.width}x${reticleSnapshotRef.current.height}@${reticleSnapshotRef.current.x},${reticleSnapshotRef.current.y} `
          + `crop=${sourceImageCrop ? `${sourceImageCrop.width}x${sourceImageCrop.height}@${sourceImageCrop.x},${sourceImageCrop.y}` : 'n/a'}`,
        );
      }

      const normalizedTargetOrNull = isSlab
        ? await buildSlabScannerTarget({
          previewLayout,
          reticle: reticleLayout,
          sourceImageDimensions,
          sourceImageUri: photo.uri,
        })
        : rawNormalizedTarget;
      const normalizeMs = Date.now() - normalizeStartedAt;
      normalizeMsForAnalytics = normalizeMs;
      if (!normalizedTargetOrNull) {
        throw new Error('normalized_target_unavailable');
      }
      const normalizedTarget = normalizedTargetOrNull;
      let matchPayload: ScannerCapturePayload = {
        height: normalizedTarget.normalizedImageDimensions.height,
        jpegBase64: normalizedTarget.normalizedImageBase64,
        mode: isSlab ? 'slabs' : 'raw',
        width: normalizedTarget.normalizedImageDimensions.width,
        captureSource: 'camera',
        normalizedImage: {
          jpegBase64: normalizedTarget.normalizedImageBase64,
          width: normalizedTarget.normalizedImageDimensions.width,
          height: normalizedTarget.normalizedImageDimensions.height,
        },
        sourceImage: photo.base64
          ? {
            jpegBase64: photo.base64,
            width: normalizedTarget.nativeSourceImageDimensions.width,
            height: normalizedTarget.nativeSourceImageDimensions.height,
          }
          : null,
        submittedAt: new Date(scanStartedAt).toISOString(),
      };

      let slabContext: SlabContext | null = null;
      if (isSlab) {
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
          slabAnalysis,
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
        mode: isSlab ? 'slabs' : 'raw',
        normalizeMs,
        rawSourceImageDimensions,
        scanStartedAt,
        slabAnalysisMs: slabAnalysisMsForAnalytics,
        sourceImageDimensions,
      });
    } catch (error) {
      if (!isSlab) {
        logScannerDiagnostic(
          `[SCANNER VISUAL TEST] capturePrepError `
          + `message=${scannerErrorMessage(error)} `
          + `photoUri=${capturedPhotoUri || 'n/a'} `
          + `source=${capturedSourceImageDimensions ? `${capturedSourceImageDimensions.width}x${capturedSourceImageDimensions.height}` : 'n/a'} `
          + `crop=${capturedSourceImageCrop ? `${capturedSourceImageCrop.width}x${capturedSourceImageCrop.height}@${capturedSourceImageCrop.x},${capturedSourceImageCrop.y}` : 'n/a'}`,
          error,
        );
      }
      if (isSlab) {
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
        mode: isSlab ? 'slabs' : 'raw',
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
          matchReviewDisposition: isSlab ? 'unsupported' : null,
          matchReviewReason: scannerPreparationReviewReason(isSlab ? 'slabs' : 'raw', error),
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
    runMatchForCapture,
  ]);

  const handleTriggerSmokeFixture = useCallback(async () => {
    if (!scannerSmokeEnabled || isCapturing) {
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
  }, [isCapturing, scannerSmokeEnabled, runMatchForCapture, updateRecentCapture]);

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

  const handleSellFromCapture = useCallback((captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !candidate) {
      return;
    }
    const entryId = inventoryByCardId.get(candidate.cardId)?.entryIds?.[0];
    if (entryId) {
      router.push({
        pathname: '/sell/[entryId]',
        params: { entryId, cardId: candidate.cardId, fromScan: '1' },
      });
      return;
    }
    router.push({
      pathname: '/sell/[entryId]',
      params: { entryId: 'new', cardId: candidate.cardId, fromScan: '1' },
    });
  }, [inventoryByCardId, recentCaptures, router]);

  const handleEbayTrayTap = useCallback((captureId: string, slabContext: { grader?: string | null; grade?: string | null; certNumber?: string | null; variantName?: string | null } | null) => {
    const existing = ebayTrayState.get(captureId);
    if (existing?.url) {
      void Linking.openURL(existing.url);
      return;
    }
    if (existing?.loading) return;
    setEbayTrayState((prev) => new Map(prev).set(captureId, { loading: true, url: null }));
    void spotlightRepository.getCardRecentSales({
      cardId: recentCaptures.find((c) => c.id === captureId)
        ? (activeCandidateForCapture(recentCaptures.find((c) => c.id === captureId)!)?.cardId ?? '')
        : '',
      limit: 10,
      refresh: true,
      slabContext: slabContext && slabContext.grader
        ? {
          grader: slabContext.grader,
          grade: slabContext.grade,
          certNumber: slabContext.certNumber,
          variantName: slabContext.variantName,
        }
        : null,
      source: 'ebay',
    })
      .then((result) => {
        const url = result?.sales[0]?.saleUrl ?? null;
        setEbayTrayState((prev) => new Map(prev).set(captureId, { loading: false, url }));
        if (url) void Linking.openURL(url);
      })
      .catch(() => {
        setEbayTrayState((prev) => new Map(prev).set(captureId, { loading: false, url: null }));
      });
  }, [ebayTrayState, recentCaptures, spotlightRepository]);

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

    router.dismissTo({ pathname: '/', params: { page: 'portfolio' } });
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

  const handleOpenExpansionBrowser = useCallback(() => {
    router.push('/catalog/expansion-browser');
  }, [router]);

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
        : 'Tap to scan';

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
          <BlurView
            intensity={20}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
            tint="dark"
          />
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
                  <Text numberOfLines={1} style={styles.captureTitle}>
                    {candidate.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.captureSubtitle}>
                    {candidate.cardNumber}
                  </Text>
                  <Text numberOfLines={1} style={styles.captureSubtitle}>
                    {candidate.setName}
                  </Text>
                  {capture.mode === 'slabs' && scannerSlabInlineLabel(capture) ? (
                    <Text numberOfLines={1} style={styles.captureSubtitle}>
                      {scannerSlabInlineLabel(capture)}
                    </Text>
                  ) : null}
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
                <Text style={styles.capturePriceValue}>
                  {formatCurrency(isFinitePrice(marketPrice) ? marketPrice : 0, currencyCode)}
                </Text>
                <Text style={styles.capturePriceLabel}>Market avg</Text>
                {capture.mode === 'slabs' ? (() => {
                  const ebayState = ebayTrayState.get(capture.id);
                  const isLoading = ebayState?.loading ?? false;
                  return (
                    <Pressable
                      accessibilityLabel="View on eBay"
                      accessibilityRole="button"
                      disabled={isLoading}
                      hitSlop={6}
                      onPress={() => void handleEbayTrayTap(capture.id, capture.slabContext ?? null)}
                      style={{ opacity: ebayState?.url ? 1 : 0.4 }}
                      testID={`scanner-tray-ebay-${index}`}
                    >
                      {isLoading ? (
                        <ActivityIndicator color={colors.brand} size="small" />
                      ) : (
                        <View style={styles.captureMpRow}>
                          <Image
                            source={require('../../../../assets/images/ebay-icon.png')}
                            style={styles.captureMpIcon}
                          />
                          <Text style={styles.captureMpLabel}>View on eBay</Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })() : (
                  <Pressable
                    accessibilityLabel="View on TCGplayer"
                    accessibilityRole="button"
                    hitSlop={6}
                    onPress={() => {
                      const url = [
                        candidate.name,
                        candidate.cardNumber?.replace(/^#/, ''),
                        candidate.setName,
                      ].filter(Boolean).join(' ');
                      if (url) {
                        void Linking.openURL(
                          `https://www.tcgplayer.com/search/pokemon/product?${new URLSearchParams({ q: url, view: 'grid' }).toString()}`,
                        );
                      }
                    }}
                    testID={`scanner-tray-tcg-${index}`}
                  >
                    <View style={styles.captureMpRow}>
                      <Image
                        source={require('../../../../assets/images/tcgplayer-icon.png')}
                        style={styles.captureMpIcon}
                      />
                      <Text style={styles.captureMpLabel}>View on TCGPlayer</Text>
                    </View>
                  </Pressable>
                )}
              </View>
            ) : null}
          </Pressable>

        {candidate ? (
          <View style={styles.captureActionsColumn}>
            {quantity > 0 ? (
              <Pressable
                accessibilityLabel={`${candidate.name} added to collection`}
                accessibilityRole="button"
                onPress={() => undefined}
                style={styles.captureAddedButton}
                testID={`scanner-tray-added-${index}`}
              >
                <IconCheck color="#1A1A1A" size={20} strokeWidth={2.5} />
              </Pressable>
            ) : (
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
                ]}
                testID={`scanner-tray-add-${index}`}
              >
                {capture.isAddingToInventory ? (
                  <ActivityIndicator color={colors.brand} size="small" />
                ) : (
                  <IconPlus color={colors.brand} size={20} strokeWidth={2} />
                )}
              </Pressable>
            )}
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
        pictureSize={rawVisualPictureSize}
        prompt={promptCopy}
        selectedLens={preferredScannerLens}
        shouldMountCamera={shouldMountCamera}
        showSlabGuide={false}
        testIDPrefix="scanner"
      >
        {isTrayExpanded ? (
          <Pressable
            accessibilityLabel="Collapse recent scans"
            accessibilityRole="button"
            onPress={() => commitTrayExpandedState(false)}
            style={StyleSheet.absoluteFillObject}
            testID="scanner-tray-collapse-backdrop"
          />
        ) : null}

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
          <Pressable
            accessibilityLabel="Exit scanner"
            accessibilityRole="button"
            hitSlop={8}
            onPress={handleExitScanner}
            style={styles.scannerBackButton}
            testID="scanner-back-button"
          >
            <IconChevronLeft color={colors.gray0} size={18} strokeWidth={1} />
          </Pressable>
          <ScannerSearchLauncher
            onChangeText={setCatalogSearchQuery}
            onFilterPress={handleOpenExpansionBrowser}
            onFocusChange={setIsCatalogSearchFocused}
            onSubmit={handleSubmitCatalogSearch}
            value={catalogSearchQuery}
          />
        </View>

        {scannerSmokeEnabled ? (
          <View
            style={[
              styles.topActionStack,
              {
                right: 18,
                top: captureSurfaceLayout.backButtonTop + 56,
              },
            ]}
          >
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
          </View>
        ) : null}

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
                    <Text style={styles.clearPillText}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.recentScansActions}>
                <View style={styles.valuePill}>
                  <Text style={styles.valuePillText} testID="scanner-value-pill-text">
                    {formatCurrency(trayPriceSummary.total)}
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
  scannerBackButton: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.gray0,
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  topChromeBackdrop: {
    backgroundColor: 'transparent',
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
  captureActionsColumn: {
    alignItems: 'stretch',
    gap: 6,
    justifyContent: 'center',
    minWidth: 64,
  },
  captureSellButton: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  captureSellButtonPressed: {
    opacity: 0.86,
  },
  captureSellButtonLabel: {
    ...textStyles.control,
    color: '#000000',
  },
  captureAddButton: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.brand,
    borderRadius: 10,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  captureAddedButton: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    borderRadius: 10,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  captureAddButtonDisabled: {
    opacity: 0.52,
  },
  captureAddButtonPressed: {
    opacity: 0.86,
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
  captureMpRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  captureMpIcon: {
    height: 16,
    resizeMode: 'contain',
    width: 28,
  },
  captureMpLabel: {
    ...textStyles.caption,
    color: colors.scannerTextMeta,
  },
  captureRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    minHeight: captureRowHeight,
    overflow: 'hidden',
    padding: 12,
    width: '100%',
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
    backgroundColor: 'transparent',
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
    backgroundColor: 'transparent',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
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
