import { BlurView } from 'expo-blur';
import * as FileSystem from 'expo-file-system/legacy';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronDown,
  IconChevronLeft,
  IconSearch,
} from '@tabler/icons-react-native';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  UIManager,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
/*
  `ArenaPressable`: gesture-handler's own Pressable, for tappables that live
  INSIDE the tray's GestureDetector + Gesture.Native() ScrollView. A plain RN
  Pressable there resolves its touches through the JS responder system while
  the wrapping gestures resolve theirs through RNGH's arena — two arbiters, and
  on Android the arena can cancel the responder before the release, so the tap
  silently dies. iOS's arbitration happens to let both live, which is why the
  row ADD pill and CLEAR ALL worked there and did nothing on Android. RNGH's
  Pressable registers IN the arena, so the pan/scroll/press negotiation happens
  in one place on both platforms.
*/
import {
  Gesture,
  GestureDetector,
  Pressable as ArenaPressable,
} from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
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
  GlassNavBubble,
  GlassSurface,
  isLiquidGlassAvailable,
  Text,
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
  getRawScannerEmptyTrayVisualHeight,
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
  setRecentCapturesOwner,
  sweepOrphanScans,
} from '@/features/scanner/recent-captures-persistence';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { prefetchImageUrls } from '@/lib/card-images';
import { useAuth } from '@/providers/auth-provider';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeBoolean, resolveRuntimeValue, resolveStagingSmokeModeEnabled } from '@/lib/runtime-config';
import { useAppServices } from '@/providers/app-providers';

import { AddAllMenu, type AddAllMenuAction } from '@/features/scanner/components/add-all-menu';
import { ScanBulkConfirmSheet } from '@/features/scanner/components/scan-bulk-confirm-sheet';
import { ScanTargetPill } from '@/features/scanner/components/scan-target-pill';
import { ScannerLanguageTooltip } from '@/features/scanner/components/scanner-language-tooltip';
import { ScannerSearchPill } from '@/features/scanner/components/scanner-search-pill';
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
  buildOptimisticInventoryEntry,
  buildScanMatchFailureProperties,
  buildScanMatchSuccessProperties,
  buildScanSelectionProperties,
  capturePrimaryLabel,
  captureFailureSubtitle,
  captureFailureTitle,
  formatCurrency,
  formatTrayTotal,
  isFinitePrice,
  isNonPSAUnsupportedSlabCapture,
  logScannerDiagnostic,
  resolveCaptureTrayPrice,
  scannerCapturePriceLabel,
  scannerCaptureThumbUri,
  scannerErrorKind,
  scannerErrorMessage,
  scannerPreparationReviewReason,
  scannerSlabInlineLabel,
  scannerSlabSubtitle,
  slabContextFromAnalysis,
  summarizeTrayPrices,
  supportedTrayCurrencyCode,
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
// tray. Kept short so the real dismiss feedback is the row's reanimated exit
// (slide-left + fade, 290ms) rather than a long static "ADDED" linger — the
// row's removal is what plays that exit animation. Per the design-handoff
// state machine: ADD fires the mutation + SCAN/TOTAL immediately, then the
// card exits; the next card advances in (collapsed) or the tray collapses
// (last card only).
const addedConfirmationDurationMs = 320;

// Shared payload for adding a scanned capture to the collection — used by both the
// per-row ADD and the bulk ADD ALL flow so they can't drift.
function buildInventoryEntryArgs(
  capture: RecentCapture,
  activeCandidate: CatalogSearchResult,
  addedAt: string,
  conditionCode: DeckConditionCode,
  collectionID: string,
): InventoryEntryCreateRequestPayload {
  return {
    addedAt,
    cardID: activeCandidate.cardId,
    // Scans land in the collection the Collection tab is showing. "All" is not a
    // real target, so the backend files those into the default collection.
    collectionID,
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
// Tray expand/collapse height animation. Driven by Reanimated (NOT classic
// LayoutAnimation): every tray row is a Reanimated.View (entering/exiting/layout
// choreography), and running RN's LayoutAnimation over that same subtree is what
// crashed the app on every swipe-to-expand/collapse. Keeping the height on the
// same animation system as the rows removes that collision.
const trayHeightTimingConfig = {
  duration: 310,
  easing: Easing.out(Easing.cubic),
} as const;


// Capture ids already reported as cap-evicted. This function runs INSIDE a
// setRecentCaptures updater, and React may invoke an updater more than once for
// a single commit (StrictMode in dev, re-render during concurrent work). File
// deletion tolerates that; an analytics count does not. Bounded by scans per
// process, so a few hundred ids at worst.
const reportedCapEvictionIds = new Set<string>();

function applyCapEviction(
  nextItems: RecentCapture[],
  insertingMode: 'raw' | 'slabs',
): RecentCapture[] {
  if (nextItems.length <= maxStoredCaptures) {
    return nextItems;
  }
  const survivors = nextItems.slice(0, maxStoredCaptures);
  const dropped = nextItems.slice(maxStoredCaptures);
  dropped.forEach((item) => {
    if (!reportedCapEvictionIds.has(item.id)) {
      reportedCapEvictionIds.add(item.id);
      // The tray filled up and pushed this scan out untouched — the clearest
      // signal we have that someone scanned a pile and added none of it.
      capturePostHogEvent('scan_row_dismissed', {
        count: 1,
        inserting_mode: insertingMode,
        mode: item.mode,
        reason: 'cap_evicted',
      });
    }
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
// One-time EN/JP tooltip seen-flag — written on any dismissal so the coach mark
// only ever shows on the user's very first scanner visit.
const LANGUAGE_TOOLTIP_SEEN_KEY = '@spotlight/scanner/language-tooltip-seen';
// SecureStore twin of the seen-flag. AsyncStorage is wiped on uninstall, so the
// coach mark used to reappear for existing users after a reinstall — while their
// Supabase session (also in SecureStore / the iOS Keychain) survived. SecureStore
// keys only allow [A-Za-z0-9._-], hence the dotted spelling (no '@' / '/' / ':').
const LANGUAGE_TOOLTIP_SEEN_SECURE_KEY = 'spotlight.scanner.language-tooltip-seen';

// expo-secure-store can be unavailable (web) or throw at runtime on some devices
// (keychain entitlement issues — see src/lib/supabase.ts). Load it defensively and
// treat every failure as "no flag": coach-mark bookkeeping must never crash or
// block the scanner, and the AsyncStorage flag still covers the current install.
type SecureStoreModule = typeof import('expo-secure-store');
let languageTooltipSecureStore: SecureStoreModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  languageTooltipSecureStore = require('expo-secure-store') as SecureStoreModule;
} catch {
  languageTooltipSecureStore = null;
}

async function readLanguageTooltipSeenFlag(secureKey: string): Promise<string | null> {
  if (!languageTooltipSecureStore) {
    return null;
  }
  try {
    return await languageTooltipSecureStore.getItemAsync(secureKey);
  } catch {
    return null;
  }
}

function writeLanguageTooltipSeenFlag(secureKey: string) {
  if (!languageTooltipSecureStore) {
    return;
  }
  try {
    void languageTooltipSecureStore.setItemAsync(secureKey, '1').catch(() => {});
  } catch {
    // Best-effort — the AsyncStorage flag still covers this install.
  }
}

function parseScannerZoomFactor(raw: string | null): ScannerZoomFactor {
  const value = Number(raw);
  return (SCANNER_ZOOM_FACTORS as readonly number[]).includes(value)
    ? (value as ScannerZoomFactor)
    : 1;
}

// Persisted zoom selection — mirrors the wishlist view-mode hook
// (`useWishlistViewMode`): in-memory default of 1×, hydrated from AsyncStorage.
function useScannerZoomFactor(): [ScannerZoomFactor, (next: ScannerZoomFactor) => void, boolean] {
  const [zoomFactor, setZoomFactorState] = useState<ScannerZoomFactor>(1);
  // Until the persisted zoom is read back, captures must wait — otherwise the
  // first scan can fire at the 1× default before the saved zoom applies, changing
  // the field-of-view and pulling in neighboring cards.
  const [hydrated, setHydrated] = useState(false);

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
      } finally {
        if (!cancelled) {
          setHydrated(true);
        }
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

  return [zoomFactor, setZoomFactor, hydrated];
}

type CaptureRowMenuAnchor = { height: number; width: number; x: number; y: number };

type CaptureTrayRowProps = {
  capture: RecentCapture;
  enableEnterAnimation: boolean;
  index: number;
  onActionRailVisibilityChange: (key: string, visible: boolean) => void;
  onAddToCollection: (captureId: string) => void;
  onDelete: (captureId: string) => void;
  onOpenCard: (captureId: string) => void | Promise<void>;
  onOpenChangeCardPicker: (captureId: string) => void;
  onOpenRowMenu: (captureId: string, anchor: CaptureRowMenuAnchor) => void;
  onShowPrice: (captureId: string) => void;
  selection: ScanPriceSheetSelection | null;
};

// One scan-tray row, extracted from the screen render and memoized: each row
// carries a CachedImage thumb, a gesture-handler Swipeable and a Reanimated
// wrapper, so re-rendering all of them on every unrelated scanner-screen state
// change (camera readiness, capture flashes, zoom, eBay lookups, sheet
// open/close, …) made the tray's JS commits expensive with a full tray. All
// callback props are stable useCallbacks from the screen, so a row now only
// re-renders when ITS capture / price selection / enter-animation gate changes.
const CaptureTrayRow = memo(function CaptureTrayRow({
  capture,
  enableEnterAnimation,
  index,
  onActionRailVisibilityChange,
  onAddToCollection,
  onDelete,
  onOpenCard,
  onOpenChangeCardPicker,
  onOpenRowMenu,
  onShowPrice,
  selection,
}: CaptureTrayRowProps) {
  const theme = useSpotlightTheme();
  // Anchor for the row ADD menu — measured by ref because the arena Pressable's
  // press event carries no `currentTarget` to measure.
  const addPillRef = useRef<View>(null);
  const candidate = activeCandidateForCapture(capture);
  const canCycleCandidate = !!candidate && capture.candidates.length > 1;
  // Shared with the tray header TOTAL (`trayPriceSummary`) so the rows and the
  // number a dealer prices a stack off can never drift apart.
  const { amount: displayMarketPrice, currencyCode } = resolveCaptureTrayPrice(capture, selection);
  const setAndNumberLine = candidate
    ? [candidate.setName, candidate.cardNumber ? `#${candidate.cardNumber.replace(/^#/, '')}` : null]
      .filter(Boolean)
      .join(' · ')
    : '';
  const modeTagLine = capture.mode === 'slabs'
    ? scannerSlabInlineLabel(capture) || 'GRADED'
    : 'RAW';
  // When the shown price is a graded slab comp (card has no raw price), tag it
  // so "$24,824" reads as "$24,824  PSA 10", not the ungraded value.
  const gradedReferenceLabel = candidate?.priceIsGradedReference
    ? candidate.gradedReferenceLabel
    : null;
  return (
    <RecentCaptureSwipeRow
      actionRailKey={capture.id}
      // Collapsed tray shows a single row; after ADD the next card advances
      // in with the slide-from-right enter. Expanded list opens without
      // fanning every row, so enter is gated to the collapsed viewport.
      enableEnterAnimation={enableEnterAnimation}
      onActionRailVisibilityChange={onActionRailVisibilityChange}
      onAddToCollection={onAddToCollection}
      onDelete={onDelete}
      testID={`scanner-tray-swipe-${index}`}
    >
      <View style={styles.captureRow} testID={`scanner-tray-row-${index}`}>
        <View style={styles.captureLeftGroup}>
          <View style={styles.captureThumbColumn}>
            <Pressable
              accessibilityLabel={canCycleCandidate ? 'Change match' : undefined}
              accessibilityRole={canCycleCandidate ? 'button' : undefined}
              disabled={!canCycleCandidate}
              onPress={canCycleCandidate ? () => onOpenChangeCardPicker(capture.id) : undefined}
            >
              {scannerCaptureThumbUri(capture, candidate) ? (
                <CachedImage
                  cachePolicy={imageCachePolicy.thumbnail}
                  // Keep the scan's own normalized crop on screen while the
                  // matched card's art downloads (slow networks showed a blank
                  // thumb during the swap), with a soft crossfade when it lands.
                  placeholder={capture.normalizedImageUri ? { uri: capture.normalizedImageUri } : undefined}
                  placeholderContentFit="cover"
                  // Pin this image view to its capture id so expo-image never
                  // reuses a decoded bitmap across rows during rapid burst
                  // updates (a stale-decode display path that can show one row's
                  // photo on another). Belt-and-suspenders alongside the
                  // synchronous capture lock.
                  recyclingKey={capture.id}
                  style={styles.captureThumb}
                  testID={`scanner-tray-image-${index}`}
                  transition={120}
                  uri={scannerCaptureThumbUri(capture, candidate)}
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
                  onOpenChangeCardPicker(capture.id);
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
              void onOpenCard(capture.id);
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
              onPress={() => onShowPrice(capture.id)}
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
                  {isFinitePrice(displayMarketPrice)
                    ? formatCurrency(displayMarketPrice, currencyCode)
                    : '—'}
                </Text>
                {gradedReferenceLabel ? (
                  <Text
                    numberOfLines={1}
                    style={styles.captureGradedRefChip}
                    testID={`scanner-tray-graded-ref-${index}`}
                  >
                    {gradedReferenceLabel}
                  </Text>
                ) : null}
              </View>
            </Pressable>
            <ArenaPressable
              accessibilityLabel={`Add ${candidate.name}`}
              accessibilityRole="button"
              hitSlop={6}
              onPress={(event) => {
                /*
                  ─────────────────────────────────────────────────────────────
                  THE MENU MUST NOT DEPEND ON measureInWindow CALLING BACK
                  ─────────────────────────────────────────────────────────────
                  Opening only inside the measure callback made this button read
                  as DEAD when the callback never fires — a flake this file
                  already guards against on the ADD ALL trigger. Measure via the
                  REF (gesture-handler's Pressable event carries no
                  `currentTarget`), and if it has not answered within a beat,
                  open anyway anchored at the TAP POINT, which lies inside the
                  pill — the dropdown lands within a few px of the real box.
                */
                const { pageX = 0, pageY = 0 } = event.nativeEvent ?? {};
                let opened = false;
                const open = (anchor: { x: number; y: number; width: number; height: number }) => {
                  if (!opened) {
                    opened = true;
                    onOpenRowMenu(capture.id, anchor);
                  }
                };
                const node = addPillRef.current as unknown as {
                  measureInWindow?: (
                    callback: (x: number, y: number, width: number, height: number) => void,
                  ) => void;
                } | null;
                if (node && typeof node.measureInWindow === 'function') {
                  node.measureInWindow((x, y, width, height) => {
                    open({ height, width, x, y });
                  });
                }
                setTimeout(() => open({ height: 0, width: 0, x: pageX, y: pageY }), 50);
              }}
              ref={addPillRef}
              style={({ pressed }) => [
                styles.captureAddPill,
                pressed ? styles.captureAddPillPressed : null,
              ]}
              testID={`scanner-tray-add-${index}`}
            >
              <Text style={styles.captureAddPillLabel}>ADD</Text>
              {/* Real chevron glyph (Figma 1874:13192) — the old "▾" text
                  triangle read as a down ARROW. Sized 16 per the newer footer
                  spec (3594:26000). */}
              <IconChevronDown color={colors.gray0} size={16} strokeWidth={2} />
            </ArenaPressable>
          </View>
        ) : null}
      </View>
    </RecentCaptureSwipeRow>
  );
});

export function ScannerScreen({
  onExitToPortfolio,
  onTopLevelSwipeEnabledChange,
}: ScannerScreenProps = {}) {
  const isTestEnv = process.env.NODE_ENV === 'test';
  const { activePage } = useTabsPage();
  const isActiveTab = activePage === 'scanner';
  const router = useRouter();
  // Guest gating: capture stays open, but tray/collection/wishlist/eBay/etc.
  // actions route guests to the login modal instead of running.
  const { ensureGuestSession, gate, isGuest, openLogin } = useGuestGate();
  const {
    dataVersion,
    refreshData,
    spotlightRepository,
    prependOptimisticInventoryEntry,
    activeCollectionID,
  } = useAppServices();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [isCameraReady, setIsCameraReady] = useState(isTestEnv);
  const [isCapturing, setIsCapturing] = useState(false);
  // SYNCHRONOUS capture lock. `isCapturing` is React state, so two burst taps
  // fired within the same tick BOTH read the stale `false` before the setState
  // re-renders → both enter `handleCapture` and call `capturePhoto` concurrently
  // on the one photo output, which can hand back the SAME frame to both (two
  // rows, distinct files, identical pixels — the "every other" burst duplicate).
  // This ref is set true synchronously at capture entry so the second same-tick
  // tap is rejected immediately, and mirrors `isCapturing` back to false via the
  // effect below (covers every setIsCapturing(false) site without hand-syncing).
  const capturingRef = useRef(false);
  useEffect(() => {
    if (!isCapturing) {
      capturingRef.current = false;
    }
  }, [isCapturing]);
  // Quick white "shutter" flash over the preview the instant a photo is taken
  // (paired with the Heavy capture haptic) so the capture is clearly seen + felt.
  // REANIMATED (UI thread), not RN Animated: under burst-scan load the JS
  // thread saturates for seconds (normalize + match pipelines), and RN
  // Animated's timing start stalled behind it — the flash froze at full white
  // for seconds, then snapped off (the "long flash"/"second flash" on
  // Android). withTiming runs on the UI thread regardless of JS load. Single
  // ~half-second fade, IDENTICAL on both platforms (Android photo output runs
  // 'speed'/zero-shutter-lag, so there's no preview stall to choreograph
  // around).
  const captureFlashOpacity = useSharedValue(0);
  const captureFlashStyle = useAnimatedStyle(() => ({
    opacity: captureFlashOpacity.value,
  }));
  const triggerCaptureFlash = useCallback(() => {
    captureFlashOpacity.value = 0.9;
    captureFlashOpacity.value = withTiming(0, { duration: 450 });
  }, [captureFlashOpacity]);
  // Reticle "lock-in" pulse (Figma 2227:22138 → 2227:22140), fired with the
  // shutter flash: the white frame contracts ~4% and crossfades purple — as if
  // the corners grab the card — then eases back to resting white. The surface
  // maps 0→1 onto scale + the white→purple crossfade. REANIMATED (UI thread)
  // for the same reason as the capture flash above: under burst-scan JS load
  // the RN Animated sequence stalled and replayed LATE — the purple pulse
  // fired a second time right as the match landed.
  const reticleLockProgress = useSharedValue(0);
  const triggerReticleLock = useCallback(() => {
    reticleLockProgress.value = 0;
    reticleLockProgress.value = withSequence(
      withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) }),
      // Hold the locked frame a beat so the grab reads, then release.
      withDelay(200, withTiming(0, { duration: 260, easing: Easing.inOut(Easing.cubic) })),
    );
  }, [reticleLockProgress]);
  // One-time EN/JP coach mark (Figma 2302:29019): shown the first time an
  // ACCOUNT lands on the scanner, pointing at the language pill. Any dismissal —
  // tapping the bubble, tapping the pill (which also opens the picker), or the
  // 10s auto-timer — writes the seen-flag so it never appears again for that
  // account. Keyed per account (not per device) so a fresh sign-up on the same
  // phone still gets the coach mark; the provider tree remounts this screen on
  // account changes, so the key is stable within a mount.
  const { currentSession: tooltipSession } = useAuth();
  const tooltipAccountId = tooltipSession?.user.id ?? 'anon';
  const languageTooltipSeenKey = `${LANGUAGE_TOOLTIP_SEEN_KEY}:${tooltipAccountId}`;
  // Supabase user ids are UUIDs, so the account suffix stays within SecureStore's
  // [A-Za-z0-9._-] key alphabet.
  const languageTooltipSecureSeenKey =
    `${LANGUAGE_TOOLTIP_SEEN_SECURE_KEY}.${tooltipAccountId}`;
  const [showLanguageTooltip, setShowLanguageTooltip] = useState(false);
  const dismissLanguageTooltip = useCallback(() => {
    setShowLanguageTooltip((current) => {
      if (current) {
        // Written to both stores: AsyncStorage keeps the legacy path consistent;
        // SecureStore survives uninstall/reinstall like the auth session does.
        void AsyncStorage.setItem(languageTooltipSeenKey, '1').catch(() => {});
        writeLanguageTooltipSeenFlag(languageTooltipSecureSeenKey);
      }
      return false;
    });
  }, [languageTooltipSecureSeenKey, languageTooltipSeenKey]);
  useEffect(() => {
    // Arm only while the scanner is the ACTIVE pager page. Both pager slots
    // mount at boot (Collection is the landing tab), so an unconditional arm
    // used to show the tooltip invisibly on the hidden page and let the 10s
    // timer burn it — the seen-flag was written before the user ever swiped over.
    if (!isActiveTab) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      // SecureStore first — it survives reinstall. Fall back to the legacy
      // AsyncStorage flag and migrate it forward so users who dismissed the
      // coach mark before this change never see it again.
      const secureSeen = await readLanguageTooltipSeenFlag(languageTooltipSecureSeenKey);
      if (cancelled || secureSeen != null) {
        return;
      }
      let legacySeen: string | null;
      try {
        legacySeen = await AsyncStorage.getItem(languageTooltipSeenKey);
      } catch {
        // Match the pre-SecureStore behavior: an unreadable flag means "don't show".
        return;
      }
      if (cancelled) {
        return;
      }
      if (legacySeen === '1') {
        // Seen on this install before the SecureStore flag existed — copy it
        // over (best-effort) and stay hidden.
        writeLanguageTooltipSeenFlag(languageTooltipSecureSeenKey);
        return;
      }
      if (legacySeen == null) {
        setShowLanguageTooltip(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActiveTab, languageTooltipSecureSeenKey, languageTooltipSeenKey]);
  useEffect(() => {
    if (!showLanguageTooltip || !isActiveTab) {
      return undefined;
    }
    // Scanner convention for transient chrome: auto-dismiss after 10s — counted
    // only while the tooltip is actually on screen.
    const timer = setTimeout(dismissLanguageTooltip, 10000);
    return () => clearTimeout(timer);
  }, [dismissLanguageTooltip, isActiveTab, showLanguageTooltip]);
  // Whether the app is in the foreground. vision-camera's session is interrupted
  // by the OS on screen-lock/background; without driving `isActive` off this, the
  // session is never told to stop+restart and the preview returns frozen while the
  // capture gate (re-armed only by `onStarted`) stays disabled — the "app is stuck
  // after it sits idle" bug. Starts true (the app is foregrounded on mount); the
  // listener below keeps it in sync.
  const [isForeground, setIsForeground] = useState(true);
  // Whether the scanner ROUTE is focused (i.e. no other route — card detail,
  // scan-review — is pushed over it). vision-camera re-arms the capture gate only
  // on a session *start* (`onStarted`), so the camera must actually stop on blur
  // and restart on focus to fire it. Relying on react-native-screens' freeze for
  // that restart broke when an external link (eBay/Scrydex) backgrounded the app
  // mid-detail: the foreground-return flipped `isActive` true while still blurred,
  // spending the transition, so returning to the scanner never restarted the
  // session and the gate stayed stuck closed. Defaults true (focused on mount).
  const [isScreenFocused, setIsScreenFocused] = useState(true);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryCardEntry[]>([]);
  const [recentCaptures, setRecentCaptures] = useState<RecentCapture[]>([]);
  // Mirrors `recentCaptures` so the unmount flush reads the latest tray without
  // a stale closure (see the persist effect below).
  const recentCapturesRef = useRef<RecentCapture[]>([]);
  const [openActionRailKeys, setOpenActionRailKeys] = useState<Record<string, true>>({});
  const [isTrayExpanded, setIsTrayExpanded] = useState(false);
  const [addAllMenuOpen, setAddAllMenuOpen] = useState(false);
  const [addAllAnchor, setAddAllAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [addAllConfirm, setAddAllConfirm] = useState<AddAllMenuAction | null>(null);
  const [rowMenuCaptureId, setRowMenuCaptureId] = useState<string | null>(null);
  const [rowMenuAnchor, setRowMenuAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const addAllTriggerRef = useRef<View | null>(null);
  const lastBulkActionRef = useRef<AddAllMenuAction>('collection');
  const { cardType, setCardType } = useScannerTargetConfig();
  const [zoomFactor, setZoomFactor, zoomHydrated] = useScannerZoomFactor();
  const [isScanTargetSheetOpen, setIsScanTargetSheetOpen] = useState(false);
  const [ebayTrayState, setEbayTrayState] = useState<Map<string, { loading: boolean; url: string | null }>>(new Map());
  const [priceSelection, setPriceSelection] = useState<Map<string, ScanPriceSheetSelection>>(new Map());
  const [activePriceCaptureId, setActivePriceCaptureId] = useState<string | null>(null);
  const [activeChangeCaptureId, setActiveChangeCaptureId] = useState<string | null>(null);
  const hasFocusedScannerRef = useRef(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<RawScannerCameraHandle | null>(null);
  const trayScrollRef = useRef<Reanimated.ScrollView>(null);
  const reticleSnapshotRef = useRef({ height: 0, previewHeight: 0, previewWidth: 0, width: 0, x: 0, y: 0 });
  const recentlyAddedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = recentlyAddedTimersRef.current;
    return () => {
      timers.forEach((timerId) => clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  // The account the scan tray belongs to (Supabase user id, or null signed out).
  // The provider tree above remounts this screen when the account changes, so the
  // rehydrate effect below re-runs and clears the tray if it was another account's.
  const { currentSession } = useAuth();
  const trayOwnerKey = currentSession?.user.id ?? null;

  // Rehydrate the tray from disk on first mount. Runs once per scanner-screen
  // lifecycle; the persistence module's own AsyncStorage read is cheap and
  // does not block paint (the scanner renders against the empty tray until
  // this resolves, then state updates and the rows pop in). Also kicks off a
  // background orphan-file sweep so cap-evicted/force-quit-lost files don't
  // accumulate forever.
  // Persistence is gated on this ref: a SECOND mounted scanner instance (the
  // Scan tab pushes a new tabs stack over Wishlist/Insights) starts with an
  // empty tray, and letting it persist before its rehydrate resolved wiped the
  // stored scans — mount raced schedulePersist([]) against the disk read, and
  // backing out flushed the never-hydrated [] over a full tray.
  const hasHydratedTrayRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Stamp the active account synchronously before any load/write so loadPersistedTray
    // can detect an account switch (and clear) and writes are tagged with the right owner.
    setRecentCapturesOwner(trayOwnerKey);
    void (async () => {
      try {
        await ensureScansDir();
        const loaded = await loadPersistedTray();
        if (cancelled) {
          return;
        }
        hasHydratedTrayRef.current = true;
        if (loaded.length === 0) {
          return;
        }
        setRecentCaptures((current) => (current.length > 0 ? current : loaded));
        void sweepOrphanScans(new Set(loaded.map((item) => item.id)));
      } catch {
        // Persistence errors are reported inside the module via PostHog.
        // A failed rehydrate just leaves the tray empty for this session —
        // and keeps persistence gated OFF so it can't wipe stored scans.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trayOwnerKey]);

  // Persist on every tray change, debounced inside the module so rapid scans
  // coalesce into one AsyncStorage write. Loading items are skipped by the
  // module itself, so the very first persist of any given scan naturally
  // happens after the match resolves. The ref mirrors the latest tray so the
  // unmount flush below can persist it without a stale closure. Gated on
  // hydration so a fresh instance's empty initial state never clobbers disk.
  useEffect(() => {
    recentCapturesRef.current = recentCaptures;
    if (hasHydratedTrayRef.current) {
      schedulePersist(recentCaptures);
    }
  }, [recentCaptures]);

  // Flush the live tray on unmount so navigating away (which tears this screen
  // down) persists the most recent state. We pass the current tray explicitly:
  // an argument-less flush would write [] whenever the debounce had already
  // settled, wiping every scan on each page bounce. A never-hydrated instance
  // skips the flush entirely — its [] is initial state, not user intent.
  useEffect(() => () => {
    if (hasHydratedTrayRef.current) {
      void flushPersist(recentCapturesRef.current);
    }
  }, []);

  /*
    THE WINDOW's bottom inset, not this screen's — and that difference is the
    whole "blink" when you tap Scan.

    This screen sits inside the native tab controller, and UIKit inflates a tab
    child's safe area by the tab bar's height. The bar is hidden here, but it is
    hidden by a JS prop (`hidden` in `(tabs)/_layout.tsx`, derived from
    `usePathname()`), which cannot possibly run until AFTER UIKit has already
    swapped this screen in. So the sequence was:

      1. UIKit shows the scanner, bar still up  -> insets.bottom ~= 83
         (home indicator + 49pt bar)
      2. JS catches up, bar is cut away         -> `safeAreaInsetsDidChange`
      3. that notification reaches JS           -> insets.bottom ~= 34

    …and the tray, sized off this number, visibly dropped ~49pt on arrival.

    `initialWindowMetrics` is read from native constants at startup and describes
    the WINDOW: the home indicator alone, never a tab bar, and it never changes
    while the scanner is up (this screen is portrait-locked). The tray therefore
    lays out once, in its final place. Every render site of this screen is a
    full-bleed scanner with no bottom bar of its own, so the window inset is the
    correct number in all of them.

    Falls back to the hook when the constant is unavailable (web, and the test
    renderer, where the inset is mocked anyway).
  */
  const trayBottomInset = (initialWindowMetrics?.insets.bottom ?? insets.bottom) + 14;
  const collapsedTrayReservedHeight = getRawScannerCollapsedTrayReservedHeight({
    bottomInset: trayBottomInset,
  });
  const emptyTrayVisualHeight = getRawScannerEmptyTrayVisualHeight({
    bottomInset: trayBottomInset,
  });
  const captureSurfaceLayout = makeRawScannerCaptureLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    safeAreaTop: insets.top,
    trayReservedHeight: collapsedTrayReservedHeight,
  });
  const runtimeAppEnv = resolveRuntimeValue([], ['spotlightAppEnv']);
  // Card-shaped crop (not the squatter visible frame) so the normalized target
  // keeps the true card aspect with no stretch.
  reticleSnapshotRef.current = {
    height: captureSurfaceLayout.captureCropRect.height,
    previewHeight: captureSurfaceLayout.previewHeight,
    previewWidth: captureSurfaceLayout.previewWidth,
    width: captureSurfaceLayout.captureCropRect.width,
    x: captureSurfaceLayout.captureCropRect.x,
    y: captureSurfaceLayout.captureCropRect.y,
  };
  const hasCameraPermission = hasPermission;
  const shouldMountCamera = hasCameraPermission && isActiveTab && isForeground && isScreenFocused;
  const scannerSmokeEnabled = resolveStagingSmokeModeEnabled({ allowDevelopment: true });
  const canCapture = shouldMountCamera
    && isCameraReady
    && !isCapturing
    // Hold the shutter until the persisted zoom has loaded so the first capture
    // uses the saved field-of-view, not the transient 1× default. (Test env seeds
    // ready synchronously, matching isCameraReady.)
    && (zoomHydrated || isTestEnv);
  const canToggleTray = recentCaptures.length > 0;
  const isTopLevelSwipeEnabled = Object.keys(openActionRailKeys).length === 0;
  // Every capture row stays mounted regardless of expand/collapse — the
  // collapsed tray just clips them to a single-row viewport height. Keeping the
  // row set stable means toggling never mounts/unmounts rows, so the rows'
  // Reanimated enter/exit (reserved for genuine add/delete) never fire on a
  // toggle. That mass mount/unmount on every swipe was crashing the tray.
  const visibleCaptures = recentCaptures;
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

  // --- Tray expand/collapse animation state (all UI-thread) ---
  // While a tray pan is in flight, `trayDragHeight` overrides the viewport
  // height so the tray tracks the finger frame-by-frame; the pan's onEnd then
  // starts the settle `withTiming` directly on the UI thread. Null means "no
  // gesture override": the animated style below owns the height and springs it
  // toward the JS-state target (header taps, row-count changes).
  const trayDragHeight = useSharedValue<number | null>(null);
  const trayDragStartHeight = useSharedValue(collapsedViewportHeight);
  // Live scroll offset of the inner list, mirrored into a shared value ON THE
  // UI THREAD (useAnimatedScrollHandler below) so the pan worklets can gate
  // "collapse only from top-of-content" without reading a stale JS ref.
  const trayScrollOffset = useSharedValue(0);
  const trayDragStartScrollOffset = useSharedValue(0);

  // Tray viewport height, animated on the UI thread via Reanimated so the
  // expand/collapse slide shares one animation system with the rows (replacing
  // the classic LayoutAnimation that crashed when run over them). The gesture
  // override branch comes first; otherwise `withTiming` animates from the live
  // height to the `isTrayExpanded`-derived target on each toggle.
  const trayViewportAnimatedStyle = useAnimatedStyle(
    () => {
      if (trayDragHeight.value !== null) {
        return { height: trayDragHeight.value };
      }
      return {
        height: withTiming(
          isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight,
          trayHeightTimingConfig,
        ),
      };
    },
    [collapsedViewportHeight, isTrayExpanded, trayScrollViewportHeight],
  );

  // Release the gesture's height override once the state it committed has
  // re-rendered: the `withTiming` branch above then owns the height again —
  // it continues from the current animated value (no jump) — and later
  // non-gesture target changes (row add/remove while expanded) animate
  // normally instead of being pinned to a stale drag height.
  useEffect(() => {
    trayDragHeight.value = null;
  }, [isTrayExpanded, trayDragHeight]);

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
    // Focused: let the camera session run (and restart, firing `onStarted` →
    // re-arming the capture gate) regardless of how the app was backgrounded.
    setIsScreenFocused(true);
    if (hasFocusedScannerRef.current) {
      setIsCameraReady(false);
      setIsCapturing(false);
    } else {
      hasFocusedScannerRef.current = true;
    }

    return () => {
      // Blurred (a route covers the scanner): stop the session so returning
      // produces a clean isActive false→true transition.
      setIsScreenFocused(false);
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

      if (!nextExpanded) {
        // Anchor row 0 so the collapse reveals the top card.
        trayScrollOffset.value = 0;
        trayScrollRef.current?.scrollTo({ y: 0, animated: false });
      }

      // The tray height itself springs via the Reanimated `trayViewportHeight`
      // shared value (see the effect below) — NOT a classic LayoutAnimation,
      // which would crash when run over the Reanimated tray rows.
      return nextExpanded;
    });
  }, [trayScrollOffset]);

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

  // The header TOTAL is the sum of exactly what the rows show: each capture is
  // priced through the SAME `resolveCaptureTrayPrice` the row cell uses, honoring
  // the price-sheet selection (e.g. a Lightly Played comp) instead of the raw
  // candidate market price. One O(n) pass over the tray with a Map lookup per
  // capture — no per-row inventory/pricing fetches — memoized on the only two
  // inputs that can change it, so a 150-item tray recomputes only when the tray
  // itself or a price selection mutates.
  const trayPriceSummary = useMemo(
    () => summarizeTrayPrices(recentCaptures.map(
      (capture) => resolveCaptureTrayPrice(capture, priceSelection.get(capture.id) ?? null),
    )),
    [priceSelection, recentCaptures],
  );

  // A candidate priced in something other than USD is dropped from the TOTAL
  // rather than summed into it (see `summarizeTrayPrices`). That drop is
  // invisible on screen by design — no UI for a case the product doesn't
  // support yet — so report it instead of letting it disappear. Deduped per
  // currency for the session: this recomputes on every tray mutation, and we
  // want to learn THAT it happens, not one event per re-render.
  const reportedUnsupportedCurrenciesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    trayPriceSummary.unsupportedCurrencyCodes.forEach((currencyCode) => {
      if (reportedUnsupportedCurrenciesRef.current.has(currencyCode)) {
        return;
      }
      reportedUnsupportedCurrenciesRef.current.add(currencyCode);
      capturePostHogEvent('scan_tray_unsupported_currency', {
        currency_code: currencyCode,
        supported_currency_code: supportedTrayCurrencyCode,
      });
    });
  }, [trayPriceSummary]);

  const deleteRecentCapture = useCallback((captureId: string) => {
    // Reported from here rather than inside the updater below: this runs once
    // per swipe, whereas an updater can be replayed. Read through the ref so the
    // callback keeps its empty dep list and the memoized swipe rows stay stable.
    capturePostHogEvent('scan_row_dismissed', {
      count: 1,
      mode: recentCapturesRef.current.find((capture) => capture.id === captureId)?.mode ?? null,
      reason: 'swipe',
    });

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
    // One event carrying how many rows went, not one event per row — a tray
    // wiped at the cap would otherwise cost as much as the scans themselves.
    capturePostHogEvent('scan_row_dismissed', {
      count: recentCapturesRef.current.length,
      reason: 'clear_all',
    });

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
      // Base64 no longer exists on the scan hot path (multipart streams the
      // file), so the payload-size estimate is only available when a target
      // opted into inline base64 (e.g. the smoke fixture).
      const estimatedPayloadKB = matchTarget.normalizedImageBase64
        ? Math.round((matchTarget.normalizedImageBase64.length * 0.75) / 1024)
        : null;
      if (mode === 'raw' && process.env.NODE_ENV !== 'test') {
        console.info(
          `[SCANNER VISUAL TEST] dispatch `
          + `captureSource=${captureSource} `
          + `nativeSource=${matchTarget.nativeSourceImageDimensions.width}x${matchTarget.nativeSourceImageDimensions.height} `
          + `rotate=${matchTarget.normalizationRotationDegrees} `
          + `normalized=${matchTarget.normalizedImageDimensions.width}x${matchTarget.normalizedImageDimensions.height} `
          + `payloadKB=${estimatedPayloadKB ?? 'n/a'} `
          + `quality=${captureSource === 'camera' ? rawVisualCaptureQuality : 'fixture'}`,
        );
      }
      const matchResult = await spotlightRepository.matchScannerCapture(resolvedMatchPayload, {
        onArtifactUploadComplete: (artifactUpload) => {
          if (!artifactUpload) {
            return;
          }
          if (artifactUpload.status === 'uploaded') {
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
          + `payloadKB=${estimatedPayloadKB ?? 'n/a'} `
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
      // Warm the disk cache for this scan's candidate thumbnails (small urls)
      // so swiping into the change-card picker on bad wifi paints instantly.
      // Fire-and-forget off the scan hot path; raw lane only.
      if (mode === 'raw') {
        const candidateThumbUrls = matchResult.candidates
          .map((candidate) => candidate.smallImageUrl ?? candidate.imageUrl)
          .filter(Boolean) as string[];
        void prefetchImageUrls(candidateThumbUrls, imageCachePolicy.thumbnail).catch(() => {});
      }
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
          + `payloadKB=${matchTarget.normalizedImageBase64
            ? Math.round((matchTarget.normalizedImageBase64.length * 0.75) / 1024)
            : 'n/a'}`,
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

    if (!cameraRef.current || !isCameraReady || isCapturing || capturingRef.current) {
      return;
    }
    // Claim the lock synchronously BEFORE any await/setState so a second burst
    // tap in the same tick can't slip past the (still-false) isCapturing state.
    capturingRef.current = true;

    void triggerScannerHaptic();
    triggerCaptureFlash();
    triggerReticleLock();
    const scanStartedAt = Date.now();
    setIsCapturing(true);

    // THE billable moment. A guest browses with no Supabase user at all (each
    // anonymous user is a Monthly Active User Supabase charges for), so the scan
    // dispatch is where we finally mint one. Started here, in parallel with the
    // shutter + normalization, so it costs no visible latency, and awaited
    // before the match request goes out. Single-flight in the auth provider: a
    // burst of taps bills ONE user. No-op for anyone who already has a session.
    const guestSessionPromise = isGuest ? ensureGuestSession() : null;

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
          // Android camera2 writes the photo file landscape (rotated 90° from
          // display orientation) — record it NOW, before normalization computes
          // the same value, so the tray thumb can skip rendering the sideways
          // source file. Matches normalizationRotationDegrees set later.
          sourceImageRotationDegrees:
            rawSourceImageDimensions.width > rawSourceImageDimensions.height ? 90 : 0,
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

      // Default transport passes FILE URIs: the repository streams them as
      // multipart file parts, so no base64 ever crosses the JS thread on the
      // scan hot path. If the backend doesn't speak multipart (404/405/415),
      // the repository falls back to the JSON+base64 body and materializes the
      // bytes through this LAZY reader — the only place a base64 read still
      // happens.
      const readScanImageAsBase64 = async (fileUri: string) => {
        try {
          const base64 = await FileSystem.readAsStringAsync(fileUri, {
            encoding: 'base64',
          });
          if (base64) {
            return base64;
          }
        } catch {
          // Non-fatal: fall through to the breadcrumb below. The artifact
          // upload proceeds with the normalized target alone (the training-
          // critical image), so scan data is never silently dropped — only the
          // optional source context can be omitted.
        }
        if (fileUri === photo.uri) {
          // Breadcrumb so we can measure how often the optional source image
          // drops (the dominant cause of the 2026-05 card-show artifact loss).
          // On the multipart path the OS streams the file natively, so this
          // can only fire when the JSON fallback is actually taken.
          capturePostHogEvent('scan_source_base64_missing', {
            mode: isSlab ? 'slabs' : 'raw',
            had_photo_uri: Boolean(photo.uri),
          });
        }
        return null;
      };

      let matchPayload: ScannerCapturePayload = {
        height: normalizedTarget.normalizedImageDimensions.height,
        fileUri: normalizedTarget.normalizedImageUri,
        mode: isSlab ? 'slabs' : 'raw',
        cardLanguage: cardLanguageForCardType(cardType),
        width: normalizedTarget.normalizedImageDimensions.width,
        captureSource: 'camera',
        cameraZoomFactor: zoomFactor,
        normalizedImage: {
          fileUri: normalizedTarget.normalizedImageUri,
          width: normalizedTarget.normalizedImageDimensions.width,
          height: normalizedTarget.normalizedImageDimensions.height,
        },
        sourceImage: {
          fileUri: photo.uri,
          width: normalizedTarget.nativeSourceImageDimensions.width,
          height: normalizedTarget.nativeSourceImageDimensions.height,
        },
        submittedAt: new Date(scanStartedAt).toISOString(),
        readFileAsBase64: readScanImageAsBase64,
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

      // The match (and the artifact upload it carries) is the first authed call
      // of a guest's life. If the mint failed — anonymous sign-ins off, offline
      // — fail the capture the same way a failed match does (tray row drops out
      // of its loading state, error haptic, scan_match_failed) instead of firing
      // a request that can only 401. The next tap retries the mint.
      if (guestSessionPromise && !(await guestSessionPromise)) {
        throw new Error('guest_session_unavailable');
      }

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
    ensureGuestSession,
    hasPermission,
    isCameraReady,
    isCapturing,
    isGuest,
    requestPermission,
    runMatchForCapture,
    triggerCaptureFlash,
    triggerReticleLock,
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
          // The fixture ships both transports: the file URI drives the default
          // multipart path (same lane as real scans) and the inline base64
          // keeps the JSON fallback read-free.
          fileUri: normalizedTarget.normalizedImageUri,
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

  // Backs the row's "WISHLIST" pill (Figma 1511:4096). Favorites the active
  // candidate, then slides the row out of the tray exactly like the swipe-rail
  // Collection action: optimistically flip the pill to "WISHLISTED", persist,
  // and on success schedule `removeCaptureAfterAdd` after the same brief
  // confirmation so the row plays its reanimated left-slide + fade exit. A
  // failed write reverts the flip and keeps the row in the tray.
  const handleRowWishlist = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !candidate) {
      return;
    }
    const { cardId } = candidate;

    // Instant feedback: flip the pill to WISHLISTED before the network settles.
    setRecentCaptures((current) => withUpdatedCaptureFavoriteState(current, cardId, true));

    let didSucceed = false;
    try {
      await spotlightRepository.setCardFavorite(cardId, true);
      setInventoryEntries((current) => withUpdatedInventoryFavoriteState(current, cardId, true));
      refreshData();
      didSucceed = true;
      capturePostHogEvent('scan_wishlist_added', { mode: capture.mode });
    } catch (error) {
      logScannerDiagnostic(
        `[SCANNER] wishlist add failed cardID=${cardId} message=${scannerErrorMessage(error)}`,
        error,
      );
      // Revert the optimistic flip and leave the row in the tray to retry.
      setRecentCaptures((current) => withUpdatedCaptureFavoriteState(current, cardId, false));
    }

    if (didSucceed) {
      const existingTimer = recentlyAddedTimersRef.current.get(captureId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      // Show the "WISHLISTED" confirmation briefly, then drop the row — its
      // reanimated exit plays the left-slide + fade (same as a collection add).
      const timerId = setTimeout(() => {
        recentlyAddedTimersRef.current.delete(captureId);
        removeCaptureAfterAdd(captureId);
      }, addedConfirmationDurationMs);
      recentlyAddedTimersRef.current.set(captureId, timerId);
    }
  }, [recentCaptures, refreshData, removeCaptureAfterAdd, spotlightRepository]);

  const handleAddToInventory = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((candidate) => candidate.id === captureId);
    const activeCandidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !activeCandidate || capture.isLoadingCandidates || capture.isAddingToInventory) {
      return;
    }

    // Fired on intent, before the write. `scan_inventory_add_failed` sitting at
    // zero could mean adding never fails or that nobody ever reaches it; without
    // this event those two are indistinguishable.
    capturePostHogEvent('scan_add_tapped', {
      mode: capture.mode,
    });

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
      const createResponse = await spotlightRepository.createInventoryEntry(
        buildInventoryEntryArgs(capture, activeCandidate, addedAt, selectedCondition, activeCollectionID),
      );
      capturePostHogEvent('scan_inventory_add_succeeded', {
        mode: capture.mode,
      });
      didSucceed = true;
      // Surface the new card at the top of the Collection instantly. Reuse the
      // REAL entry id from the create response so the background refetch
      // reconciles (dedupes) by id instead of duplicating the optimistic row.
      // The scanner's own tray inventory was already updated above via
      // `withOptimisticInventoryAdd`; this bridges it into the shared portfolio
      // cache + on-screen collection without waiting on the slow dashboard.
      prependOptimisticInventoryEntry(
        buildOptimisticInventoryEntry(
          activeCandidate,
          createResponse.addedAt || addedAt,
          { mode: capture.mode, slabContext: capture.slabContext },
          createResponse.deckEntryID,
        ),
      );
      // Reconcile against the server's canonical list in the BACKGROUND. The
      // optimistic add above already shows this card, so blocking the spinner on
      // a second full-inventory refetch is exactly what made single-add feel
      // slower than "Add all" (which never awaits this). Fire-and-forget so the
      // spinner clears as soon as the write itself lands.
      void spotlightRepository.getInventoryEntries()
        .then((nextEntries) => setInventoryEntries(nextEntries))
        .catch(() => {
          // Optimistic state stands; refreshData below still nudges screens.
        });
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
  }, [prependOptimisticInventoryEntry, priceSelection, recentCaptures, refreshData, removeCaptureAfterAdd, spotlightRepository, trackCandidateSelectionIfNeeded]);

  // Stable wrapper for the swipe row's "Collection" action so React.memo doesn't
  // re-render every row when handleAddToInventory re-creates on recentCaptures
  // change. The rail's Collection button adds the scan to the collection — the
  // same flow as the row's ADD pill.
  const handleAddToInventoryRef = useRef(handleAddToInventory);
  useEffect(() => {
    handleAddToInventoryRef.current = handleAddToInventory;
  }, [handleAddToInventory]);
  const handleRowAddToCollection = useCallback((captureId: string) => {
    void handleAddToInventoryRef.current(captureId);
  }, []);

  // Bulk "Add to Wishlist": clear the tray NOW, then wishlist (favorite) every
  // resolved scan in the BACKGROUND. Two reasons it isn't done inline:
  //   - Speed: blocking on N sequential setCardFavorite calls would stall the
  //     confirm sheet; backgrounding the writes makes the dismiss instant.
  //   - Stability: clearing via the empty→auto-collapse effect (no LayoutAnimation)
  //     instead of an explicit animated collapse avoids the iOS crash from firing a
  //     tray LayoutAnimation while N rows are removed in the same frame.
  // Wishlist the good ones, drop failures, clear everything regardless.
  const handleBulkAddToWishlist = useCallback(() => {
    // Snapshot the resolved cardIds BEFORE clearing the tray; de-dupe so repeat
    // scans of the same card only favorite it once.
    const cardIds = Array.from(
      new Set(
        recentCaptures
          .filter((capture) => !capture.isLoadingCandidates && !capture.recentlyAdded)
          .map((capture) => activeCandidateForCapture(capture)?.cardId)
          .filter((cardId): cardId is string => cardId != null),
      ),
    );

    performClearAllCaptures();

    if (cardIds.length === 0) {
      return;
    }

    void (async () => {
      let succeeded = 0;
      // Sequential — concurrent writes contend on the backend's SQLite store.
      for (const cardId of cardIds) {
        try {
          await spotlightRepository.setCardFavorite(cardId, true);
          succeeded += 1;
        } catch (error) {
          logScannerDiagnostic(`[SCANNER] addAll wishlist failed: ${scannerErrorMessage(error)}`, error);
        }
      }
      capturePostHogEvent('scan_add_all', {
        attempted: cardIds.length,
        succeeded,
        failed: cardIds.length - succeeded,
      });
      refreshData();
    })();
  }, [
    performClearAllCaptures,
    recentCaptures,
    refreshData,
    spotlightRepository,
  ]);

  // Bulk "Add to Collection": one inventory entry PER resolved scan (two scans of
  // the same card = two owned copies, mirroring the single-row Collection add),
  // reusing the same args/optimistic helpers. Clear the tray immediately, then
  // create entries sequentially in the background (concurrent writes contend on
  // the backend SQLite store) so the sheet dismiss stays instant.
  const handleBulkAddToCollection = useCallback(() => {
    const targets = recentCaptures.filter(
      (capture) => !capture.isLoadingCandidates && !capture.recentlyAdded,
    );

    performClearAllCaptures();

    if (targets.length === 0) {
      return;
    }

    void (async () => {
      let attempted = 0;
      let succeeded = 0;
      for (const capture of targets) {
        const candidate = activeCandidateForCapture(capture);
        if (!candidate) {
          continue;
        }
        attempted += 1;
        try {
          trackCandidateSelectionIfNeeded(capture);
          const addedAt = new Date().toISOString();
          const condition: DeckConditionCode = priceSelection.get(capture.id)?.conditionCode ?? 'near_mint';
          const createResponse = await spotlightRepository.createInventoryEntry(
            buildInventoryEntryArgs(capture, candidate, addedAt, condition, activeCollectionID),
          );
          prependOptimisticInventoryEntry(
            buildOptimisticInventoryEntry(
              candidate,
              createResponse.addedAt || addedAt,
              { mode: capture.mode, slabContext: capture.slabContext },
              createResponse.deckEntryID,
            ),
          );
          succeeded += 1;
        } catch (error) {
          logScannerDiagnostic(`[SCANNER] addAll collection failed: ${scannerErrorMessage(error)}`, error);
        }
      }
      capturePostHogEvent('scan_add_all_collection', {
        attempted,
        succeeded,
        failed: attempted - succeeded,
      });
      refreshData();
    })();
  }, [
    performClearAllCaptures,
    priceSelection,
    recentCaptures,
    refreshData,
    spotlightRepository,
    prependOptimisticInventoryEntry,
    trackCandidateSelectionIfNeeded,
  ]);

  // Bulk "Remove": clear the whole scan session (same path as CLEAR ALL).
  const handleBulkRemove = useCallback(() => {
    performClearAllCaptures();
  }, [performClearAllCaptures]);

  // Open the ADD ALL dropdown anchored under its header trigger. Open
  // immediately, then update the anchor once the async measure resolves (the
  // menu falls back to a sensible position until then / if measure never fires).
  const handleOpenAddAllMenu = useCallback(() => {
    setAddAllMenuOpen(true);
    const node = addAllTriggerRef.current;
    if (node && typeof node.measureInWindow === 'function') {
      node.measureInWindow((x, y, width, height) => {
        setAddAllAnchor({ x, y, width, height });
      });
    }
  }, []);

  // Menu pick -> close the menu, open the matching confirm sheet. The ref keeps
  // the sheet's copy stable through its slide-out after `addAllConfirm` clears.
  const handleAddAllSelect = useCallback((action: AddAllMenuAction) => {
    lastBulkActionRef.current = action;
    setAddAllMenuOpen(false);
    setAddAllConfirm(action);
  }, []);

  // Per-row "ADD ▾" pick -> run the action immediately (no confirm sheet).
  const handleRowMenuSelect = useCallback((action: AddAllMenuAction) => {
    const captureId = rowMenuCaptureId;
    setRowMenuCaptureId(null);
    if (!captureId) return;
    if (action === 'collection') handleRowAddToCollection(captureId);
    else if (action === 'wishlist') void handleRowWishlist(captureId);
    else if (action === 'remove') deleteRecentCapture(captureId);
  }, [rowMenuCaptureId, handleRowAddToCollection, handleRowWishlist, deleteRecentCapture]);

  const handleAddAllConfirm = useCallback(() => {
    const action = addAllConfirm;
    setAddAllConfirm(null);
    if (action === 'collection') {
      handleBulkAddToCollection();
    } else if (action === 'wishlist') {
      handleBulkAddToWishlist();
    } else if (action === 'remove') {
      handleBulkRemove();
    }
  }, [addAllConfirm, handleBulkAddToCollection, handleBulkAddToWishlist, handleBulkRemove]);

  // Count for the confirm copy: resolved (non-loading, matched) scans for the add
  // actions; the whole session for remove.
  const bulkEligibleCount = useMemo(
    () => recentCaptures.filter(
      (capture) => !capture.isLoadingCandidates && !capture.recentlyAdded && activeCandidateForCapture(capture) != null,
    ).length,
    [recentCaptures],
  );

  const activeBulkAction: AddAllMenuAction = addAllConfirm ?? lastBulkActionRef.current;
  const removeCount = recentCaptures.length;
  const itemWord = (count: number) => (count === 1 ? 'item' : 'items');
  const bulkConfirmConfig = activeBulkAction === 'remove'
    ? {
        title: `Delete ${removeCount} ${itemWord(removeCount)}?`,
        description: 'These items will be removed from this scan session.',
        confirmLabel: 'Remove',
        confirmVariant: 'destructive' as const,
      }
    : activeBulkAction === 'wishlist'
      ? {
          title: `Add ${bulkEligibleCount} ${itemWord(bulkEligibleCount)} to Wishlist?`,
          description: 'These items will be added to your Wishlist using their current scan details.',
          confirmLabel: 'Add All',
          confirmVariant: 'dark' as const,
        }
      : {
          title: `Add ${bulkEligibleCount} ${itemWord(bulkEligibleCount)} to Collections?`,
          description: 'These items will be added to your Collections using their current scan details.',
          confirmLabel: 'Add All',
          confirmVariant: 'dark' as const,
        };

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
    // Warm the PDP caches: a graded slab capture → graded lane on its grader,
    // otherwise the default raw lane.
    prefetchCardDetail(
      spotlightRepository,
      candidate.cardId,
      capture.slabContext?.grader
        ? { grader: capture.slabContext.grader, mode: 'graded', variant: null }
        : { grader: null, mode: 'raw', variant: 'Normal' },
      candidate.imageUrl,
    );
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: candidate.cardId,
        entryId: matchingInventoryEntries[0],
        // Seed a preview (the tapped candidate IS a CatalogSearchResult) so the
        // PDP body renders instantly instead of a blank "Loading card…" while
        // getCardDetail resolves — matching search / portfolio / wishlist nav.
        previewId: saveCardDetailPreviewFromCatalogResult(candidate),
        scanReviewId,
      },
    });
  }, [inventoryByCardId, recentCaptures, router, spotlightRepository, trackCandidateSelectionIfNeeded]);

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

    /*
      Last resort, and in practice unreachable: `(tabs)/scan.tsx` always passes
      `onExitToPortfolio`, so the branch above returns first.

      It used to pass `params: { page: 'portfolio' }`, which was dead — nothing
      reads `page` now that each page is a real route, and `/` stopped being the
      Collection when the feed took the tabs root (`login-callback.tsx` carries
      the full diagnosis of the same stale param). So it claimed to reach the
      Collection and reached the feed.

      Dropping the param rather than re-pointing it at `/you`: `dismissTo`
      dispatches POP_TO, which `NativeBottomTabsRouter` cannot handle for a tab —
      see the note in `app-drawer.tsx`. `/` is a root path and works, and landing
      on the app's root surface is the right answer for "there is nothing to go
      back to" anyway.
    */
    router.dismissTo('/');
  }, [onExitToPortfolio, router]);

  const handleOpenCatalogSearch = useCallback(() => {
    router.push('/catalog/search');
  }, [router]);

  // The inner scroll list participates in the gesture arena so the tray pan and
  // the list scroll resolve together (swipe down at the top collapses; once
  // scrolled, the same drag scrolls the list instead of collapsing).
  const trayScrollNativeGesture = useMemo(() => Gesture.Native(), []);

  // Mirrors the list's scroll offset into `trayScrollOffset` on the UI thread
  // so the pan worklets below read a live value (a JS-ref mirror goes stale
  // exactly when the JS thread is busy — the moment the tray used to jank).
  const handleTrayScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      trayScrollOffset.value = event.contentOffset.y;
    },
  });

  // Vertical swipe to expand/collapse the tray. Lives in gesture-handler (not a
  // JS PanResponder) so it shares one arena with the row swipe-to-action
  // Swipeables; otherwise the native row recognizers swallow the vertical drag.
  // `activeOffsetY` keeps it off horizontal row swipes; `failOffsetX` yields to
  // them outright. Disabled while a row action rail is open (`isTopLevelSwipe`).
  //
  // CRITICAL: these callbacks are auto-workletized (react-native-worklets/
  // plugin) and run on the UI thread, so they CANNOT touch refs or call
  // setState directly — doing so crashed the app on every swipe. They work
  // exclusively on shared values + captured render constants; the ONLY JS hop
  // is the final `runOnJS(commitTrayExpandedState)`, and the settle animation
  // is started UI-side BEFORE that hop. (Previously the whole animation waited
  // on onEnd → runOnJS → setState → full-screen re-render → useAnimatedStyle,
  // which on a busy JS thread started the slide ~1s after the swipe.)
  const trayPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canToggleTray && isTopLevelSwipeEnabled && !isGuest)
        .activeOffsetY([-10, 10])
        .failOffsetX([-16, 16])
        .simultaneousWithExternalGesture(trayScrollNativeGesture)
        .onBegin(() => {
          // Captured at touch-down: collapse is only offered when the list was
          // already at the top when the drag began (so a scroll-to-top drag
          // doesn't also collapse the tray).
          trayDragStartScrollOffset.value = trayScrollOffset.value;
        })
        .onStart(() => {
          trayDragStartHeight.value =
            trayDragHeight.value
            ?? (isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight);
        })
        .onUpdate((event) => {
          // Track the finger: expanding is always allowed from collapsed;
          // while expanded, the drag only collapses from top-of-content
          // (mid-list drags belong to the ScrollView).
          const mayFollow = isTrayExpanded
            ? trayDragStartScrollOffset.value <= 0
            : true;
          if (!mayFollow) {
            return;
          }
          trayDragHeight.value = Math.min(
            trayScrollViewportHeight,
            Math.max(collapsedViewportHeight, trayDragStartHeight.value - event.translationY),
          );
        })
        .onEnd((event) => {
          const shouldExpand =
            !isTrayExpanded
            && (event.translationY <= -traySwipeThreshold || event.velocityY <= -trayFlingVelocity);
          const shouldCollapse =
            isTrayExpanded
            && trayDragStartScrollOffset.value <= 0
            && (event.translationY >= traySwipeThreshold || event.velocityY >= trayFlingVelocity);
          const nextExpanded = shouldExpand ? true : shouldCollapse ? false : isTrayExpanded;

          if (nextExpanded !== isTrayExpanded) {
            // Settle toward the new target NOW, on the UI thread. The JS state
            // flip re-renders in parallel; the release effect then hands the
            // height back to the state-driven timing with no visual jump.
            trayDragHeight.value = withTiming(
              nextExpanded ? trayScrollViewportHeight : collapsedViewportHeight,
              trayHeightTimingConfig,
            );
            runOnJS(commitTrayExpandedState)(nextExpanded);
          } else {
            // Aborted drag: release the override so the animated style glides
            // the height back to the current state's target.
            trayDragHeight.value = null;
          }
        }),
    [
      canToggleTray,
      collapsedViewportHeight,
      commitTrayExpandedState,
      isGuest,
      isTopLevelSwipeEnabled,
      isTrayExpanded,
      trayDragHeight,
      trayDragStartHeight,
      trayDragStartScrollOffset,
      trayScrollNativeGesture,
      trayScrollOffset,
      trayScrollViewportHeight,
    ],
  );

  const promptCopy = !hasPermission
    ? 'Allow camera access to scan'
    : isCapturing
      ? 'Capturing scan...'
      : 'Tap to scan';

  // Stable per-row callbacks so `CaptureTrayRow`'s memo can actually bail out.
  const handleShowRowPrice = useCallback((captureId: string) => {
    setActivePriceCaptureId(captureId);
  }, []);
  const handleOpenRowMenu = useCallback((captureId: string, anchor: CaptureRowMenuAnchor) => {
    setRowMenuAnchor(anchor);
    setRowMenuCaptureId(captureId);
  }, []);

  const renderCaptureRow = (capture: RecentCapture, index: number) => (
    <CaptureTrayRow
      key={capture.id}
      capture={capture}
      // Collapsed tray shows a single row; after ADD the next card advances
      // in with the slide-from-right enter. Expanded list opens without
      // fanning every row, so enter is gated to the collapsed viewport.
      enableEnterAnimation={!isTrayExpanded}
      index={index}
      onActionRailVisibilityChange={handleCaptureActionRailVisibilityChange}
      onAddToCollection={gate(handleRowAddToCollection)}
      onDelete={gate(deleteRecentCapture)}
      onOpenCard={handleOpenCard}
      onOpenChangeCardPicker={gate(openChangeCardPicker)}
      onOpenRowMenu={handleOpenRowMenu}
      onShowPrice={gate(handleShowRowPrice)}
      selection={priceSelection.get(capture.id) ?? null}
    />
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
      {isActiveTab ? <ScannerKeepAwake /> : null}
      <RawScannerCaptureSurface
        cameraRef={cameraRef}
        canCapture={canCapture}
        hasCameraPermission={hasCameraPermission}
        isTrayExpanded={isTrayExpanded}
        layout={captureSurfaceLayout}
        reticleLockProgress={reticleLockProgress}
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

        {/*
          NO DARK STRIP behind the toolbar. It was `rgba(0, 0, 0, 0.25)` across
          the full header height; the frame (3686:56583) has the glass controls
          floating straight over the camera with nothing behind them, which is
          the whole point of making them glass. Each control carries its own
          contrast now.

          The cost, stated: the status-bar clock no longer has a scrim under it,
          so on a very bright card it sits on whatever the camera sees. If that
          reads badly in practice, bring back a much shorter, much lighter strip
          behind the STATUS BAR only — not the full header, which is what made
          the old one read as chrome.
        */}
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
          <GlassNavBubble
            accessibilityLabel="Exit scanner"
            onPress={gate(handleExitScanner)}
            // 40, level with the search pill beside it (Figma 3686:55168).
            // `small` (32) was sized for a row of bare icons.
            size="compact"
            surface="onDark"
            testID="scanner-back-button"
          >
            <IconChevronLeft color={colors.gray0} size={20} strokeWidth={1.5} />
          </GlassNavBubble>
          {/*
            A full search FIELD, not a magnifier bubble (Figma 3686:56583). A
            32pt icon reads as "some action"; a full-width field reads as
            "search, and this is where you would type" — which is what it does.
            It takes the rest of the row for that reason.
          */}
          <ScannerSearchPill
            onPress={gate(handleOpenCatalogSearch)}
            testID="scanner-search-button"
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

        {isTrayExpanded ? null : (
          <View
            pointerEvents="box-none"
            style={[
              styles.controlsRow,
              // Sit 16px above the scan tray (Figma 1180-1278): anchored to the
              // tray's top edge — taller collapsed tray once a scan exists, the
              // shorter empty peek otherwise — rather than pinned under the reticle.
              {
                left: 16,
                right: 16,
                bottom: (recentCaptures.length > 0 ? collapsedTrayReservedHeight : emptyTrayVisualHeight) + 16,
              },
            ]}
          >
            <ScanTargetPill
              flag={cardType === 'pokemon_jp' ? 'jp' : 'en'}
              label={scanTargetPillLabel(cardType)}
              onPress={gate(() => {
                // Tapping the pill is also a tooltip dismissal — they learn the
                // control by using it.
                dismissLanguageTooltip();
                setIsScanTargetSheetOpen(true);
              })}
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
                    onPress={gate(() => setZoomFactor(factor))}
                    style={styles.zoomPill}
                    testID={`scanner-zoom-${factor}x`}
                  >
                    {/*
                      Only the SELECTED factor has a surface; the others are bare
                      labels, as in Figma 1041-4238. Glass on iOS 26, the same
                      dark scrim as before everywhere else — see `ScanTargetPill`
                      for why the scheme is pinned `dark` rather than `auto`.
                    */}
                    {selected ? (
                      <GlassSurface
                        fallbackColor={colors.scannerChromeFill}
                        glassColorScheme="dark"
                        glassEffectStyle="clear"
                        style={styles.zoomPillSurface}
                        testID={`scanner-zoom-${factor}x-surface`}
                      >
                        <Text style={[styles.zoomPillLabel, styles.zoomPillLabelSelected]}>
                          {`${factor}x`}
                        </Text>
                      </GlassSurface>
                    ) : (
                      <Text style={styles.zoomPillLabel}>{`${factor}x`}</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {isTrayExpanded ? null : (
          <View
            pointerEvents="box-none"
            style={[
              styles.languageTooltipWrap,
              {
                // Directly above the language pill: the controls row's tray-anchored
                // bottom + the 36px pill + an 8px gap.
                bottom:
                  (recentCaptures.length > 0 ? collapsedTrayReservedHeight : emptyTrayVisualHeight)
                  + 16 + 36 + 8,
              },
            ]}
          >
            <ScannerLanguageTooltip
              onPress={dismissLanguageTooltip}
              visible={showLanguageTooltip && !isScanTargetSheetOpen}
            />
          </View>
        )}

        <GestureDetector gesture={trayPanGesture}>
        <View style={styles.trayShell} testID="scanner-tray">
          {/*
            THE TRAY IS THE MATERIAL, not a dark panel (Figma 3686:56861 — the
            camera reads straight through it).

            Two paths on purpose. iOS 26 gets real Liquid Glass, which is the
            frame. Everywhere else keeps the BlurView it already had, because
            that blur is doing real work here: this sits over a live viewfinder,
            and a flat scrim in its place would be a downgrade on every Android
            device rather than a fallback.

            This is a branch at the CALL SITE, not inside `GlassSurface` — the
            primitive's no-blur rule is about not faking glass where there is
            none, and the blur below is the treatment that already shipped.
          */}
          {isLiquidGlassAvailable() ? (
            <GlassSurface
              fallbackColor="transparent"
              glassColorScheme="dark"
              glassEffectStyle="clear"
              pointerEvents="none"
              style={styles.trayBackdropBlur}
              testID="scanner-tray-glass"
            />
          ) : (
            <>
              <BlurView
                // Android needs the dimezisBlurView method or BlurView is a silent
                // no-op (frosted tray rendered flat vs iOS). Matches the card-detail
                // panels, which already opt in. iOS ignores the prop.
                experimentalBlurMethod="dimezisBlurView"
                intensity={isTrayExpanded ? 80 : 24}
                pointerEvents="none"
                style={styles.trayBackdropBlur}
                tint="dark"
              />
              <View pointerEvents="none" style={styles.trayBackdropOverlay} />
            </>
          )}
          <Pressable
            accessibilityLabel={isTrayExpanded ? 'Collapse recent scans' : 'Expand recent scans'}
            accessibilityRole="button"
            disabled={!canToggleTray}
            hitSlop={trayHeaderHitSlop}
            onPress={gate(toggleTrayExpanded)}
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
                {/*
                  Was an opaque gray900 chip — the one surface on this screen
                  that read as a different material from everything else over
                  the camera. Glass on iOS 26, the same scrim elsewhere.
                */}
                <GlassSurface
                  fallbackColor={colors.scannerChromeFill}
                  glassColorScheme="dark"
                  glassEffectStyle="clear"
                  style={styles.trayInfoPill}
                  testID="scanner-recent-title-surface"
                >
                  <Text style={styles.trayInfoPillLabel} testID="scanner-recent-title">
                    {`SCAN: ${recentCaptures.length}`}
                  </Text>
                </GlassSurface>
                {/* ADD ALL shows in BOTH tray states — collapsed too, so a
                    burst scanner can bulk-add without first swiping the tray
                    up. The dropdown flips above its anchor near the screen
                    bottom, which covers the collapsed position. */}
                {recentCaptures.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add all scans"
                    hitSlop={8}
                    onPress={gate(handleOpenAddAllMenu)}
                    ref={addAllTriggerRef}
                    testID="scanner-tray-add-all"
                  >
                    <View style={styles.trayAddAllRow}>
                      <Text style={styles.trayAddAllLabel}>ADD ALL</Text>
                      <IconChevronDown
                        color={colors.purple500}
                        size={15}
                        strokeWidth={2}
                      />
                    </View>
                  </Pressable>
                ) : null}
              </View>
              <GlassSurface
                fallbackColor={colors.scannerChromeFill}
                glassColorScheme="dark"
                glassEffectStyle="clear"
                style={styles.trayInfoPill}
                testID="scanner-value-pill-surface"
              >
                <Text style={styles.trayInfoPillLabel} testID="scanner-value-pill-text">
                  {`TOTAL: ${formatTrayTotal(trayPriceSummary)}`}
                </Text>
              </GlassSurface>
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
              <Reanimated.View
                style={[styles.trayViewport, trayViewportAnimatedStyle]}
                testID="scanner-tray-viewport"
              >
                <GestureDetector gesture={trayScrollNativeGesture}>
                <Reanimated.ScrollView
                  ref={trayScrollRef}
                  nestedScrollEnabled
                  // No top rubber-band: at top-of-content a downward drag
                  // belongs to the tray pan (finger-following collapse). With
                  // bounce on, the ScrollView rubber-bands that same drag
                  // simultaneously and the two motions fight — the half-second
                  // stutter when collapsing a full tray from max height. (A
                  // 2-row tray never enables scrolling, which is why it was
                  // always smooth.)
                  bounces={false}
                  overScrollMode="never"
                  onScroll={handleTrayScroll}
                  scrollEnabled={isTrayExpanded && trayScrollEnabled}
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={isTrayExpanded && trayScrollEnabled}
                  style={styles.trayScroll}
                  contentContainerStyle={[
                    styles.trayScrollContent,
                    // Pin the scroll content to its full intrinsic height so the
                    // row list geometry is FIXED and independent of the parent
                    // viewport height, which springs from tall→short on collapse.
                    // Without this, every frame of the collapse shrinks the
                    // viewport and RN re-lays-out the ScrollView content; with a
                    // tall list that per-frame reflow drives each row's
                    // `layout={LinearTransition}` and janks for ~0.5s. Pinning the
                    // height means the viewport just clips (native height anim) and
                    // the rows never re-measure. (Empty case is handled above, so
                    // trayContentHeight is always > 0 here.)
                    { height: trayContentHeight },
                  ]}
                  testID="scanner-tray-scroll"
                >
                  {visibleCaptures.map(renderCaptureRow)}
                  {isTrayExpanded ? (
                    <View style={styles.trayClearSection}>
                      <ArenaPressable
                        accessibilityRole="button"
                        accessibilityLabel="Clear all scans"
                        hitSlop={8}
                        onPress={gate(handleClearAllCaptures)}
                        style={({ pressed }) => [
                          styles.trayClearAllPill,
                          pressed ? styles.trayClearAllPillPressed : null,
                        ]}
                        testID="scanner-tray-clear-all"
                      >
                        <Text style={styles.trayClearAllLabel}>CLEAR ALL</Text>
                      </ArenaPressable>
                    </View>
                  ) : null}
                </Reanimated.ScrollView>
                </GestureDetector>
              </Reanimated.View>
            )}
          </View>
        </View>
        </GestureDetector>
        <Reanimated.View
          pointerEvents="none"
          style={[styles.captureFlash, captureFlashStyle]}
        />
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
            onOpenEbayLink={activeCapture.mode === 'slabs' ? gate(handleOpenEbayFromSheet) : undefined}
            ebayLinkLoading={ebayState?.loading ?? false}
            ebayLinkAvailable={ebayState?.url != null}
          />
        );
      })()}

      <AddAllMenu
        anchor={addAllAnchor}
        onClose={() => setAddAllMenuOpen(false)}
        onSelect={handleAddAllSelect}
        visible={addAllMenuOpen}
      />

      <AddAllMenu
        anchor={rowMenuAnchor}
        onClose={() => setRowMenuCaptureId(null)}
        onSelect={(action) => {
          // Guests: dismiss the dropdown first, THEN open login. (Can't use the
          // plain gate() wrapper here — the menu-close lives inside
          // handleRowMenuSelect, which gate would skip, leaving the dropdown up.)
          if (isGuest) {
            setRowMenuCaptureId(null);
            openLogin();
            return;
          }
          handleRowMenuSelect(action);
        }}
        testID="scanner-row-add-menu"
        visible={rowMenuCaptureId != null}
      />

      <ScanBulkConfirmSheet
        confirmLabel={bulkConfirmConfig.confirmLabel}
        confirmVariant={bulkConfirmConfig.confirmVariant}
        description={bulkConfirmConfig.description}
        onCancel={() => setAddAllConfirm(null)}
        onConfirm={handleAddAllConfirm}
        title={bulkConfirmConfig.title}
        visible={addAllConfirm != null}
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
            onOpenMatchedCard={(candidate) => {
              if (!candidate.cardId) {
                return;
              }
              // Warm the PDP caches (like search/portfolio nav) then open the
              // matched card's detail page over the picker; back returns here.
              prefetchCardDetail(spotlightRepository, candidate.cardId, undefined, candidate.imageUrl);
              router.push({
                pathname: '/cards/[cardId]',
                params: {
                  cardId: candidate.cardId,
                  previewId: saveCardDetailPreviewFromCatalogResult(candidate),
                },
              });
            }}
            onClose={closeChangeCardPicker}
          />
        );
      })()}

      <ScanningForSheet
        visible={isScanTargetSheetOpen}
        cardType={cardType}
        onSelectCardType={(type) => {
          // Picking a language is a one-tap action: apply it and close the sheet
          // so the user doesn't have to also tap out of the modal to dismiss it.
          setCardType(type);
          setIsScanTargetSheetOpen(false);
        }}
        onClose={() => setIsScanTargetSheetOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  captureFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
  },
  topChromeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    // 8, matching the frame's spacers — the search pill takes the remaining
    // width, so `justifyContent` no longer decides anything here.
    gap: 8,
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
  languageTooltipWrap: {
    // Left-aligned with the language pill (controls row inset 16).
    left: 16,
    position: 'absolute',
    // Above the controls row so the tail visually touches the pill.
    zIndex: 5,
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
  // The glass fills the whole 36pt circle, so the material clips the label
  // rather than sitting behind it.
  zoomPillSurface: {
    alignItems: 'center',
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 36,
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
    // Figma 3594:25994 — 5 between the TCGplayer mark and the price.
    gap: 5,
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
    // Figma 3594:25986 — 58x80 at radius 2.695, which is a real card's corner
    // scaled to thumbnail size, not a UI radius. The old 6 rounded it like a
    // tile and read as a rounded button rather than a card.
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 2.695,
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
  captureGradedRefChip: {
    backgroundColor: colors.scannerConditionPill,
    borderRadius: 4,
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14.3,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  captureTitle: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
  },
  capturePriceColumn: {
    alignItems: 'flex-end',
    gap: 12,
    // Widened from 84 so the "WISHLISTED" pill (longer than the old "ADD")
    // fits without overflowing the right column into the title/price area.
    width: 108,
  },
  captureAddPill: {
    // Figma "ADD ⌄" pill: filled purple/500 #A54BFA, radius-8, Plus Jakarta
    // Sans SemiBold 13 white label + 16px chevron. Horizontal padding is 8 per
    // the footer spec (3594:25998); the earlier 1874:13192 said 12, and this
    // node is the later of the two.
    alignItems: 'center',
    backgroundColor: colors.scannerAddPurple,
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: 2,
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  captureAddPillPressed: {
    // Press-down feedback (scale 1 → 0.94), matching the other tray controls.
    opacity: 0.78,
    transform: [{ scale: 0.94 }],
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
    borderRadius: radii.pill,
    // Clips the glass to the pill shape.
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  trayInfoPillLabel: {
    // White per Figma 1041-4238. `gray400` was legible against the old opaque
    // gray900 chip; over glass or the scrim it has the camera behind it and
    // needs the same contrast as every other label on this screen.
    ...textStyles.labelStrong,
    color: colors.gray0,
  },
  trayAddAllRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
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
    // Figma 3594:26001 — 36x4, radius 2, gray/100.
    backgroundColor: colors.gray100,
    borderRadius: 2,
    height: 4,
    width: 36,
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
