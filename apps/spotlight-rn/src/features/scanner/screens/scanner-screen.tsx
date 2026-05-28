import { BlurView } from 'expo-blur';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronLeft,
  IconSearch,
} from '@tabler/icons-react-native';
import { RefreshDouble } from 'iconoir-react-native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
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

import {
  type CatalogSearchResult,
  type DeckConditionCode,
  type InventoryCardEntry,
  type ScannerCapturePayload,
  type SlabContext,
} from '@spotlight/api-client';
import {
  Button,
  colors,
  fontFamilies,
  textStyles,
  Toast,
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
  rawScannerTrayHeaderHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
import { quickClassifyCapture } from '@/features/scanner/slab-scanner-native';
import { buildSlabScannerTarget } from '@/features/scanner/scanner-slab-target';
import { loadRawScannerSmokeFixture } from '@/features/scanner/scanner-smoke-fixtures';
import { readRawCollectorNumber } from '@/features/scanner/raw-collector-number-ocr';
import {
  copyToScansDir,
  deleteScanFile,
  ensureScansDir,
  flushPersist,
  loadPersistedTray,
  RECENT_CAPTURES_MAX,
  schedulePersist,
  sweepOrphanScans,
} from '@/features/scanner/recent-captures-persistence';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeBoolean, resolveRuntimeValue, resolveStagingSmokeModeEnabled } from '@/lib/runtime-config';
import { useAppServices } from '@/providers/app-providers';

import { ScanTargetPill } from '@/features/scanner/components/scan-target-pill';
import { ScanningForSheet } from '@/features/scanner/components/scanning-for-sheet';
import {
  cardLanguageForCardType,
  scanTargetPillLabel,
  useScannerTargetConfig,
  type ScannerCardType,
} from '@/features/scanner/use-scanner-target-config';

import { ChangeCardPicker } from './change-card-picker';
import { RecentCaptureSwipeRow } from './recent-capture-swipe-row';
import { ScanPriceSheet, type ScanPriceSheetSelection } from './scan-price-sheet';
import {
  activeCandidateForCapture,
  alignToFourPointGrid,
  analyzeSlabCapture,
  buildScanMatchFailureProperties,
  buildScanMatchSuccessProperties,
  buildScanSelectionProperties,
  buildUnifiedMismatchWarning,
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

const maxStoredCaptures = RECENT_CAPTURES_MAX;
const collapsedVisibleCaptures = 1;

// Phase 2 raw collector-number OCR (SECONDARY verification only). Default OFF.
// Enable per-build for on-device latency measurement. Requires the custom dev
// client (native ML Kit text reader); no-ops gracefully in Expo Go. Must be
// measured on a real device before the backend tiebreak flag is enabled.
const rawCollectorNumberOcrEnabled = resolveRuntimeBoolean(
  ['EXPO_PUBLIC_SPOTLIGHT_RAW_COLLECTOR_NUMBER_OCR_ENABLED'],
  ['spotlightRawCollectorNumberOcrEnabled'],
  false,
);
const captureRowHeight = 102;
const captureRowGap = 16;
// Only surface a language-mismatch warning when the backend's visual language
// probe is strongly confident. Below this the probe is too noisy at a card
// show (e.g. Lechonk on EN → flagged as JP) and the warning would mostly
// cry wolf. Tunable as the probe improves.
const LANGUAGE_MISMATCH_CONFIDENCE_THRESHOLD = 0.9;
// Height of the next-row "peek" sliver below the fully-visible top row. ~1/8
// of a row exposes the top of the next card's image and its title baseline —
// enough to signal that swiping/expanding reveals more, without dominating
// the camera viewport.
const collapsedPeekHeight = 14;
const recentlyAddedDurationMs = 10000;
const trayExpandedTopGap = 48;
const trayTopChromeReservedHeight = 54;
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


function applyCapEviction(
  nextItems: RecentCapture[],
  insertingMode: 'raw' | 'slabs',
): RecentCapture[] {
  if (nextItems.length <= maxStoredCaptures) {
    return nextItems;
  }
  const survivors = nextItems.slice(0, maxStoredCaptures);
  const dropped = nextItems.slice(maxStoredCaptures);
  capturePostHogEvent('scan_tray_evicted_for_cap', {
    evicted_count: dropped.length,
    mode: insertingMode,
  });
  dropped.forEach((item) => {
    if (item.normalizedImageUri) {
      void deleteScanFile(item.normalizedImageUri, 'cap_evict');
    }
    if (item.uri && item.uri !== item.normalizedImageUri) {
      void deleteScanFile(item.uri, 'cap_evict');
    }
  });
  return survivors;
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
  const { cardType, condition, setCardType, setCondition } = useScannerTargetConfig();
  const [isScanTargetSheetOpen, setIsScanTargetSheetOpen] = useState(false);
  const [isRawPictureConfigReady, setIsRawPictureConfigReady] = useState(
    isTestEnv || cachedRawVisualPictureSize != null,
  );
  const [rawVisualPictureSize, setRawVisualPictureSize] = useState<string | undefined>(
    cachedRawVisualPictureSize,
  );
  const [cameraSessionKey, setCameraSessionKey] = useState(0);
  const [availableBackLenses, setAvailableBackLenses] = useState<string[]>([]);
  const [ebayTrayState, setEbayTrayState] = useState<Map<string, { loading: boolean; url: string | null }>>(new Map());
  const [priceSelection, setPriceSelection] = useState<Map<string, ScanPriceSheetSelection>>(new Map());
  const [activePriceCaptureId, setActivePriceCaptureId] = useState<string | null>(null);
  const [activeChangeCaptureId, setActiveChangeCaptureId] = useState<string | null>(null);
  // Tracks which captures had a mismatch warning SHOWN at scan time. Set when
  // the warning fires, never cleared by Toast dismiss. Used by
  // handleAddToInventory to pass `userOverrodeMismatchWarning` to the backend
  // so the resulting scan_events row can be flagged for human re-labeling
  // (the photo is real, but the user's confirmed label may not match what the
  // photo actually shows — keep it but quarantine from automated training).
  const [shownWarningKind, setShownWarningKind] = useState<Map<string, 'language' | 'condition' | 'both'>>(new Map());
  const hasFocusedScannerRef = useRef(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<CameraView | null>(null);
  const isResolvingPictureSizeRef = useRef(false);
  const trayGestureCommittedRef = useRef(false);
  const trayScrollOffsetYRef = useRef(0);
  const reticleSnapshotRef = useRef({ height: 0, previewHeight: 0, previewWidth: 0, width: 0, x: 0, y: 0 });
  const recentlyAddedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = recentlyAddedTimersRef.current;
    return () => {
      timers.forEach((timerId) => clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  // Rehydrate the tray from disk on first mount. Runs once per scanner-screen
  // lifecycle; the persistence module's own AsyncStorage read is cheap and
  // does not block paint (the scanner renders against the empty tray until
  // this resolves, then state updates and the rows pop in). Also kicks off a
  // background orphan-file sweep so cap-evicted/force-quit-lost files don't
  // accumulate forever.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureScansDir();
        const loaded = await loadPersistedTray();
        if (cancelled || loaded.length === 0) {
          return;
        }
        setRecentCaptures((current) => (current.length > 0 ? current : loaded));
        void sweepOrphanScans(new Set(loaded.map((item) => item.id)));
      } catch {
        // Persistence errors are reported inside the module via PostHog.
        // A failed rehydrate just leaves the tray empty for this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on every tray change, debounced inside the module so rapid scans
  // coalesce into one AsyncStorage write. Loading items are skipped by the
  // module itself, so the very first persist of any given scan naturally
  // happens after the match resolves.
  useEffect(() => {
    schedulePersist(recentCaptures);
  }, [recentCaptures]);

  // Flush any pending debounced write on unmount so a force-background right
  // after a scan doesn't lose the most recent state.
  useEffect(() => () => {
    void flushPersist();
  }, []);

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
  // In the collapsed state we render ONE extra row past `collapsedVisibleCaptures`
  // so it can peek beneath the fully-visible row(s). The viewport's overflow:hidden
  // + collapsedViewportHeight crops that extra row to `collapsedPeekHeight` so only
  // the top sliver is shown. Without rendering the extra row, the reserved peek
  // space below the top row just rendered as empty (the bug this fixes).
  const collapsedCaptures = recentCaptures.slice(0, collapsedVisibleCaptures + 1);
  const visibleCaptures = isTrayExpanded ? recentCaptures : collapsedCaptures;
  const trayExpandedBodyHeight = alignToFourPointGrid(
    Math.max(
      windowHeight - insets.top - trayTopChromeReservedHeight - trayExpandedTopGap - rawScannerTrayHeaderHeight - trayBottomInset,
      272,
    ),
  );
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight) + ((recentCaptures.length - 1) * captureRowGap);
  const trayScrollViewportHeight = recentCaptures.length > 0
    ? Math.min(trayContentHeight, trayExpandedBodyHeight)
    : Math.max(140, trayExpandedBodyHeight);
  const trayScrollEnabled = trayContentHeight > trayScrollViewportHeight;
  const collapsedViewportHeight = recentCaptures.length >= 2
    ? captureRowHeight + captureRowGap + collapsedPeekHeight
    : captureRowHeight;
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

  const deleteRecentCapture = useCallback((captureId: string) => {
    setRecentCaptures((current) => {
      const removed = current.find((capture) => capture.id === captureId);
      if (removed) {
        void deleteScanFile(removed.normalizedImageUri, 'swipe');
        if (removed.uri && removed.uri !== removed.normalizedImageUri) {
          void deleteScanFile(removed.uri, 'swipe');
        }
      }
      return current.filter((capture) => capture.id !== captureId);
    });
    setPriceSelection((current) => {
      if (!current.has(captureId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(captureId);
      return next;
    });
    setShownWarningKind((current) => {
      if (!current.has(captureId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(captureId);
      return next;
    });
  }, []);

  const performClearAllCaptures = useCallback(() => {
    const clearStartedAt = Date.now();
    setRecentCaptures((current) => {
      const uris: string[] = [];
      current.forEach((capture) => {
        if (capture.normalizedImageUri) {
          uris.push(capture.normalizedImageUri);
        }
        if (capture.uri && capture.uri !== capture.normalizedImageUri) {
          uris.push(capture.uri);
        }
      });
      void (async () => {
        await Promise.all(uris.map((uri) => deleteScanFile(uri, 'clear_all')));
      })();
      capturePostHogEvent('scan_tray_cleared', {
        cleared_count: current.length,
        clear_ms: Date.now() - clearStartedAt,
      });
      return [];
    });
    setPriceSelection(new Map());
    setEbayTrayState(new Map());
    setOpenActionRailKeys({});
    setActivePriceCaptureId(null);
    setActiveChangeCaptureId(null);
    setShownWarningKind(new Map());
    // Don't wait for the debounce window — overwrite storage immediately so a
    // force-quit right after Clear All can't resurrect just-deleted scans.
    void flushPersist();
  }, []);

  const handleClearAllCaptures = useCallback(() => {
    Alert.alert(
      'Clear all scans?',
      'This permanently removes every scan in the tray.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: performClearAllCaptures },
      ],
    );
  }, [performClearAllCaptures]);

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
    rawCollectorNumberPromise,
  }: CaptureMatchParams) => {
    try {
      capturePostHogEvent('scan_match_requested', {
        mode,
        ...(typeof slabAnalysisMs === 'number' ? { slab_analysis_ms: slabAnalysisMs } : {}),
      });
      const matchStartedAt = Date.now();

      // Phase 2: resolve the on-device collector-number reading that was started
      // (concurrently with normalization / state updates) by the capture handler
      // and fold it into the payload as SECONDARY verification before the request
      // body is built. Never blocks beyond the OCR it was already running, and
      // never fails the scan (the promise resolves to null on any error).
      let resolvedMatchPayload = matchPayload;
      if (rawCollectorNumberPromise) {
        const rawCollectorNumber = await rawCollectorNumberPromise;
        if (rawCollectorNumber) {
          resolvedMatchPayload = {
            ...matchPayload,
            ocrAnalysis: {
              rawEvidence: { collectorNumberExact: rawCollectorNumber },
            },
          };
          capturePostHogEvent('scan_raw_collector_number_read', { mode });
        }
      }
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
      const matchResult = await spotlightRepository.matchScannerCapture(resolvedMatchPayload, {
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

      // Wrong-toggle soft warning: when the backend's visual language probe is
      // confident the scanned card is a different language than the selected
      // toggle, set a suggestion on the capture so the global mismatch Toast
      // can offer "Switch & rescan" / "Keep result". The scan result still
      // paints — the user keeps the match and decides what to do. Gated on
      // confidence so weak signals (Lechonk-on-EN style false positives)
      // don't cry wolf.
      if (
        matchResult.targetLanguageMismatch
        && matchResult.targetLanguageMismatch.confidence >= LANGUAGE_MISMATCH_CONFIDENCE_THRESHOLD
      ) {
        const detectedLanguage = matchResult.targetLanguageMismatch.detected;
        const suggestedCardType: ScannerCardType =
          detectedLanguage === 'japanese' ? 'pokemon_jp' : 'pokemon_en';
        updateRecentCapture(captureId, (capture) => ({
          ...capture,
          languageMismatchSuggestion: suggestedCardType,
        }));
        setShownWarningKind((current) => {
          const existing = current.get(captureId);
          const next = new Map(current);
          next.set(captureId, existing === 'condition' ? 'both' : 'language');
          return next;
        });
        capturePostHogEvent('scan_warning_shown', {
          warning_kind: 'language',
          mode,
          selected_card_language: matchResult.targetLanguageMismatch.selected,
          detected_card_language: detectedLanguage,
          confidence: matchResult.targetLanguageMismatch.confidence,
        });
        // Intentionally do NOT return — let the normal candidate-paint code
        // below run so the user sees the result alongside the warning Toast.
      }

      const paintedAt = Date.now();
      // Grabbed inside the updater so we can copy the slab raw photo (which
      // lives at `capture.uri` for slab rows) after paint.
      let slabRawSourceUri: string | null = null;
      updateRecentCapture(captureId, (capture) => {
        if (mode === 'slabs') {
          slabRawSourceUri = capture.uri || null;
        }
        return {
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
        };
      });
      // Persistence copy. Fire-and-forget AFTER the result has been painted —
      // the user already sees their match. We measure the gap between paint
      // and the moment the copy is queued (persist_copy_queued_after_paint_ms)
      // and ship it on scan_match_succeeded so any regression that sneaks
      // persistence onto the scan hot path is visible in PostHog.
      const persistCopyQueuedAfterPaintMs = Date.now() - paintedAt;
      void (async () => {
        const normalizedPermanent = await copyToScansDir(
          matchTarget.normalizedImageUri,
          captureId,
          'normalized',
          mode,
        );
        const slabRawPermanent = mode === 'slabs' && slabRawSourceUri
          ? await copyToScansDir(slabRawSourceUri, captureId, 'raw', 'slabs')
          : null;
        if (!normalizedPermanent && !slabRawPermanent) {
          return;
        }
        updateRecentCapture(captureId, (capture) => ({
          ...capture,
          normalizedImageUri: normalizedPermanent ?? capture.normalizedImageUri,
          uri: mode === 'slabs'
            ? (slabRawPermanent ?? capture.uri)
            : (normalizedPermanent ?? capture.uri),
        }));
      })();
      capturePostHogEvent('scan_match_succeeded', buildScanMatchSuccessProperties({
        candidateCount: matchResult.candidates.length,
        captureMs,
        endToEndMs,
        mode,
        normalizeMs,
        persistCopyQueuedAfterPaintMs,
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
    // Per-capture mismatch warnings live on the capture row itself (cleared on
    // dismiss / auto-dismiss / swipe-delete), so we no longer touch global state.
    const scanStartedAt = Date.now();
    setIsCapturing(true);

    const captureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRecentCaptures((current) => applyCapEviction([
      {
        activeCandidateIndex: 0,
        candidates: [],
        conditionMismatchSuggestion: null,
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
        languageMismatchSuggestion: null,
        matchReviewDisposition: null,
        matchReviewReason: null,
        mode: 'raw' as const,
        normalizedImageDimensions: null,
        normalizedImageUri: null,
        recentlyAdded: false,
        scanID: null,
        slabContext: null,
        sourceImageCrop: null,
        sourceImageDimensions: null,
        sourceImageRotationDegrees: 0,
        uri: '',
      },
      ...current,
    ], 'raw'));

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

      // The user's "Scanning for" condition is authoritative for the scan lane:
      // Graded → slab lane, Ungraded → raw lane. Trusting the toggle lets us skip
      // the slab re-normalize + analyzeSlabCapture work on raw scans and tells the
      // backend the lane up front instead of re-inferring it.
      isSlab = condition === 'graded';

      if (process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] normalizeStart `
          + `reportedSource=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `preview=${reticleSnapshotRef.current.previewWidth}x${reticleSnapshotRef.current.previewHeight} `
          + `reticle=${reticleSnapshotRef.current.width}x${reticleSnapshotRef.current.height}@${reticleSnapshotRef.current.x},${reticleSnapshotRef.current.y} `
          + `crop=${sourceImageCrop ? `${sourceImageCrop.width}x${sourceImageCrop.height}@${sourceImageCrop.x},${sourceImageCrop.y}` : 'n/a'}`,
        );
      }

      // Symmetric on-device classifier: runs on BOTH lanes to power the inline
      // mismatch warning chip. The classifier is non-authoritative for the lane
      // (the toggle decides) — its sole job here is to suggest "looks like a
      // graded slab" on the raw lane and "looks like a raw card" on the graded
      // lane. On the graded lane we kick it off in parallel with
      // buildSlabScannerTarget via Promise.all so the wall-clock added is ~0ms
      // (both consume the normalized image, neither depends on the other, and
      // the native classifier runs on its own thread).
      const classifierHintPromise = quickClassifyCapture(
        rawNormalizedTarget.normalizedImageUri,
        // Pass the original source photo for barcode detection — the normalized
        // target is squished to raw-card portrait (630×880) which distorts
        // landscape PSA slab barcodes and causes ML Kit to miss them.
        photo.uri,
      ).then(
        (hint) => ({ ok: true as const, hint }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const [normalizedTargetOrNull, classifierOutcome] = await Promise.all([
        isSlab
          ? buildSlabScannerTarget({
            previewLayout,
            reticle: reticleLayout,
            sourceImageDimensions,
            sourceImageUri: photo.uri,
          })
          : Promise.resolve(rawNormalizedTarget),
        classifierHintPromise,
      ]);

      if (classifierOutcome.ok) {
        const hint = classifierOutcome.hint;
        if (!isSlab) {
          const looksLikeSlab = hint.isSlabLikely
            || (hint.hasBarcode ?? false)
            || hint.redBandScore >= 0.12;
          console.info(
            `[SCANNER CLASSIFIER] lane=raw(selected) looksLikeSlab=${looksLikeSlab} isSlabLikely=${hint.isSlabLikely} hasBarcode=${hint.hasBarcode ?? false} confidence=${hint.confidence.toFixed(3)} redBand=${hint.redBandScore.toFixed(3)} barcodeRegion=${hint.barcodeRegionScore.toFixed(3)} decodeMs=${hint.decodeMs} classifyMs=${hint.classifyMs}`,
          );
          if (looksLikeSlab) {
            updateRecentCapture(captureId, (capture) => ({
              ...capture,
              conditionMismatchSuggestion: 'graded',
            }));
            setShownWarningKind((current) => {
              const existing = current.get(captureId);
              const next = new Map(current);
              next.set(captureId, existing === 'language' ? 'both' : 'condition');
              return next;
            });
            capturePostHogEvent('scan_warning_shown', {
              warning_kind: 'condition',
              mode: 'raw',
              suggested: 'graded',
              is_slab_likely: hint.isSlabLikely,
              has_barcode: hint.hasBarcode ?? false,
              confidence: hint.confidence,
              red_band_score: hint.redBandScore,
              barcode_region_score: hint.barcodeRegionScore,
            });
          }
        } else {
          // Slab-lane inverse: all positive slab signals absent → probably raw.
          const looksLikeRaw = !hint.isSlabLikely
            && !(hint.hasBarcode ?? false)
            && hint.redBandScore < 0.12;
          console.info(
            `[SCANNER CLASSIFIER] lane=slabs(selected) looksLikeRaw=${looksLikeRaw} isSlabLikely=${hint.isSlabLikely} hasBarcode=${hint.hasBarcode ?? false} confidence=${hint.confidence.toFixed(3)} redBand=${hint.redBandScore.toFixed(3)} barcodeRegion=${hint.barcodeRegionScore.toFixed(3)} decodeMs=${hint.decodeMs} classifyMs=${hint.classifyMs}`,
          );
          if (looksLikeRaw) {
            updateRecentCapture(captureId, (capture) => ({
              ...capture,
              conditionMismatchSuggestion: 'ungraded',
            }));
            setShownWarningKind((current) => {
              const existing = current.get(captureId);
              const next = new Map(current);
              next.set(captureId, existing === 'language' ? 'both' : 'condition');
              return next;
            });
            capturePostHogEvent('scan_warning_shown', {
              warning_kind: 'condition',
              mode: 'slabs',
              suggested: 'ungraded',
              is_slab_likely: hint.isSlabLikely,
              has_barcode: hint.hasBarcode ?? false,
              confidence: hint.confidence,
              red_band_score: hint.redBandScore,
              barcode_region_score: hint.barcodeRegionScore,
            });
          }
        }
      } else {
        // Non-fatal — quickClassifyCapture throws when the native module is
        // unavailable (Expo Go). Just skip the warning for this capture.
        console.warn('[SCANNER] quickClassifyCapture mismatch check failed', classifierOutcome.error);
      }
      const normalizeMs = Date.now() - normalizeStartedAt;
      normalizeMsForAnalytics = normalizeMs;
      if (!normalizedTargetOrNull) {
        throw new Error('normalized_target_unavailable');
      }
      const normalizedTarget = normalizedTargetOrNull;

      // Phase 2: kick off raw collector-number OCR HERE so it runs concurrently
      // with the remaining capture work (source-base64 read, state updates) and
      // the network match request — never sequentially before/after. The promise
      // is awaited inside runMatchForCapture and folded into the payload as a
      // SECONDARY verification signal. Raw lane only; no-ops when the flag is off
      // or the native text reader is unavailable (Expo Go).
      const rawCollectorNumberPromise =
        !isSlab && rawCollectorNumberOcrEnabled
          ? readRawCollectorNumber(normalizedTarget.normalizedImageUri)
          : null;

      // expo-camera occasionally returns photo.base64 = undefined under memory
      // pressure. Fall back to reading from disk so the artifact upload always
      // has a source image and scan data is never silently dropped.
      let sourceBase64 = photo.base64 ?? null;
      if (!sourceBase64 && photo.uri) {
        try {
          sourceBase64 = await FileSystem.readAsStringAsync(photo.uri, {
            encoding: 'base64',
          });
        } catch {
          // Non-fatal: the source capture is optional. The artifact upload now
          // proceeds with the normalized_target alone (the training-critical
          // image), so the scan's data is no longer dropped — only the optional
          // source context is omitted.
        }
      }
      if (!sourceBase64) {
        // Breadcrumb so we can measure how often the optional source image drops
        // (the dominant cause of the 2026-05 card-show artifact loss).
        capturePostHogEvent('scan_source_base64_missing', {
          mode: isSlab ? 'slabs' : 'raw',
          had_photo_uri: Boolean(photo.uri),
        });
      }

      let matchPayload: ScannerCapturePayload = {
        height: normalizedTarget.normalizedImageDimensions.height,
        jpegBase64: normalizedTarget.normalizedImageBase64,
        mode: isSlab ? 'slabs' : 'raw',
        cardLanguage: cardLanguageForCardType(cardType),
        width: normalizedTarget.normalizedImageDimensions.width,
        captureSource: 'camera',
        normalizedImage: {
          jpegBase64: normalizedTarget.normalizedImageBase64,
          width: normalizedTarget.normalizedImageDimensions.width,
          height: normalizedTarget.normalizedImageDimensions.height,
        },
        sourceImage: sourceBase64
          ? {
            jpegBase64: sourceBase64,
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
          mode: isSlab ? 'slabs' : 'raw',
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
        rawCollectorNumberPromise,
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
          mode: isSlab ? 'slabs' : 'raw',
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
    cardType,
    condition,
    isCameraReady,
    isCapturing,
    permission,
    requestPermission,
    runMatchForCapture,
    updateRecentCapture,
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
    setRecentCaptures((current) => applyCapEviction([
      {
        activeCandidateIndex: 0,
        candidates: [],
        conditionMismatchSuggestion: null,
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
        languageMismatchSuggestion: null,
        matchReviewDisposition: null,
        matchReviewReason: null,
        mode: 'raw' as const,
        normalizedImageDimensions: null,
        normalizedImageUri: null,
        recentlyAdded: false,
        scanID: null,
        slabContext: null,
        sourceImageCrop: null,
        sourceImageDimensions: null,
        sourceImageRotationDegrees: 0,
        uri: '',
      },
      ...current,
    ], 'raw'));

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

  const setActiveCandidate = useCallback((captureId: string, nextIndex: number) => {
    setRecentCaptures((current) => current.map((capture) => {
      if (capture.id !== captureId) {
        return capture;
      }
      const safeIndex = Math.max(0, Math.min(nextIndex, capture.candidates.length - 1));
      if (safeIndex === capture.activeCandidateIndex) {
        return capture;
      }
      return { ...capture, activeCandidateIndex: safeIndex };
    }));
  }, []);

  const openChangeCardPicker = useCallback((captureId: string) => {
    setActiveChangeCaptureId(captureId);
  }, []);

  const closeChangeCardPicker = useCallback(() => {
    setActiveChangeCaptureId(null);
  }, []);

  // Dismisses the global mismatch Toast for a capture (X tap or 10s auto-dismiss).
  // Clears the suggestion fields so the Toast disappears. We deliberately do
  // NOT clear `shownWarningKind` — that Map is the data-quality breadcrumb
  // used to flag inventory adds where the user saw a warning before
  // confirming.
  const handleToastDismiss = useCallback((captureId: string) => {
    setRecentCaptures((current) => {
      let didClear = false;
      let warningKind: 'language' | 'condition' | 'both' | null = null;
      const next = current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }
        const warning = buildUnifiedMismatchWarning(capture);
        if (warning) {
          warningKind = warning.kind;
          didClear = true;
        }
        return {
          ...capture,
          conditionMismatchSuggestion: null,
          languageMismatchSuggestion: null,
        };
      });
      if (didClear && warningKind) {
        capturePostHogEvent('scan_warning_dismissed', {
          warning_kind: warningKind,
        });
      }
      return next;
    });
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

    let didSucceed = false;
    const overrodeMismatchWarning = shownWarningKind.get(capture.id) ?? null;
    try {
      trackCandidateSelectionIfNeeded(capture);
      const selectedCondition: DeckConditionCode = priceSelection.get(capture.id)?.conditionCode ?? 'near_mint';
      await spotlightRepository.createInventoryEntry({
        addedAt,
        cardID: activeCandidate.cardId,
        condition: capture.mode === 'slabs' ? null : selectedCondition,
        quantity: 1,
        selectedRank: capture.activeCandidateIndex + 1,
        selectionSource: capture.activeCandidateIndex === 0 ? 'top' : 'alternate',
        slabContext: capture.slabContext,
        sourceScanID: capture.scanID ?? null,
        userOverrodeMismatchWarning: overrodeMismatchWarning,
        variantName: capture.slabContext?.variantName ?? null,
        wasTopPrediction: capture.activeCandidateIndex === 0,
      });
      capturePostHogEvent('scan_inventory_add_succeeded', {
        mode: capture.mode,
      });
      if (overrodeMismatchWarning) {
        // Load-bearing data-quality telemetry: surfaces how often users dismiss
        // a mismatch warning and then add the (potentially wrong) card to
        // inventory. Pair with the backend `user_overrode_mismatch_warning`
        // flag to monitor false-keep frequency by warning kind.
        capturePostHogEvent('scan_inventory_add_after_warning_override', {
          warning_kind: overrodeMismatchWarning,
          confirmed_card_id: activeCandidate.cardId,
          mode: capture.mode,
        });
      }
      const nextEntries = await spotlightRepository.getInventoryEntries();
      setInventoryEntries(nextEntries);
      refreshData();
      didSucceed = true;
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
          recentlyAdded: didSucceed ? true : entry.recentlyAdded,
        };
      }));

      if (didSucceed) {
        const existingTimer = recentlyAddedTimersRef.current.get(captureId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timerId = setTimeout(() => {
          recentlyAddedTimersRef.current.delete(captureId);
          setRecentCaptures((current) => current.map((entry) => (
            entry.id === captureId ? { ...entry, recentlyAdded: false } : entry
          )));
        }, recentlyAddedDurationMs);
        recentlyAddedTimersRef.current.set(captureId, timerId);
      }
    }
  }, [shownWarningKind, priceSelection, recentCaptures, refreshData, spotlightRepository, trackCandidateSelectionIfNeeded]);

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

  const handlePriceSelection = useCallback(
    (captureId: string, selection: ScanPriceSheetSelection) => {
      setPriceSelection((current) => {
        const next = new Map(current);
        next.set(captureId, selection);
        return next;
      });
    },
    [],
  );

  const handleClosePriceSheet = useCallback(() => {
    setActivePriceCaptureId(null);
  }, []);

  const handleOpenEbayFromSheet = useCallback(() => {
    if (!activePriceCaptureId) {
      return;
    }
    const capture = recentCaptures.find((entry) => entry.id === activePriceCaptureId);
    if (!capture) {
      return;
    }
    handleEbayTrayTap(capture.id, capture.slabContext ?? null);
  }, [activePriceCaptureId, handleEbayTrayTap, recentCaptures]);

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

  const handleOpenCatalogSearch = useCallback(() => {
    router.push('/catalog/search');
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
    const baseMarketPrice = candidate?.marketPrice;
    const currencyCode = candidate?.currencyCode ?? 'USD';
    const canCycleCandidate = !!candidate && capture.candidates.length > 1;
    const selection = priceSelection.get(capture.id) ?? null;
    const displayMarketPrice = isFinitePrice(selection?.marketPrice ?? null)
      ? (selection!.marketPrice as number)
      : (isFinitePrice(baseMarketPrice) ? baseMarketPrice : 0);
    const priceSublabel = selection
      ? `${selection.conditionShortLabel} · ${selection.variantLabel}`
      : 'Market avg.';
    const setAndNumberLine = candidate
      ? [candidate.setName, candidate.cardNumber ? `#${candidate.cardNumber.replace(/^#/, '')}` : null]
        .filter(Boolean)
        .join(' · ')
      : '';
    const modeTagLine = capture.mode === 'slabs'
      ? scannerSlabInlineLabel(capture) || 'GRADED'
      : 'RAW';
    return (
      <RecentCaptureSwipeRow
        key={capture.id}
        actionRailKey={capture.id}
        isFavorite={candidate?.isFavorite ?? false}
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
          <View style={styles.captureLeftGroup}>
            <View style={styles.captureThumbColumn}>
              <Pressable
                accessibilityLabel={canCycleCandidate ? 'Change match' : undefined}
                accessibilityRole={canCycleCandidate ? 'button' : undefined}
                disabled={!canCycleCandidate}
                onPress={canCycleCandidate ? () => openChangeCardPicker(capture.id) : undefined}
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
              </Pressable>
              {canCycleCandidate ? (
                <Pressable
                  accessibilityLabel="Change match"
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => {
                    openChangeCardPicker(capture.id);
                  }}
                  style={({ pressed }) => [
                    styles.captureChangeChip,
                    pressed ? styles.captureChangeChipPressed : null,
                  ]}
                  testID={`scanner-tray-change-${index}`}
                >
                  <RefreshDouble color="#FFFFFF" width={10} height={10} />
                  <Text style={styles.captureChangeLabel}>Change</Text>
                </Pressable>
              ) : null}
            </View>

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
                    {setAndNumberLine ? (
                      <Text numberOfLines={1} style={styles.captureSubtitle}>
                        {setAndNumberLine}
                      </Text>
                    ) : null}
                    <Text numberOfLines={1} style={styles.captureSubtitle}>
                      {modeTagLine}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text numberOfLines={1} style={styles.captureTitle}>{captureFailureTitle(capture)}</Text>
                    <Text numberOfLines={2} style={styles.captureSubtitle}>{captureFailureSubtitle(capture)}</Text>
                  </>
                )}
              </View>
            </Pressable>
          </View>

          {candidate ? (
            <View style={styles.capturePriceColumn}>
              <Pressable
                accessibilityLabel={`Show market price for ${candidate.name}`}
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => setActivePriceCaptureId(capture.id)}
                style={({ pressed }) => [
                  styles.capturePriceWrap,
                  pressed ? styles.capturePriceWrapPressed : null,
                ]}
                testID={`scanner-tray-price-${index}`}
              >
                <Text style={styles.capturePriceValue}>
                  {formatCurrency(displayMarketPrice, currencyCode)}
                </Text>
                <Text style={styles.capturePriceLabel}>{priceSublabel}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={
                  capture.recentlyAdded
                    ? `${candidate.name} added to inventory`
                    : `Add ${candidate.name} to inventory`
                }
                accessibilityRole="button"
                disabled={capture.isAddingToInventory || capture.recentlyAdded}
                hitSlop={6}
                onPress={() => {
                  void handleAddToInventory(capture.id);
                }}
                style={({ pressed }) => [
                  styles.captureAddPill,
                  (pressed || capture.isAddingToInventory || capture.recentlyAdded)
                    ? styles.captureAddPillPressed
                    : null,
                ]}
                testID={`scanner-tray-add-${index}`}
              >
                {capture.isAddingToInventory ? (
                  <ActivityIndicator color={colors.brand} size="small" />
                ) : (
                  <Text style={styles.captureAddPillLabel}>
                    {capture.recentlyAdded ? 'ADDED' : 'ADD'}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>
      </RecentCaptureSwipeRow>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
      {isActiveTab ? <ScannerKeepAwake /> : null}
      <RawScannerCaptureSurface
        availableLensesChanged={handleAvailableLensesChanged}
        cameraRef={cameraRef}
        cameraSessionKey={cameraSessionKey}
        canCapture={canCapture}
        hasCameraPermission={hasCameraPermission}
        isTrayExpanded={isTrayExpanded}
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
              left: 16,
              right: 16,
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
            <IconChevronLeft color={colors.gray0} size={20} strokeWidth={1.5} />
          </Pressable>
          <ScanTargetPill
            label={scanTargetPillLabel(cardType)}
            onPress={() => setIsScanTargetSheetOpen(true)}
            testID="scanner-target-pill"
          />
          <Pressable
            accessibilityLabel="Search cards"
            accessibilityRole="button"
            hitSlop={8}
            onPress={handleOpenCatalogSearch}
            style={styles.scannerSearchButton}
            testID="scanner-search-button"
          >
            <IconSearch color={colors.gray0} size={16} strokeWidth={2} />
          </Pressable>
        </View>

        {(() => {
          // Mismatch Toast: informational only. The user keeps the scan result;
          // tapping the × dismisses; auto-dismisses after 10 s. We deliberately
          // don't surface a tap-to-switch action — toggling Pokémon EN/JP or
          // Graded/Ungraded is the user's choice, not the app's. The Toast just
          // tells them what the detector saw so they can decide. We read from
          // recentCaptures[0] so the Toast always reflects the most recent scan.
          const mostRecentCapture = recentCaptures[0] ?? null;
          const mismatchWarning = mostRecentCapture
            ? buildUnifiedMismatchWarning(mostRecentCapture)
            : null;
          return (
            <Toast
              visible={mismatchWarning != null}
              message={mismatchWarning?.message ?? ''}
              onDismiss={() => {
                if (mostRecentCapture) {
                  handleToastDismiss(mostRecentCapture.id);
                }
              }}
              durationMs={10000}
              tone="warning"
              style={[
                styles.mismatchToast,
                // Sit roughly centered between the bottom of the reticle and
                // the top of the (collapsed) tray. The +24 offset reads as
                // comfortable breathing room above the tray edge rather than
                // hugging it.
                { bottom: collapsedTrayReservedHeight + 24 },
              ]}
              testID="scanner-mismatch-toast"
            />
          );
        })()}

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
          <BlurView
            intensity={isTrayExpanded ? 80 : 24}
            pointerEvents="none"
            style={styles.trayBackdropBlur}
            tint="dark"
          />
          <View pointerEvents="none" style={styles.trayBackdropOverlay} />
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
              <View style={styles.scansHeaderLeft}>
                <Text style={styles.scansLabel} testID="scanner-recent-title">
                  {`Scans: ${recentCaptures.length}`}
                </Text>
                {recentCaptures.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Clear all scans"
                    hitSlop={8}
                    onPress={handleClearAllCaptures}
                    style={({ pressed }) => [
                      styles.clearChip,
                      pressed ? styles.clearChipPressed : null,
                    ]}
                    testID="scanner-tray-clear"
                  >
                    <Text style={styles.clearChipLabel}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.totalLabel} testID="scanner-value-pill-text">
                {`Total: ${formatCurrency(trayPriceSummary.total)}`}
              </Text>
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
                    height: isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight,
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
      {(() => {
        if (!activePriceCaptureId) {
          return null;
        }
        const activeCapture = recentCaptures.find((entry) => entry.id === activePriceCaptureId);
        if (!activeCapture) {
          return null;
        }
        const activeCandidate = activeCandidateForCapture(activeCapture);
        if (!activeCandidate) {
          return null;
        }
        const activeSelection = priceSelection.get(activeCapture.id) ?? null;
        const ebayState = ebayTrayState.get(activeCapture.id);
        return (
          <ScanPriceSheet
            visible
            mode={activeCapture.mode === 'slabs' ? 'slabs' : 'raw'}
            candidate={activeCandidate}
            slabContext={activeCapture.slabContext ?? null}
            selectedVariantKey={activeSelection?.variantKey ?? null}
            selectedConditionCode={activeSelection?.conditionCode ?? null}
            fallbackVariantLabel={activeSelection?.variantLabel ?? 'Market price'}
            fallbackMarketPrice={activeCandidate.marketPrice ?? null}
            fallbackCurrencyCode={activeCandidate.currencyCode ?? null}
            onSelect={(selection) => handlePriceSelection(activeCapture.id, selection)}
            onClose={handleClosePriceSheet}
            onOpenEbayLink={activeCapture.mode === 'slabs' ? handleOpenEbayFromSheet : undefined}
            ebayLinkLoading={ebayState?.loading ?? false}
            ebayLinkAvailable={ebayState?.url != null}
          />
        );
      })()}

      {(() => {
        const changeCapture = activeChangeCaptureId
          ? recentCaptures.find((capture) => capture.id === activeChangeCaptureId)
          : null;
        if (!changeCapture) {
          return null;
        }
        return (
          <ChangeCardPicker
            visible
            candidates={changeCapture.candidates}
            activeCandidateIndex={changeCapture.activeCandidateIndex}
            onSelectCandidate={(index) => setActiveCandidate(changeCapture.id, index)}
            onClose={closeChangeCardPicker}
          />
        );
      })()}

      <ScanningForSheet
        visible={isScanTargetSheetOpen}
        condition={condition}
        cardType={cardType}
        onSelectCondition={setCondition}
        onSelectCardType={setCardType}
        onClose={() => setIsScanTargetSheetOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scannerBackButton: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.gray0,
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  scannerSearchButton: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.gray0,
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  topChromeBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  topChromeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-between',
    position: 'absolute',
    zIndex: 5,
  },
  topActionStack: {
    alignItems: 'flex-end',
    gap: 8,
    position: 'absolute',
    zIndex: 5,
  },
  captureCopy: {
    alignItems: 'flex-start',
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
    alignSelf: 'flex-start',
    flex: 1,
  },
  captureMainButtonPressed: {
    opacity: 0.9,
  },
  capturePriceLabel: {
    ...textStyles.caption,
    color: colors.scannerTextPrimary,
    textAlign: 'right',
  },
  capturePriceValue: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
    textAlign: 'right',
  },
  capturePriceWrap: {
    alignItems: 'flex-end',
    gap: 2,
    justifyContent: 'center',
  },
  capturePriceWrapPressed: {
    opacity: 0.8,
  },
  captureRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-between',
    minHeight: captureRowHeight,
    width: '100%',
  },
  mismatchToast: {
    left: 16,
    position: 'absolute',
    right: 16,
    zIndex: 6,
  },
  captureLeftGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  captureSubtitle: {
    ...textStyles.caption,
    color: colors.scannerTextPrimary,
  },
  captureThumb: {
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 6,
    height: 84,
    width: 59,
  },
  captureThumbColumn: {
    alignItems: 'flex-start',
    gap: 2,
  },
  captureChangeChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 6,
    minHeight: 16,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  captureChangeChipPressed: {
    opacity: 0.78,
  },
  captureChangeLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 9,
    lineHeight: 12.6,
  },
  captureTitle: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
  },
  capturePriceColumn: {
    alignItems: 'flex-end',
    gap: 12,
    width: 84,
  },
  captureAddPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  captureAddPillPressed: {
    opacity: 0.78,
  },
  captureAddPillLabel: {
    color: colors.brand,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18.2,
  },
  recentScansRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  scansHeaderLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  scansLabel: {
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 13,
    lineHeight: 18.2,
    color: colors.scannerTextPrimary,
  },
  clearChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 6,
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  clearChipPressed: {
    opacity: 0.7,
  },
  clearChipLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 10,
    lineHeight: 14,
  },
  totalLabel: {
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 13,
    lineHeight: 18.2,
    color: colors.gray100,
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
    paddingHorizontal: 16,
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
    backgroundColor: colors.gray100,
    borderRadius: 2,
    height: 4,
    width: 40,
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
    overflow: 'hidden',
    width: '100%',
  },
  trayShell: {
    backgroundColor: 'transparent',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
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
  trayBackdropBlur: {
    ...StyleSheet.absoluteFillObject,
  },
  trayBackdropOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
});
