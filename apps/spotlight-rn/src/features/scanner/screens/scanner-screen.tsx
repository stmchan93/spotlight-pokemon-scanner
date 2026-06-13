import { BlurView } from 'expo-blur';
import * as FileSystem from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronLeft,
  IconSearch,
} from '@tabler/icons-react-native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Image,
  LayoutAnimation,
  Linking,
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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useCameraPermission } from 'react-native-vision-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  type CatalogSearchResult,
  type DeckConditionCode,
  type InventoryCardEntry,
  type InventoryEntryCreateRequestPayload,
  type ScannerCapturePayload,
  type SlabContext,
} from '@spotlight/api-client';
import {
  Button,
  colors,
  fontFamilies,
  radii,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useTabsPage } from '@/contexts/tabs-page-context';
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
  getRawScannerCollapsedTrayReservedHeight,
  makeRawScannerCaptureLayout,
  type RawScannerCameraHandle,
  RawScannerCaptureSurface,
  rawScannerTrayEmptyPeekHeight,
  rawScannerTrayHeaderHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
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

import { AddAllConfirmModal } from '@/features/scanner/components/add-all-confirm-modal';
import { ScanTargetPill } from '@/features/scanner/components/scan-target-pill';
import { ScanningForSheet } from '@/features/scanner/components/scanning-for-sheet';
import {
  cardLanguageForCardType,
  scanTargetPillLabel,
  useScannerTargetConfig,
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
  triggerScannerProcessedHaptic,
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
// A little breathing room between scan rows in the tray (Figma scan-tray spacing).
const captureRowGap = 24;
// How long the "ADDED" confirmation shows on a row before it's removed from the
// tray. Long enough to register the success, short enough to feel immediate.
const addedConfirmationDurationMs = 1100;

// Shared payload for adding a scanned capture to the collection — used by both the
// per-row ADD and the bulk ADD ALL flow so they can't drift.
function buildInventoryEntryArgs(
  capture: RecentCapture,
  activeCandidate: CatalogSearchResult,
  addedAt: string,
  conditionCode: DeckConditionCode,
): InventoryEntryCreateRequestPayload {
  return {
    addedAt,
    cardID: activeCandidate.cardId,
    condition: capture.mode === 'slabs' ? null : conditionCode,
    quantity: 1,
    selectedRank: capture.activeCandidateIndex + 1,
    selectionSource: capture.activeCandidateIndex === 0 ? 'top' : 'alternate',
    slabContext: capture.slabContext,
    sourceScanID: capture.scanID ?? null,
    variantName: capture.slabContext?.variantName ?? null,
    wasTopPrediction: capture.activeCandidateIndex === 0,
  };
}

// Vertical space reserved for the "CLEAR ALL" footer appended below the scan
// rows in the expanded tray, so the section stays reachable by scroll.
const trayClearSectionHeight = 104;
const traySwipeThreshold = 20;
// Fling velocity that commits an expand/collapse. gesture-handler reports
// velocity in px/s, so this is the px/s equivalent of the old ~0.22 px/ms.
const trayFlingVelocity = 220;
const trayHeaderHitSlop = { bottom: 10, left: 12, right: 12, top: 12 } as const;
const scannerTrayLayoutAnimation = {
  create: {
    property: LayoutAnimation.Properties.opacity,
    type: LayoutAnimation.Types.easeInEaseOut,
  },
  delete: {
    property: LayoutAnimation.Properties.opacity,
    type: LayoutAnimation.Types.easeInEaseOut,
  },
  // The tray height change uses a spring so the panel starts moving the instant
  // the swipe is released. `easeInEaseOut` barely moves for its first ~70ms,
  // which read as a "wait, then snap" lag; a damped spring tracks immediately and
  // glides to rest. `springDamping: 0.88` keeps the settle smooth (no bounce).
  duration: 300,
  update: {
    springDamping: 0.88,
    type: LayoutAnimation.Types.spring,
  },
} as const;
// Keep the expanded rows mounted for the length of the collapse so they slide
// down behind the bar (clipped by the shrinking viewport) instead of fading.
const scannerTrayCollapseDurationMs = scannerTrayLayoutAnimation.duration;


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

// Nominal zoom factors offered in the scanner UI. The card occupies more of the
// reticle at higher zoom, so the normalized 630×880 crop upscales less — which
// helps accuracy on cards shot from farther away.
const SCANNER_ZOOM_FACTORS = [1, 1.5, 2] as const;
type ScannerZoomFactor = (typeof SCANNER_ZOOM_FACTORS)[number];

const SCANNER_ZOOM_STORAGE_KEY = '@spotlight/scanner/zoom-factor';

function parseScannerZoomFactor(raw: string | null): ScannerZoomFactor {
  const value = Number(raw);
  return (SCANNER_ZOOM_FACTORS as readonly number[]).includes(value)
    ? (value as ScannerZoomFactor)
    : 1;
}

// Persisted zoom selection — mirrors the wishlist view-mode hook
// (`useWishlistViewMode`): in-memory default of 1×, hydrated from AsyncStorage.
function useScannerZoomFactor(): [ScannerZoomFactor, (next: ScannerZoomFactor) => void] {
  const [zoomFactor, setZoomFactorState] = useState<ScannerZoomFactor>(1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(SCANNER_ZOOM_STORAGE_KEY);
        if (!cancelled) {
          setZoomFactorState(parseScannerZoomFactor(stored));
        }
      } catch {
        // ignore — keep the 1× default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setZoomFactor = useCallback((next: ScannerZoomFactor) => {
    setZoomFactorState(next);
    void AsyncStorage.setItem(SCANNER_ZOOM_STORAGE_KEY, String(next)).catch(() => {
      // ignore persistence failure — in-memory state still reflects the choice
    });
  }, []);

  return [zoomFactor, setZoomFactor];
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
  const { hasPermission, requestPermission } = useCameraPermission();
  const [isCameraReady, setIsCameraReady] = useState(isTestEnv);
  const [isCapturing, setIsCapturing] = useState(false);
  // Whether the app is in the foreground. vision-camera's session is interrupted
  // by the OS on screen-lock/background; without driving `isActive` off this, the
  // session is never told to stop+restart and the preview returns frozen while the
  // capture gate (re-armed only by `onStarted`) stays disabled — the "app is stuck
  // after it sits idle" bug. Starts true (the app is foregrounded on mount); the
  // listener below keeps it in sync.
  const [isForeground, setIsForeground] = useState(true);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryCardEntry[]>([]);
  const [recentCaptures, setRecentCaptures] = useState<RecentCapture[]>([]);
  // Mirrors `recentCaptures` so the unmount flush reads the latest tray without
  // a stale closure (see the persist effect below).
  const recentCapturesRef = useRef<RecentCapture[]>([]);
  const [openActionRailKeys, setOpenActionRailKeys] = useState<Record<string, true>>({});
  const [isTrayExpanded, setIsTrayExpanded] = useState(false);
  const [isAddAllOpen, setIsAddAllOpen] = useState(false);
  const { cardType, setCardType } = useScannerTargetConfig();
  const [zoomFactor, setZoomFactor] = useScannerZoomFactor();
  const [isScanTargetSheetOpen, setIsScanTargetSheetOpen] = useState(false);
  const [ebayTrayState, setEbayTrayState] = useState<Map<string, { loading: boolean; url: string | null }>>(new Map());
  const [priceSelection, setPriceSelection] = useState<Map<string, ScanPriceSheetSelection>>(new Map());
  const [activePriceCaptureId, setActivePriceCaptureId] = useState<string | null>(null);
  const [activeChangeCaptureId, setActiveChangeCaptureId] = useState<string | null>(null);
  const hasFocusedScannerRef = useRef(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<RawScannerCameraHandle | null>(null);
  const trayScrollOffsetYRef = useRef(0);
  const trayScrollRef = useRef<ScrollView>(null);
  // True only while the tray is animating closed. During that window the
  // expanded rows stay mounted so the shrinking viewport clips them downward
  // (a slide-down) instead of unmounting them into a fade.
  const [isTrayCollapsing, setIsTrayCollapsing] = useState(false);
  const trayCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // happens after the match resolves. The ref mirrors the latest tray so the
  // unmount flush below can persist it without a stale closure.
  useEffect(() => {
    recentCapturesRef.current = recentCaptures;
    schedulePersist(recentCaptures);
  }, [recentCaptures]);

  // Flush the live tray on unmount so navigating away (which tears this screen
  // down) persists the most recent state. We pass the current tray explicitly:
  // an argument-less flush would write [] whenever the debounce had already
  // settled, wiping every scan on each page bounce.
  useEffect(() => () => {
    void flushPersist(recentCapturesRef.current);
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
  const hasCameraPermission = hasPermission;
  const shouldMountCamera = hasCameraPermission && isActiveTab && isForeground;
  const scannerSmokeEnabled = resolveStagingSmokeModeEnabled({ allowDevelopment: true });
  const canCapture = shouldMountCamera
    && isCameraReady
    && !isCapturing;
  const canToggleTray = recentCaptures.length > 0;
  const isTopLevelSwipeEnabled = Object.keys(openActionRailKeys).length === 0;
  // In the collapsed state we render exactly `collapsedVisibleCaptures` (one) row
  // with no peek sliver of the next row. The viewport height is fixed to a single
  // row, so the tray shows one clean card and the rest are revealed by expanding.
  const collapsedCaptures = recentCaptures.slice(0, collapsedVisibleCaptures);
  // While collapsing we still render every row so it can slide down behind the
  // bar; only the settled collapsed state trims to a single row.
  const showExpandedTrayContent = isTrayExpanded || isTrayCollapsing;
  const visibleCaptures = showExpandedTrayContent ? recentCaptures : collapsedCaptures;
  const trayExpandedBodyHeight = alignToFourPointGrid(
    Math.max(
      Math.round(windowHeight * 0.85) - rawScannerTrayHeaderHeight - trayBottomInset,
      272,
    ),
  );
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight) + ((recentCaptures.length - 1) * captureRowGap) + trayClearSectionHeight;
  const trayScrollViewportHeight = recentCaptures.length > 0
    ? Math.min(trayContentHeight, trayExpandedBodyHeight)
    : Math.max(140, trayExpandedBodyHeight);
  const trayScrollEnabled = trayContentHeight > trayScrollViewportHeight;
  const collapsedViewportHeight = captureRowHeight;
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
    if (hasPermission || hasPromptedForPermissionRef.current) {
      return;
    }

    // vision-camera's permission state is a single boolean — there is no
    // `canAskAgain`. Request once on first mount; if the user denies, the
    // camera simply doesn't mount (no re-prompt loop).
    hasPromptedForPermissionRef.current = true;
    void requestPermission();
  }, [hasPermission, requestPermission]);

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
    if (hasFocusedScannerRef.current) {
      setIsCameraReady(false);
      setIsCapturing(false);
    } else {
      hasFocusedScannerRef.current = true;
    }

    return () => {
      setIsCameraReady(false);
      setIsCapturing(false);
    };
  }, []));

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
    } else if (!isActiveTab && prev) {
      // Leaving scanner for portfolio — stop capture state.
      setIsCameraReady(false);
      setIsCapturing(false);
    }
  }, [isActiveTab]);

  // Drive the camera off app foreground/background. On background we drop
  // `isForeground` (so `shouldMountCamera`/`isActive` go false and vision-camera
  // tears the session down cleanly) and reset the transient gates; on return to
  // foreground the session restarts and `onStarted` re-arms `isCameraReady`. We
  // also clear `isCapturing` so a capture interrupted mid-flight by backgrounding
  // can't wedge the gate. Without this the OS interruption leaves the scanner
  // frozen and unresponsive after the app sits idle.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const nextIsForeground = nextAppState === 'active';
      setIsForeground(nextIsForeground);
      setIsCapturing(false);
      if (!nextIsForeground) {
        setIsCameraReady(false);
      }
    });

    return () => {
      subscription?.remove?.();
    };
  }, []);

  const commitTrayExpandedState = useCallback((nextExpanded: boolean) => {
    setIsTrayExpanded((current) => {
      if (current === nextExpanded) {
        return current;
      }

      if (trayCollapseTimerRef.current) {
        clearTimeout(trayCollapseTimerRef.current);
        trayCollapseTimerRef.current = null;
      }

      if (!nextExpanded) {
        trayScrollOffsetYRef.current = 0;
        // Anchor row 0 so the collapse reveals the top card, then hold the rest
        // mounted for the slide so they're clipped (slide down) — not faded.
        trayScrollRef.current?.scrollTo({ y: 0, animated: false });
        setIsTrayCollapsing(true);
        trayCollapseTimerRef.current = setTimeout(() => {
          trayCollapseTimerRef.current = null;
          setIsTrayCollapsing(false);
        }, scannerTrayCollapseDurationMs);
      } else {
        setIsTrayCollapsing(false);
      }

      if (Platform.OS !== 'web') {
        LayoutAnimation.configureNext(scannerTrayLayoutAnimation);
      }

      return nextExpanded;
    });
  }, []);

  useEffect(() => () => {
    if (trayCollapseTimerRef.current) {
      clearTimeout(trayCollapseTimerRef.current);
    }
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
  }, []);

  // After a capture is added to the collection it leaves the tray. Same cleanup
  // as a swipe-delete (free the local scan files + per-capture selection state),
  // but tagged 'added' so telemetry can tell intentional adds from discards.
  const removeCaptureAfterAdd = useCallback((captureId: string) => {
    setRecentCaptures((current) => {
      const removed = current.find((capture) => capture.id === captureId);
      if (removed) {
        void deleteScanFile(removed.normalizedImageUri, 'added');
        if (removed.uri && removed.uri !== removed.normalizedImageUri) {
          void deleteScanFile(removed.uri, 'added');
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
    setEbayTrayState((current) => {
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
    // Don't wait for the debounce window — overwrite storage immediately (and
    // explicitly with []) so a force-quit right after Clear All can't resurrect
    // just-deleted scans.
    void flushPersist([]);
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
          totalCandidateCount: matchResult.candidatePoolSize ?? matchResult.candidates.length,
          isLoadingMoreCandidates: false,
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
      void triggerScannerProcessedHaptic('found');
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
        totalCandidateCount: 0,
        isLoadingMoreCandidates: false,
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
      void triggerScannerProcessedHaptic();
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
    if (!hasPermission) {
      // vision-camera exposes only a boolean — re-request once and bail if the
      // user still denies (no `canAskAgain` to branch on).
      const granted = await requestPermission();
      if (!granted) {
        return;
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
    setRecentCaptures((current) => applyCapEviction([
      {
        activeCandidateIndex: 0,
        candidates: [],
        totalCandidateCount: 0,
        isLoadingMoreCandidates: false,
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
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
      const photo = await cameraRef.current?.takePicture({
        quality: rawVisualCaptureQuality,
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
        void triggerScannerProcessedHaptic();
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

      // Graded scanning moved to the PDP; scanner is raw/visual only (slab lane
      // kept but gated off). Forcing isSlab=false makes the slab normalize/
      // analyze/payload branches below dead-but-present until the PDP-grading
      // flow re-enables a graded path.
      isSlab = false;

      if (process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] normalizeStart `
          + `reportedSource=${sourceImageDimensions.width}x${sourceImageDimensions.height} `
          + `preview=${reticleSnapshotRef.current.previewWidth}x${reticleSnapshotRef.current.previewHeight} `
          + `reticle=${reticleSnapshotRef.current.width}x${reticleSnapshotRef.current.height}@${reticleSnapshotRef.current.x},${reticleSnapshotRef.current.y} `
          + `crop=${sourceImageCrop ? `${sourceImageCrop.width}x${sourceImageCrop.height}@${sourceImageCrop.x},${sourceImageCrop.y}` : 'n/a'}`,
        );
      }

      const normalizedTarget = isSlab
        ? await buildSlabScannerTarget({
          previewLayout,
          reticle: reticleLayout,
          sourceImageDimensions,
          sourceImageUri: photo.uri,
        })
        : rawNormalizedTarget;

      const normalizeMs = Date.now() - normalizeStartedAt;
      normalizeMsForAnalytics = normalizeMs;
      if (!normalizedTarget) {
        throw new Error('normalized_target_unavailable');
      }

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
        cameraZoomFactor: zoomFactor,
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
      void triggerScannerProcessedHaptic();
    }
  }, [
    cardType,
    hasPermission,
    isCameraReady,
    isCapturing,
    requestPermission,
    runMatchForCapture,
    updateRecentCapture,
    zoomFactor,
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
        totalCandidateCount: 0,
        isLoadingMoreCandidates: false,
        hasTrackedSelectionEvent: false,
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
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
      void triggerScannerProcessedHaptic();
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

  const loadMoreCandidates = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    if (!capture || !capture.scanID) {
      return;
    }
    if (capture.isLoadingMoreCandidates) {
      return;
    }
    if (capture.candidates.length >= capture.totalCandidateCount) {
      return;
    }

    const scanID = capture.scanID;
    const offset = capture.candidates.length;
    updateRecentCapture(captureId, (current) => ({
      ...current,
      isLoadingMoreCandidates: true,
    }));

    try {
      const result = await spotlightRepository.fetchScanCandidates(scanID, offset, 10);
      updateRecentCapture(captureId, (current) => {
        const existingIds = new Set(
          current.candidates.map((candidate) => candidate.id ?? candidate.cardId),
        );
        const appended = result.candidates.filter(
          (candidate) => !existingIds.has(candidate.id ?? candidate.cardId),
        );
        return {
          ...current,
          // Preserve the full existing array (alternative-candidate cycling must
          // keep working on rehydrated rows); only append genuinely-new entries.
          candidates: [...current.candidates, ...appended],
          totalCandidateCount: Math.max(current.totalCandidateCount, result.total),
          isLoadingMoreCandidates: false,
        };
      });
    } catch (error) {
      logScannerDiagnostic('[SCANNER] loadMoreCandidates failed', error);
      updateRecentCapture(captureId, (current) => ({
        ...current,
        isLoadingMoreCandidates: false,
      }));
    }
  }, [recentCaptures, spotlightRepository, updateRecentCapture]);

  const openChangeCardPicker = useCallback((captureId: string) => {
    setActiveChangeCaptureId(captureId);
  }, []);

  const closeChangeCardPicker = useCallback(() => {
    setActiveChangeCaptureId(null);
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

  // Stable wrapper for the swipe row so React.memo doesn't re-render every row
  // when handleToggleFavorite re-creates on recentCaptures change.
  const handleToggleFavoriteRef = useRef(handleToggleFavorite);
  useEffect(() => {
    handleToggleFavoriteRef.current = handleToggleFavorite;
  }, [handleToggleFavorite]);
  const handleRowFavorite = useCallback((captureId: string) => {
    void handleToggleFavoriteRef.current(captureId);
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
      return withOptimisticInventoryAdd(current, activeCandidate, addedAt, {
        mode: capture.mode,
        slabContext: capture.slabContext,
      });
    });

    let didSucceed = false;
    try {
      trackCandidateSelectionIfNeeded(capture);
      const selectedCondition: DeckConditionCode = priceSelection.get(capture.id)?.conditionCode ?? 'near_mint';
      await spotlightRepository.createInventoryEntry(
        buildInventoryEntryArgs(capture, activeCandidate, addedAt, selectedCondition),
      );
      capturePostHogEvent('scan_inventory_add_succeeded', {
        mode: capture.mode,
      });
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
        // Show the "ADDED" confirmation briefly, then drop the row from the tray
        // — once a card is in the collection it shouldn't linger in recent scans.
        const timerId = setTimeout(() => {
          recentlyAddedTimersRef.current.delete(captureId);
          removeCaptureAfterAdd(captureId);
        }, addedConfirmationDurationMs);
        recentlyAddedTimersRef.current.set(captureId, timerId);
      }
    }
  }, [priceSelection, recentCaptures, refreshData, removeCaptureAfterAdd, spotlightRepository, trackCandidateSelectionIfNeeded]);

  // Bulk "ADD ALL": optimistically close the modal + clear the tray NOW, then add
  // every resolved scan to the collection in the BACKGROUND. Two reasons it isn't
  // done inline:
  //   - Speed: blocking on N parallel createInventoryEntry calls took 5-10s (the
  //     backend serializes writes) with the modal stuck on "Adding…". Backgrounding
  //     it feels instant.
  //   - Stability: clearing via the empty→auto-collapse effect (no LayoutAnimation)
  //     instead of an explicit animated collapse avoids the iOS crash from firing a
  //     tray LayoutAnimation while the modal unmounts and N rows are removed in the
  //     same frame.
  // Per the user: add the good ones, drop failures, clear everything regardless.
  const handleAddAll = useCallback(() => {
    const addedAt = new Date().toISOString();
    // Snapshot what we need BEFORE clearing the tray (createInventoryEntry only
    // needs the in-memory candidate data, not the scan image files).
    const jobs = recentCaptures
      .filter((capture) => (
        !capture.isLoadingCandidates
        && !capture.recentlyAdded
        && activeCandidateForCapture(capture) != null
      ))
      .map((capture) => ({
        activeCandidate: activeCandidateForCapture(capture)!,
        capture,
        condition: (priceSelection.get(capture.id)?.conditionCode ?? 'near_mint') as DeckConditionCode,
      }));

    setIsAddAllOpen(false);
    performClearAllCaptures();

    if (jobs.length === 0) {
      return;
    }

    void (async () => {
      let succeeded = 0;
      // Sequential — concurrent writes contend on the backend's SQLite store.
      for (const job of jobs) {
        try {
          trackCandidateSelectionIfNeeded(job.capture);
          await spotlightRepository.createInventoryEntry(
            buildInventoryEntryArgs(job.capture, job.activeCandidate, addedAt, job.condition),
          );
          succeeded += 1;
        } catch (error) {
          logScannerDiagnostic(`[SCANNER] addAll entry failed: ${scannerErrorMessage(error)}`, error);
        }
      }
      capturePostHogEvent('scan_add_all', {
        attempted: jobs.length,
        succeeded,
        failed: jobs.length - succeeded,
      });
      try {
        const nextEntries = await spotlightRepository.getInventoryEntries();
        setInventoryEntries(nextEntries);
      } catch {
        // Leave the cached list; refreshData below still nudges dependent screens.
      }
      refreshData();
    })();
  }, [
    performClearAllCaptures,
    priceSelection,
    recentCaptures,
    refreshData,
    spotlightRepository,
    trackCandidateSelectionIfNeeded,
  ]);

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

  // The inner scroll list participates in the gesture arena so the tray pan and
  // the list scroll resolve together (swipe down at the top collapses; once
  // scrolled, the same drag scrolls the list instead of collapsing).
  const trayScrollNativeGesture = useMemo(() => Gesture.Native(), []);
  // Scroll offset captured when a tray drag begins — collapse only fires when
  // the list was already at the top at the start (so a scroll-to-top drag
  // doesn't also collapse the tray).
  const trayGestureStartScrollOffsetRef = useRef(0);

  // Vertical swipe to expand/collapse the tray. Lives in gesture-handler (not a
  // JS PanResponder) so it shares one arena with the row swipe-to-action
  // Swipeables; otherwise the native row recognizers swallow the vertical drag.
  // `activeOffsetY` keeps it off horizontal row swipes; `failOffsetX` yields to
  // them outright. Disabled while a row action rail is open (`isTopLevelSwipe`).
  const trayPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canToggleTray && isTopLevelSwipeEnabled)
        .activeOffsetY([-10, 10])
        .failOffsetX([-16, 16])
        .simultaneousWithExternalGesture(trayScrollNativeGesture)
        .onBegin(() => {
          trayGestureStartScrollOffsetRef.current = trayScrollOffsetYRef.current;
        })
        .onEnd((event) => {
          const { translationY, velocityY } = event;
          const shouldExpand =
            !isTrayExpanded
            && (translationY <= -traySwipeThreshold || velocityY <= -trayFlingVelocity);
          const shouldCollapse =
            isTrayExpanded
            && trayGestureStartScrollOffsetRef.current <= 0
            && (translationY >= traySwipeThreshold || velocityY >= trayFlingVelocity);

          if (shouldExpand) {
            commitTrayExpandedState(true);
          } else if (shouldCollapse) {
            commitTrayExpandedState(false);
          }
        }),
    [canToggleTray, commitTrayExpandedState, isTopLevelSwipeEnabled, isTrayExpanded, trayScrollNativeGesture],
  );

  const promptCopy = !hasPermission
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
        onDelete={deleteRecentCapture}
        onFavorite={handleRowFavorite}
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
                  <Text style={styles.captureChangeLabel}>Switch</Text>
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
                <View style={styles.capturePriceValueRow}>
                  <Image
                    source={require('../../../../assets/images/tcgplayer-icon.png')}
                    style={styles.capturePriceLogo}
                  />
                  <Text style={styles.capturePriceValue}>
                    {formatCurrency(displayMarketPrice, currencyCode)}
                  </Text>
                </View>
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
        cameraRef={cameraRef}
        canCapture={canCapture}
        hasCameraPermission={hasCameraPermission}
        isTrayExpanded={isTrayExpanded}
        layout={captureSurfaceLayout}
        onCameraError={() => {
          // A session error (e.g. an unrecoverable interruption) — drop the gate
          // so the UI reflects the dead session instead of a stuck-enabled button.
          setIsCameraReady(false);
          setIsCapturing(false);
        }}
        onCameraReady={() => {
          if (!isTestEnv) {
            setIsCameraReady(true);
          }
        }}
        onCameraStopped={() => {
          // The session stopped (backgrounded / paged away). Re-arming happens via
          // onCameraReady when it restarts; keep the gate closed until then.
          if (!isTestEnv) {
            setIsCameraReady(false);
          }
        }}
        onCapture={() => {
          void handleCapture();
        }}
        prompt={promptCopy}
        shouldMountCamera={shouldMountCamera}
        showSlabGuide={false}
        testIDPrefix="scanner"
        zoomFactor={zoomFactor}
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

        {isTrayExpanded ? null : (
          <View
            pointerEvents="box-none"
            style={[
              styles.controlsRow,
              { left: 16, right: 16, top: captureSurfaceLayout.controlsTop },
            ]}
          >
            <ScanTargetPill
              label={scanTargetPillLabel(cardType)}
              onPress={() => setIsScanTargetSheetOpen(true)}
              testID="scanner-target-pill"
            />
            <View style={styles.zoomDock} testID="scanner-zoom-control">
              {SCANNER_ZOOM_FACTORS.map((factor) => {
                const selected = factor === zoomFactor;
                return (
                  <Pressable
                    accessibilityLabel={`${factor}× zoom`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    hitSlop={6}
                    key={factor}
                    onPress={() => setZoomFactor(factor)}
                    style={[styles.zoomPill, selected ? styles.zoomPillSelected : null]}
                    testID={`scanner-zoom-${factor}x`}
                  >
                    <Text style={[styles.zoomPillLabel, selected ? styles.zoomPillLabelSelected : null]}>
                      {`${factor}x`}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}


        <GestureDetector gesture={trayPanGesture}>
        <View style={styles.trayShell} testID="scanner-tray">
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
          >
            <View style={styles.trayHandleWrap} testID="scanner-tray-handle">
              <View style={styles.trayHandle} />
            </View>
            <View style={styles.recentScansRow}>
              <View style={styles.trayInfoLeftGroup}>
                <View style={styles.trayInfoPill}>
                  <Text style={styles.trayInfoPillLabel} testID="scanner-recent-title">
                    {`SCAN: ${recentCaptures.length}`}
                  </Text>
                </View>
                {isTrayExpanded && recentCaptures.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add all scans to collection"
                    hitSlop={8}
                    onPress={() => setIsAddAllOpen(true)}
                    testID="scanner-tray-add-all"
                  >
                    <Text style={styles.trayAddAllLabel}>ADD ALL</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.trayInfoPill}>
                <Text style={styles.trayInfoPillLabel} testID="scanner-value-pill-text">
                  {`TOTAL: ${formatCurrency(trayPriceSummary.total)}`}
                </Text>
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
                    height: isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight,
                  },
                ]}
                testID="scanner-tray-viewport"
              >
                <GestureDetector gesture={trayScrollNativeGesture}>
                <ScrollView
                  ref={trayScrollRef}
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
                  {showExpandedTrayContent ? (
                    <View style={styles.trayClearSection}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Clear all scans"
                        hitSlop={8}
                        onPress={handleClearAllCaptures}
                        style={({ pressed }) => [
                          styles.trayClearAllPill,
                          pressed ? styles.trayClearAllPillPressed : null,
                        ]}
                        testID="scanner-tray-clear-all"
                      >
                        <Text style={styles.trayClearAllLabel}>CLEAR ALL</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </ScrollView>
                </GestureDetector>
              </View>
            )}
          </View>
        </View>
        </GestureDetector>
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

      <AddAllConfirmModal
        itemCount={recentCaptures.length}
        onCancel={() => setIsAddAllOpen(false)}
        onConfirm={handleAddAll}
        visible={isAddAllOpen}
      />

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
            capturedImageUri={changeCapture.normalizedImageUri ?? changeCapture.uri}
            totalCount={changeCapture.totalCandidateCount}
            isLoadingMore={changeCapture.isLoadingMoreCandidates}
            onLoadMoreCandidates={() => loadMoreCandidates(changeCapture.id)}
            onSelectCandidate={(index) => setActiveCandidate(changeCapture.id, index)}
            onClose={closeChangeCardPicker}
          />
        );
      })()}

      <ScanningForSheet
        visible={isScanTargetSheetOpen}
        cardType={cardType}
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
  controlsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    position: 'absolute',
    zIndex: 4,
  },
  zoomDock: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 11,
  },
  zoomPill: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  zoomPillSelected: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  zoomPillLabel: {
    // 13px / Medium / white per Figma 1390-1662/1665/1668 (the `control` role's
    // 15px SemiBold read too large on the live camera dock).
    ...textStyles.label,
    color: colors.gray0,
  },
  zoomPillLabelSelected: {
    color: colors.gray0,
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
  capturePriceLogo: {
    height: 16,
    resizeMode: 'contain',
    width: 21,
  },
  capturePriceValue: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
    textAlign: 'right',
  },
  capturePriceValueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
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
  captureLeftGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  captureSubtitle: {
    ...textStyles.caption,
    color: colors.gray300,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 17.55,
  },
  captureThumb: {
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 6,
    height: 80,
    width: 58,
  },
  captureThumbColumn: {
    alignItems: 'flex-start',
    gap: 4,
  },
  captureChangeChip: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.scannerConditionPill,
    borderRadius: 4,
    height: 18,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  captureChangeChipPressed: {
    opacity: 0.78,
  },
  captureChangeLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14.3,
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
    backgroundColor: colors.scannerAddPurple,
    borderRadius: radii.sm,
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  captureAddPillPressed: {
    opacity: 0.78,
  },
  captureAddPillLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodySemiBold,
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
  trayInfoLeftGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  trayInfoPill: {
    backgroundColor: colors.gray900,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  trayInfoPillLabel: {
    ...textStyles.labelStrong,
    color: colors.gray400,
  },
  trayAddAllLabel: {
    ...textStyles.labelStrong,
    color: colors.purple500,
  },
  trayClearSection: {
    alignItems: 'center',
    height: trayClearSectionHeight,
    justifyContent: 'center',
  },
  trayClearAllPill: {
    alignSelf: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.dangerStrong,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  trayClearAllPillPressed: {
    opacity: 0.6,
  },
  trayClearAllLabel: {
    ...textStyles.label,
    color: colors.dangerStrong,
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
    // Flat, full-bleed top edge (Figma 1054:3524 footer modal) — no top
    // corner rounding so the panel meets the screen edges squarely.
    backgroundColor: 'transparent',
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
