import { BlurView } from 'expo-blur';
import * as FileSystem from 'expo-file-system/legacy';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useRouter } from 'expo-router';
import { Fragment, memo, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  isSpotlightRepositoryRequestError,
  type CatalogSearchResult,
  type DeckConditionCode,
  type InventoryCardEntry,
  type InventoryEntryCreateRequestPayload,
  type ScannerCapturePayload,
  type ScannerMatchResult,
  type SlabContext,
} from '@spotlight/api-client';
import {
  Button,
  GlassNavBubble,
  GlassSurface,
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
  type BinderPageImage,
  type NormalizedScannerTarget,
  binderPageGridSize,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
  buildBinderPocketTargets,
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
import { ScanningForSheet } from '@/features/scanner/components/scanning-for-sheet';
import {
  scanCardLanguageForLane,
  scanTargetFlag,
  scanTargetPillLabel,
  useScannerTargetConfig,
} from '@/features/scanner/use-scanner-target-config';

import { BinderPageReview } from './binder-page-review';
import { ChangeCardPicker } from './change-card-picker';
import { RecentCaptureSwipeRow } from './recent-capture-swipe-row';
import { ScanPriceSheet, type ScanPriceSheetSelection } from './scan-price-sheet';
import {
  activeCandidateForCapture,
  alignToFourPointGrid,
  analyzeSlabCapture,
  binderPageRows,
  binderPocketRowId,
  insertBinderPocketRows,
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
  scannerLaneUnavailableReason,
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
// Burst guard (2026-09-01): under rapid taps the per-scan ML Kit passes queued
// and starved the camera/normalize pipeline (await p50 94ms relaxed -> 2.3s in
// bursts; capture_ms tripled). One read in flight at a time — burst scans skip
// the OPTIONAL tiebreak signal instead of stacking CPU.
let rawCollectorNumberReadInFlight = false;
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
// Expanded tray only: the "Binder page" group header above a page's nine rows.
const binderPageHeaderHeight = 40;
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

// Windowed tray rows: only rows within the expanded viewport ± this overscan
// render full content (Swipeable + image + pressables); the rest are
// fixed-height shells. A full tray is 100+ rows (~5k native views when all
// mounted), which made swipes, list scrolls and burst-scan commits scale with
// tray size. ~5 rows of headroom on each side.
const trayRenderOverscanPx = 600;
// The scroll offset feeding the window only updates JS state when it crosses a
// bucket edge (not per scrolled pixel). Must stay well under the overscan so a
// row's content is mounted before it can scroll into view.
const trayRenderWindowBucketPx = 464;


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

// "Pocket 4" plus a 3x3 glyph with that cell lit: the row's place on the page,
// readable without counting rows in the tray.
function PocketBadge({ pocketIndex }: { pocketIndex: number }) {
  const cells = binderPageGridSize * binderPageGridSize;
  return (
    <View style={styles.pocketBadge} testID={`scanner-tray-pocket-${pocketIndex}`}>
      <View style={styles.pocketGlyph}>
        {Array.from({ length: cells }, (_, cell) => (
          <View
            key={`cell-${cell}`}
            style={[styles.pocketGlyphCell, cell === pocketIndex ? styles.pocketGlyphCellActive : null]}
          />
        ))}
      </View>
      <Text style={styles.pocketBadgeLabel}>{`Pocket ${pocketIndex + 1}`}</Text>
    </View>
  );
}

type CaptureTrayRowProps = {
  capture: RecentCapture;
  // Ref, not a boolean: `entering` only matters at mount, but a boolean prop
  // derived from `isTrayExpanded` changed identity for every row on every tray
  // toggle — a full 100+-row re-render at the exact moment the expand/collapse
  // animation started. The ref is stable; rows read `.current` when they render.
  enterAnimationEnabledRef: MutableRefObject<boolean>;
  index: number;
  onActionRailVisibilityChange: (key: string, visible: boolean) => void;
  onAddToCollection: (captureId: string) => void;
  onDelete: (captureId: string) => void;
  onOpenCard: (captureId: string) => void | Promise<void>;
  onOpenChangeCardPicker: (captureId: string) => void;
  onOpenRowMenu: (captureId: string, anchor: CaptureRowMenuAnchor) => void;
  onShowPrice: (captureId: string) => void;
  // Windowed tray rendering: rows far outside the scroll viewport render a
  // fixed-height shell instead of the Swipeable + image + pressables. See
  // RecentCaptureSwipeRow.renderContent.
  renderContent: boolean;
  selection: ScanPriceSheetSelection | null;
};

// One scan-tray row, extracted from the screen render and memoized: each row
// carries a CachedImage thumb, a gesture-handler Swipeable and a Reanimated
// wrapper, so re-rendering all of them on every unrelated scanner-screen state
// change (camera readiness, capture flashes, zoom, eBay lookups, sheet
// open/close, …) made the tray's JS commits expensive with a full tray. All
// callback props must be render-stable — beware `gate(...)`, which returns a
// fresh closure per call and silently defeats this memo if used inline — so a
// row now only re-renders when ITS capture / price selection / index changes.
const CaptureTrayRow = memo(function CaptureTrayRow({
  capture,
  enterAnimationEnabledRef,
  index,
  onActionRailVisibilityChange,
  onAddToCollection,
  onDelete,
  onOpenCard,
  onOpenChangeCardPicker,
  onOpenRowMenu,
  onShowPrice,
  renderContent,
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
      enableEnterAnimation={enterAnimationEnabledRef.current}
      onActionRailVisibilityChange={onActionRailVisibilityChange}
      onAddToCollection={onAddToCollection}
      onDelete={onDelete}
      renderContent={renderContent}
      testID={`scanner-tray-swipe-${index}`}
    >
      {!renderContent ? null : (
      <View style={styles.captureRow} testID={`scanner-tray-row-${index}`}>
        <View style={styles.captureLeftGroup}>
          <View style={styles.captureThumbColumn}>
            <ArenaPressable
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
            </ArenaPressable>
            {canCycleCandidate ? (
              <ArenaPressable
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
              </ArenaPressable>
            ) : null}
          </View>

          <ArenaPressable
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
                  {capture.binderPage ? <PocketBadge pocketIndex={capture.binderPage.pocketIndex} /> : null}
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
                  {capture.binderPage ? <PocketBadge pocketIndex={capture.binderPage.pocketIndex} /> : null}
                </>
              ) : (
                <>
                  <Text numberOfLines={1} style={styles.captureTitle}>{captureFailureTitle(capture)}</Text>
                  <Text numberOfLines={2} style={styles.captureSubtitle}>{captureFailureSubtitle(capture)}</Text>
                </>
              )}
            </View>
          </ArenaPressable>
        </View>

        {candidate ? (
          <View style={styles.capturePriceColumn}>
            <ArenaPressable
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
            </ArenaPressable>
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
      )}
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
  /**
   * Binder-page POC (docs/binder-scan-v0-implementation-spec-2026-08-28.md):
   * one shutter tap → nine pocket scans. Dev builds only for now — the toggle
   * never renders in a store binary, so the flag can't be reached there.
   */
  const [isBinderPageMode, setIsBinderPageMode] = useState(false);
  const [activeBinderPageId, setActiveBinderPageId] = useState<string | null>(null);
  const [isAddingBinderPage, setIsAddingBinderPage] = useState(false);
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
  // Top of the windowed-row viewport in scroll-content px, bucketed (see
  // trayRenderWindowBucketPx). Drives which rows render full content.
  const [trayRenderWindowTop, setTrayRenderWindowTop] = useState(0);
  const [addAllMenuOpen, setAddAllMenuOpen] = useState(false);
  const [addAllAnchor, setAddAllAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [addAllConfirm, setAddAllConfirm] = useState<AddAllMenuAction | null>(null);
  const [rowMenuCaptureId, setRowMenuCaptureId] = useState<string | null>(null);
  const [rowMenuAnchor, setRowMenuAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const addAllTriggerRef = useRef<View | null>(null);
  const lastBulkActionRef = useRef<AddAllMenuAction>('collection');
  const { lane: scanLane, setLane: setScanLane } = useScannerTargetConfig();
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
  // Page mode reserves only the tray header so the full-width page reticle fits.
  // Page mode reserves the same footer as single mode: the collapsed tray pops
  // up with the newest rows exactly like a single scan (user decision — UX
  // parity beats the ~10% pocket-resolution gain of a header-only footer).
  const footerReservedHeight = collapsedTrayReservedHeight;
  const captureSurfaceLayout = makeRawScannerCaptureLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    // Page mode widens the reticle to the full usable width: it is the page
    // detector, so its width sets every pocket crop's resolution.
    mode: isBinderPageMode ? 'page' : 'card',
    safeAreaTop: insets.top,
    trayReservedHeight: footerReservedHeight,
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
  // Binder page groups, computed once per tray change (the render loop used to
  // findIndex/filter per row — O(n²) with a full binder tray). Headers are only
  // RENDERED while expanded (the collapsed tray shows a single row and must
  // keep the newest row on top), but the header count feeds the content height
  // in BOTH states so a toggle never changes the pinned scroll-content height —
  // that mid-animation height change re-laid-out every mounted row. Collapsed,
  // the surplus height is invisible: the viewport clips to one row.
  const binderPageGroups = useMemo(() => {
    const groups = new Map<string, { firstCaptureId: string; rowCount: number }>();
    recentCaptures.forEach((capture) => {
      const pageId = capture.binderPage?.pageId;
      if (!pageId) {
        return;
      }
      const group = groups.get(pageId);
      if (group) {
        group.rowCount += 1;
      } else {
        groups.set(pageId, { firstCaptureId: capture.id, rowCount: 1 });
      }
    });
    return groups;
  }, [recentCaptures]);
  const binderPageHeaderCount = binderPageGroups.size;
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight)
      + ((recentCaptures.length - 1) * captureRowGap)
      + (binderPageHeaderCount * (binderPageHeaderHeight + captureRowGap))
      + trayClearSectionHeight;
  const trayScrollViewportHeight = recentCaptures.length > 0
    ? Math.min(trayContentHeight, trayExpandedBodyHeight)
    : Math.max(140, trayExpandedBodyHeight);
  const trayScrollEnabled = trayContentHeight > trayScrollViewportHeight;
  const collapsedViewportHeight = captureRowHeight;
  // Binder page headers stay MOUNTED in both tray states (mounting them inside
  // the expand commit shoved every visible row down ~64px mid-animation — the
  // "awkward" binder expand). The collapsed tray instead anchors its scroll
  // just past the first header so the newest ROW fills the one-row viewport;
  // expanding is then a pure clip reveal with zero reflow.
  const collapsedAnchorOffset = recentCaptures[0]?.binderPage
    ? binderPageHeaderHeight + captureRowGap
    : 0;
  const shouldLoadInventory = recentCaptures.length > 0 || dataVersion > 0;

  // Which rows render full content (vs a fixed-height shell): everything
  // intersecting [windowTop − overscan, windowTop + expanded viewport +
  // overscan]. The span uses the EXPANDED viewport in both tray states so
  // toggling never mounts row content mid-animation — the collapsed tray
  // already has the whole first screenful rendered. Row offsets mirror the
  // trayContentHeight math exactly (row 102 + gap 24, header 40 + gap when a
  // binder page group starts while expanded).
  const trayRowContentVisibility = useMemo(() => {
    const windowTop = Math.max(0, trayRenderWindowTop - trayRenderOverscanPx);
    const windowBottom = trayRenderWindowTop + trayScrollViewportHeight + trayRenderOverscanPx;
    let nextRowTop = 0;
    return recentCaptures.map((capture) => {
      const pageId = capture.binderPage?.pageId;
      if (pageId && binderPageGroups.get(pageId)?.firstCaptureId === capture.id) {
        nextRowTop += binderPageHeaderHeight + captureRowGap;
      }
      const rowTop = nextRowTop;
      const rowBottom = rowTop + captureRowHeight;
      nextRowTop = rowBottom + captureRowGap;
      return rowBottom >= windowTop && rowTop <= windowBottom;
    });
  }, [
    binderPageGroups,
    recentCaptures,
    trayRenderWindowTop,
    trayScrollViewportHeight,
  ]);

  // --- Tray expand/collapse animation state (all UI-thread) ---
  // ONE shared value owns the viewport height for its whole life: the pan's
  // onUpdate writes it directly (finger-following), the pan's onEnd starts the
  // settle `withTiming` on it, and JS-driven target changes (header taps,
  // row-count changes) retarget it via the effect below. There is deliberately
  // NO `withTiming` inside the animated style: the old override/handoff design
  // re-started the settle from the current height with a fresh full duration
  // when the post-gesture React commit released the override — the last ~10% of
  // every swipe replayed in slow motion, right as the commit hitch landed.
  const trayHeight = useSharedValue(collapsedViewportHeight);
  // The last commanded settle target. Lets the retarget effect distinguish "the
  // gesture already started this exact settle on the UI thread — leave it
  // alone" from a genuinely new target that needs its own animation.
  const trayHeightTarget = useSharedValue(collapsedViewportHeight);
  const trayDragStartHeight = useSharedValue(collapsedViewportHeight);
  // Live scroll offset of the inner list, mirrored into a shared value ON THE
  // UI THREAD (useAnimatedScrollHandler below) so the pan worklets can gate
  // "collapse only from top-of-content" without reading a stale JS ref.
  const trayScrollOffset = useSharedValue(0);
  const trayDragStartScrollOffset = useSharedValue(0);
  // Last bucket the scroll handler reported to JS for the row window — kept on
  // the UI thread so scrolling inside one bucket costs zero JS work.
  const trayRenderWindowBucket = useSharedValue(0);

  // Jest's reanimated mock rebuilds shared values from their init on every
  // render, so imperative writes (the gesture, commitTrayExpandedState) never
  // reach the style under test. Tests therefore read the state-derived target
  // height; the runtime reads ONLY the shared value.
  const trayViewportTargetHeight = isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight;
  const trayViewportAnimatedStyle = useAnimatedStyle(
    () => ({ height: isTestEnv ? trayViewportTargetHeight : trayHeight.value }),
    [isTestEnv, trayHeight, trayViewportTargetHeight],
  );

  // Backdrop (blur + scrim) visibility, driven by the live tray height on the
  // UI thread with the views permanently mounted: creating the blur's native
  // view inside the expand commit was a measured mid-animation stall, and the
  // fade now tracks the drag instead of popping at release. `display: none`
  // keeps the hidden blur out of layout/compositing while collapsed. Tests use
  // the state-derived value (the jest reanimated mock resets shared values
  // every render — see trayViewportAnimatedStyle).
  const trayBackdropAnimatedStyle = useAnimatedStyle(() => {
    const expandedRange = trayScrollViewportHeight - collapsedViewportHeight;
    const dragProgress = expandedRange > 0
      ? Math.min(1, Math.max(0, (trayHeight.value - collapsedViewportHeight) / expandedRange))
      : 0;
    const progress = isTestEnv ? (isTrayExpanded ? 1 : 0) : dragProgress;
    return {
      display: progress <= 0.01 ? ('none' as const) : ('flex' as const),
      opacity: progress,
    };
  }, [collapsedViewportHeight, isTestEnv, isTrayExpanded, trayHeight, trayScrollViewportHeight]);

  // Retargets the height when the state-derived target changes WITHOUT a
  // toggle commit — rows added/removed while expanded resize the viewport.
  // Skipped when the gesture or commitTrayExpandedState already commanded this
  // exact target: restarting a mid-flight settle caused the slow-tail jank.
  useEffect(() => {
    const target = isTrayExpanded ? trayScrollViewportHeight : collapsedViewportHeight;
    if (trayHeightTarget.value === target) {
      return;
    }
    trayHeightTarget.value = target;
    trayHeight.value = withTiming(target, trayHeightTimingConfig);
  }, [collapsedViewportHeight, isTrayExpanded, trayHeight, trayHeightTarget, trayScrollViewportHeight]);

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
    // Command the settle BEFORE the state flip renders. Guarded so the settle
    // the gesture already started on the UI thread is never re-commanded —
    // restarting a mid-flight timing from the current height with a fresh full
    // duration is what made every swipe stall at ~90% and replay its tail.
    // Header taps (no gesture) reach here with a stale target and DO animate.
    const target = nextExpanded ? trayScrollViewportHeight : collapsedViewportHeight;
    if (trayHeightTarget.value !== target) {
      trayHeightTarget.value = target;
      trayHeight.value = withTiming(target, trayHeightTimingConfig);
    }
    if (!nextExpanded) {
      // Collapse anchors the list to the top (scrollTo below) — realign the
      // row-content window with it. The scroll handler would also report the
      // 0-bucket, but not before the collapsed frame renders.
      trayRenderWindowBucket.value = 0;
      setTrayRenderWindowTop(0);
    }
    setIsTrayExpanded((current) => {
      if (current === nextExpanded) {
        return current;
      }

      if (!nextExpanded) {
        // Anchor row 0 so the collapse reveals the top card (just past the
        // first binder page header, which stays mounted).
        trayScrollOffset.value = collapsedAnchorOffset;
        trayScrollRef.current?.scrollTo({ animated: false, y: collapsedAnchorOffset });
      }

      // The tray height itself springs via the Reanimated `trayHeight`
      // shared value (commanded above) — NOT a classic LayoutAnimation,
      // which would crash when run over the Reanimated tray rows.
      return nextExpanded;
    });
  }, [
    collapsedAnchorOffset,
    collapsedViewportHeight,
    trayHeight,
    trayHeightTarget,
    trayRenderWindowBucket,
    trayScrollOffset,
    trayScrollViewportHeight,
  ]);

  // Hold the collapsed anchor as scans land: a binder capture prepending a new
  // page (header + row) or a lane switch changes what sits at the top of the
  // scroll content while the collapsed viewport shows exactly one row.
  useEffect(() => {
    if (isTrayExpanded || recentCaptures.length === 0) {
      return;
    }
    trayScrollOffset.value = collapsedAnchorOffset;
    trayScrollRef.current?.scrollTo({ animated: false, y: collapsedAnchorOffset });
  }, [collapsedAnchorOffset, isTrayExpanded, recentCaptures.length, trayScrollOffset]);

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

  // Ref mirror for tap handlers (handleOpenCard): closing over the Map made the
  // callback's identity change on every inventory refresh, which re-rendered
  // every memoized tray row. Handlers run on tap, well after the sync effect.
  const inventoryByCardIdRef = useRef(inventoryByCardId);
  useEffect(() => {
    inventoryByCardIdRef.current = inventoryByCardId;
  }, [inventoryByCardId]);

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

  /**
   * Post-network SUCCESS handling shared by the single-scan path and the
   * binder-page batch: paint the tray row, warm thumbnails, haptic, queue the
   * persistence copy, and ship scan_match_succeeded. Exactly the block that
   * used to live inline in `runMatchForCapture`.
   */
  const applyMatchSuccessForCapture = useCallback(({
    captureId,
    captureMs,
    matchResult,
    matchTarget,
    mode,
    normalizeMs,
    scanStartedAt,
    slabAnalysisMs,
    sourceImageDimensions,
  }: Pick<CaptureMatchParams, 'captureId' | 'captureMs' | 'matchTarget' | 'mode' | 'normalizeMs' | 'scanStartedAt' | 'slabAnalysisMs' | 'sourceImageDimensions'> & {
    matchResult: ScannerMatchResult;
  }) => {
    const endToEndMs = Date.now() - scanStartedAt;
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
        matchConfidence: matchResult.confidence ?? null,
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
  }, [updateRecentCapture]);

  /**
   * Post-network FAILURE handling shared by both paths: diagnostic log, tray
   * row reset, error haptic, and scan_match_failed.
   */
  const applyMatchFailureForCapture = useCallback(({
    captureId,
    captureMs,
    captureSource,
    error,
    game,
    matchTarget,
    mode,
    normalizeMs,
    scanStartedAt,
    slabAnalysisMs,
    sourceImageDimensions,
  }: Pick<CaptureMatchParams, 'captureId' | 'captureMs' | 'captureSource' | 'matchTarget' | 'mode' | 'normalizeMs' | 'scanStartedAt' | 'slabAnalysisMs' | 'sourceImageDimensions'> & {
    error: unknown;
    game?: ScannerCapturePayload['game'];
  }) => {
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
      // Names the lane when the failure is "this game has no visual index
      // yet"; null (the generic retry copy) for every other failure, and
      // always null for Pokémon.
      matchReviewReason: scannerLaneUnavailableReason(game ?? undefined, error),
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
        const ocrAwaitStartedAt = Date.now();
        // Cap the blocking wait: a slow read must not delay the match request.
        const raced = await Promise.race([
          rawCollectorNumberPromise,
          new Promise<'__ocr_timeout__'>((resolve) => setTimeout(() => resolve('__ocr_timeout__'), 500)),
        ]);
        const rawCollectorNumber = raced === '__ocr_timeout__' ? null : raced;
        // Diagnostic (2026-08-31): every staging scan reached the backend with
        // collectorNumber=null and the read event never fired, so this now
        // reports EVERY outcome with the blocking-await cost, not just wins.
        capturePostHogEvent('scan_raw_collector_number_attempted', {
          mode,
          outcome: raced === '__ocr_timeout__' ? 'timeout' : (rawCollectorNumber ? 'read' : 'null'),
          ocr_await_ms: Date.now() - ocrAwaitStartedAt,
        });
        if (rawCollectorNumber) {
          resolvedMatchPayload = {
            ...matchPayload,
            ocrAnalysis: {
              rawEvidence: { collectorNumberExact: rawCollectorNumber },
            },
          };
          capturePostHogEvent('scan_raw_collector_number_read', { mode });
        }
      } else if (mode === 'raw') {
        // Distinguishes "flag never reached this bundle" from "read returned
        // null": not_started means the promise was never created.
        capturePostHogEvent('scan_raw_collector_number_attempted', {
          mode,
          outcome: 'not_started',
        });
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

      applyMatchSuccessForCapture({
        captureId,
        captureMs,
        matchResult,
        matchTarget,
        mode,
        normalizeMs,
        scanStartedAt,
        slabAnalysisMs,
        sourceImageDimensions,
      });
      return null;
    } catch (error) {
      applyMatchFailureForCapture({
        captureId,
        captureMs,
        captureSource,
        error,
        game: matchPayload.game,
        matchTarget,
        mode,
        normalizeMs,
        scanStartedAt,
        slabAnalysisMs,
        sourceImageDimensions,
      });
      // Surface the failure to lane-level callers (the binder streamed loop
      // keys on BinderPageTokenUnknown); the row itself is already handled.
      return error;
    }
  }, [applyMatchFailureForCapture, applyMatchSuccessForCapture, spotlightRepository]);

  /**
   * Binder-page: one captured photo → the page image uploads ONCE
   * (`prepareBinderPage`) → nine ORDINARY single visual-match calls that
   * reference the stored pockets by token, run one-at-a-time so each pocket's
   * tray row fills in as its response lands (results STREAM instead of all
   * nine waiting out one batched forward). Older backends without the prepare
   * endpoint fall back to the batched request (`matchScannerCaptureBatch`),
   * which itself falls back to the original per-pocket upload loop. Row 0
   * reuses the shutter placeholder; rows 1-8 are appended here. Only pocket 0
   * carries the page source image so the page photo's training artifact
   * uploads once, not nine times.
   */
  // Serializes page batches: the server treats a page as ONE inference-slot
  // customer, so a second page fired mid-flight would be shed with a 503.
  // Chaining here lets the user tap the next page immediately — its rows show
  // in the tray and its batch runs as soon as the previous page's finishes.
  const binderBatchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueBinderBatch = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const result = binderBatchQueueRef.current.then(task, task);
    binderBatchQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const runBinderPageCapture = useCallback(async ({
    captureId,
    captureMs,
    guestSessionPromise,
    photoUri,
    previewLayout,
    rawSourceImageDimensions,
    reticleLayout,
    scanStartedAt,
    sourceImageDimensions,
  }: {
    captureId: string;
    captureMs: number;
    // The guest mint from handleCapture: resolves to a session (truthy) or
    // null. Same truthiness contract the single-card path uses.
    guestSessionPromise: Promise<unknown> | null;
    photoUri: string;
    previewLayout: { height: number; width: number };
    rawSourceImageDimensions: ScanSourceImageDimensions;
    reticleLayout: { height: number; width: number; x: number; y: number };
    scanStartedAt: number;
    sourceImageDimensions: ScanSourceImageDimensions;
  }) => {
    const pocketCount = binderPageGridSize * binderPageGridSize;
    const pocketRowId = (index: number) => binderPocketRowId(captureId, index);

    // Pocket 0 IS the shutter placeholder; pockets 1-8 go directly beneath it
    // so the tray reads in page order (top-left first).
    setRecentCaptures((current) => applyCapEviction(
      insertBinderPocketRows(current, captureId, pocketCount),
      'raw',
    ));

    const failAllPockets = () => {
      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId && !capture.id.startsWith(`${captureId}-p`)) {
          return capture;
        }
        return {
          ...capture,
          isLoadingCandidates: false,
          matchReviewDisposition: null,
          matchReviewReason: null,
          // Keep failed pocket rows image-less rather than falling back to the
          // full-res page photo (nine 4K decodes).
        };
      }));
      void triggerScannerProcessedHaptic();
    };

    const normalizeStartedAt = Date.now();
    // The page image is all the BATCH needs (the server crops the pockets).
    // The nine pocket crop renders — several seconds of on-device 4K work —
    // only feed thumbnails and training artifacts, so they run while the
    // request is already uploading instead of in front of it (measured ~12s
    // from tap to server-arrival with them on the critical path).
    let resolvePageImage: (image: BinderPageImage | null) => void = () => {};
    const pageImagePromise = new Promise<BinderPageImage | null>((resolve) => {
      resolvePageImage = resolve;
    });
    const binderTargetsPromise = buildBinderPocketTargets({
      onPageImageReady: (image) => resolvePageImage(image),
      previewLayout,
      reticle: reticleLayout,
      sourceImageDimensions,
      sourceImageUri: photoUri,
    }).then((result) => {
      // No-op when onPageImageReady already fired; resolves null on failure.
      resolvePageImage(result?.pageImage ?? null);
      if (result && result.targets.length === pocketCount) {
        result.targets.forEach((target, index) => {
          updateRecentCapture(pocketRowId(index), (capture) => ({
            ...capture,
            normalizedImageDimensions: target.normalizedImageDimensions,
            normalizedImageUri: target.normalizedImageUri,
            sourceImageCrop: target.sourceImageCrop,
            sourceImageDimensions,
            sourceImageRotationDegrees: target.normalizationRotationDegrees,
            uri: target.normalizedImageUri,
          }));
        });
        logScannerDiagnostic(`[SCANNER PAGE] cropsMs=${Date.now() - normalizeStartedAt}`);
        return result;
      }
      return null;
    }).catch(() => null);

    const pageImage = await pageImagePromise;
    const normalizeMs = Date.now() - normalizeStartedAt;
    if (!pageImage) {
      await binderTargetsPromise;
      failAllPockets();
      return;
    }
    logScannerDiagnostic(`[SCANNER PAGE] pageReadyMs=${normalizeMs} captureMs=${captureMs}`);

    if (guestSessionPromise && !(await guestSessionPromise)) {
      failAllPockets();
      return;
    }

    capturePostHogEvent('binder_page_scan_started', {
      mode: 'raw',
      pocket_count: pocketCount,
      normalize_ms: normalizeMs,
    });

    const readScanImageAsBase64 = async (fileUri: string) => {
      try {
        const base64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64' });
        return base64 || null;
      } catch {
        return null;
      }
    };

    // Batch payloads carry no pocket files — the server crops the page image.
    const buildPocketPayload = (index: number): ScannerCapturePayload => ({
      height: rawCardNormalizedTargetHeight,
      mode: 'raw',
      game: scanLane.game,
      cardLanguage: scanCardLanguageForLane(scanLane),
      width: rawCardNormalizedTargetWidth,
      captureSource: 'camera',
      cameraZoomFactor: zoomFactor,
      ...(index === 0
        ? {
          sourceImage: {
            fileUri: photoUri,
            width: rawSourceImageDimensions.width,
            height: rawSourceImageDimensions.height,
          },
        }
        : {}),
      submittedAt: new Date(scanStartedAt).toISOString(),
      readFileAsBase64: readScanImageAsBase64,
    });

    // Full per-pocket payloads (with the crop files) for training-artifact
    // uploads and the older-backend fallback.
    const buildTargetPayload = (
      target: NormalizedScannerTarget,
      index: number,
    ): ScannerCapturePayload => ({
      ...buildPocketPayload(index),
      fileUri: target.normalizedImageUri,
      height: target.normalizedImageDimensions.height,
      width: target.normalizedImageDimensions.width,
      normalizedImage: {
        fileUri: target.normalizedImageUri,
        width: target.normalizedImageDimensions.width,
        height: target.normalizedImageDimensions.height,
      },
    });

    // Original per-pocket upload loop, kept as the last-resort fallback (older
    // backends, or a page token lost mid-stream — `startIndex` resumes from
    // the pocket that hit it): 3 in flight to match the server's inference
    // slots.
    const runPerPocketFallback = async (startIndex = 0) => {
      const binderTargets = await binderTargetsPromise;
      if (!binderTargets) {
        failAllPockets();
        return;
      }
      let nextPocketIndex = startIndex;
      const runNextPocket = async (): Promise<void> => {
        const index = nextPocketIndex++;
        if (index >= pocketCount) {
          return;
        }
        await runMatchForCapture({
          captureId: pocketRowId(index),
          captureMs,
          captureSource: 'camera',
          matchPayload: buildTargetPayload(binderTargets.targets[index], index),
          matchTarget: binderTargets.targets[index],
          mode: 'raw',
          normalizeMs,
          rawSourceImageDimensions,
          scanStartedAt,
          slabAnalysisMs: null,
          sourceImageDimensions,
          rawCollectorNumberPromise: null,
        });
        return runNextPocket();
      };
      const inFlight = Math.min(3, Math.max(1, pocketCount - startIndex));
      await Promise.all(Array.from({ length: inFlight }, () => runNextPocket()));
    };

    const pocketPayloads = Array.from({ length: pocketCount }, (_, index) => buildPocketPayload(index));

    // binder_page_scan_completed ships from every lane with the same shape;
    // `lane` says which transport actually served the page, and batch_ms spans
    // first pocket request → last pocket settled.
    const emitPageScanCompleted = (
      lane: 'streamed' | 'batch' | 'pocket_fallback',
      batchMs: number,
    ) => {
      // Stage telemetry from ANY build (TestFlight included): where a page
      // scan's wall-clock actually goes, queryable in PostHog.
      void (async () => {
        let pageFileKB: number | null = null;
        try {
          const info = await FileSystem.getInfoAsync(pageImage.uri);
          const size = info.exists ? (info as { size?: number }).size : null;
          pageFileKB = typeof size === 'number' ? Math.round(size / 1024) : null;
        } catch {
          // size is diagnostic-only
        }
        capturePostHogEvent('binder_page_scan_completed', {
          batch_ms: batchMs,
          capture_ms: captureMs,
          lane,
          mode: 'raw',
          page_file_kb: pageFileKB,
          page_ready_ms: normalizeMs,
          pocket_count: pocketCount,
          total_ms: Date.now() - scanStartedAt,
        });
      })();
    };

    // Batched lane, kept for backends without /scan/binder-page/prepare: ONE
    // request holds a single inference slot and all nine results land together
    // after the batched encoder forward.
    const runBatchFallback = async () => {
      const batchStartedAt = Date.now();
      try {
        const batch = await enqueueBinderBatch(() => spotlightRepository.matchScannerCaptureBatch(pocketPayloads, {
          // One page upload instead of nine pocket uploads (~a third of the
          // bytes); the server does the thirds crop.
          pageImage: {
            fileUri: pageImage.uri,
            width: pageImage.width,
            height: pageImage.height,
          },
          // Training artifacts wait for the crops (which render during upload).
          artifactItems: binderTargetsPromise.then((result) => (
            result ? result.targets.map((target, index) => buildTargetPayload(target, index)) : null
          )),
          onArtifactUploadComplete: (pocketIndex, artifactUpload) => {
            if (artifactUpload?.status === 'failed') {
              capturePostHogEvent('scan_artifact_upload_failed', {
                error_kind: artifactUpload.errorKind ?? 'request_failed',
                mode: 'raw',
                pocket_index: pocketIndex,
                ...(typeof artifactUpload.roundTripMs === 'number'
                  ? { upload_ms: artifactUpload.roundTripMs }
                  : {}),
              });
            }
          },
        }));
        const batchMs = Date.now() - batchStartedAt;
        logScannerDiagnostic(`[SCANNER PAGE] batchMs=${batchMs} totalMs=${Date.now() - scanStartedAt}`);
        emitPageScanCompleted('batch', batchMs);
        // The crops nearly always finish before the batch does; awaiting keeps
        // matchTarget correct on the slow path too.
        const binderTargets = await binderTargetsPromise;
        if (!binderTargets) {
          failAllPockets();
          return;
        }
        const resultByPocket = new Map(batch.results.map((item) => [item.pocketIndex, item]));
        for (let index = 0; index < pocketCount; index += 1) {
          const item = resultByPocket.get(index);
          const shared = {
            captureId: pocketRowId(index),
            captureMs,
            matchTarget: binderTargets.targets[index],
            mode: 'raw' as const,
            normalizeMs,
            scanStartedAt,
            slabAnalysisMs: null,
            sourceImageDimensions,
          };
          if (item?.result) {
            applyMatchSuccessForCapture({ ...shared, matchResult: item.result });
          } else {
            applyMatchFailureForCapture({
              ...shared,
              captureSource: 'camera',
              error: new Error(item?.errorMessage ?? 'Pocket match missing from batch response.'),
              game: scanLane.game,
            });
          }
        }
      } catch (error) {
        // Older backend without visual-match-batch (404 unknown path, 405, or a
        // pre-batch 400): scan the page through the original per-pocket loop.
        const status = isSpotlightRepositoryRequestError(error) ? error.status : null;
        if (status === 400 || status === 404 || status === 405) {
          await runPerPocketFallback();
          emitPageScanCompleted('pocket_fallback', Date.now() - batchStartedAt);
          return;
        }
        const binderTargets = await binderTargetsPromise;
        if (!binderTargets) {
          failAllPockets();
          return;
        }
        for (let index = 0; index < pocketCount; index += 1) {
          applyMatchFailureForCapture({
            captureId: pocketRowId(index),
            captureMs,
            captureSource: 'camera',
            error,
            game: scanLane.game,
            matchTarget: binderTargets.targets[index],
            mode: 'raw',
            normalizeMs,
            scanStartedAt,
            slabAnalysisMs: null,
            sourceImageDimensions,
          });
        }
      }
    };

    // Streamed lane (default): upload the page ONCE via prepare, then nine
    // ORDINARY single visual-match calls that reference the stored pockets —
    // each pocket's tray row fills in as its response lands (~2s cadence,
    // first ~3s after tap) instead of all nine waiting out one ~15s batched
    // forward (batching saves no FLOPs on the staging CPU). The prepare
    // upload (~1s) and the on-device pocket crops (~0.5s on release builds)
    // overlap here; the crops gate the first match only because each pocket's
    // payload carries its crop file for thumbnails and the deferred
    // training-artifact upload — never for the match request itself.
    const [prepareOutcome, readyTargets] = await Promise.all([
      spotlightRepository
        .prepareBinderPage(
          { fileUri: pageImage.uri, width: pageImage.width, height: pageImage.height },
          { readFileAsBase64: readScanImageAsBase64 },
        )
        .then((prepared) => ({ ok: true as const, prepared }))
        .catch((error: unknown) => ({ ok: false as const, error })),
      binderTargetsPromise,
    ]);
    if (!prepareOutcome.ok) {
      // Older backend without the prepare endpoint: the proven batched lane
      // (which carries its own per-pocket fallback).
      const status = isSpotlightRepositoryRequestError(prepareOutcome.error)
        ? prepareOutcome.error.status
        : null;
      if (status === 404 || status === 405) {
        await runBatchFallback();
        return;
      }
      // Any other prepare failure (timeout / 5xx / rejected page): fail the
      // rows retry-ably, like a whole-batch failure — re-uploading nine crops
      // against a backend that just failed the one-page upload helps nobody.
      if (!readyTargets) {
        failAllPockets();
        return;
      }
      for (let index = 0; index < pocketCount; index += 1) {
        applyMatchFailureForCapture({
          captureId: pocketRowId(index),
          captureMs,
          captureSource: 'camera',
          error: prepareOutcome.error,
          game: scanLane.game,
          matchTarget: readyTargets.targets[index],
          mode: 'raw',
          normalizeMs,
          scanStartedAt,
          slabAnalysisMs: null,
          sourceImageDimensions,
        });
      }
      return;
    }
    if (!readyTargets) {
      failAllPockets();
      return;
    }

    const { pageToken } = prepareOutcome.prepared;
    // A 400 naming BinderPageTokenUnknown means the stored page is gone
    // (expired token / restarted server). The raw HTTP error body rides
    // verbatim in error.message, so key on the errorType string.
    const isPageTokenUnknownError = (error: unknown) =>
      isSpotlightRepositoryRequestError(error)
      && error.status === 400
      && error.message.includes('BinderPageTokenUnknown');

    // Pockets run SEQUENTIALLY (one in flight): the server encodes one pocket
    // at a time anyway, and one-at-a-time preserves first-result latency.
    // Holding the binder queue for the whole run keeps two pages from
    // interleaving their encoder work.
    let streamStartedAt = Date.now();
    let tokenLostAtIndex: number | null = null;
    await enqueueBinderBatch(async () => {
      streamStartedAt = Date.now();
      for (let index = 0; index < pocketCount; index += 1) {
        const matchError = await runMatchForCapture({
          captureId: pocketRowId(index),
          captureMs,
          captureSource: 'camera',
          matchPayload: {
            ...buildTargetPayload(readyTargets.targets[index], index),
            binderPage: { pageToken, pocketIndex: index },
          },
          matchTarget: readyTargets.targets[index],
          mode: 'raw',
          normalizeMs,
          rawSourceImageDimensions,
          scanStartedAt,
          slabAnalysisMs: null,
          sourceImageDimensions,
          rawCollectorNumberPromise: null,
        });
        if (isPageTokenUnknownError(matchError)) {
          tokenLostAtIndex = index;
          return;
        }
      }
    });
    if (tokenLostAtIndex !== null) {
      // The failed pocket's row already shows the failure; the per-pocket
      // fallback re-runs it (and every later pocket) with its own crop upload.
      await runPerPocketFallback(tokenLostAtIndex);
      emitPageScanCompleted('pocket_fallback', Date.now() - streamStartedAt);
      return;
    }
    logScannerDiagnostic(`[SCANNER PAGE] streamMs=${Date.now() - streamStartedAt} totalMs=${Date.now() - scanStartedAt}`);
    emitPageScanCompleted('streamed', Date.now() - streamStartedAt);
  }, [
    applyMatchFailureForCapture,
    applyMatchSuccessForCapture,
    enqueueBinderBatch,
    runMatchForCapture,
    scanLane,
    spotlightRepository,
    updateRecentCapture,
    zoomFactor,
  ]);

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

      if (isBinderPageMode) {
        // Nine pockets, one tap. Everything past this point in the single-card
        // path (single normalize, OCR, single match) is replaced by the binder
        // fan-out; its per-row failure handling lives inside the helper.
        await runBinderPageCapture({
          captureId,
          captureMs,
          guestSessionPromise,
          photoUri: photo.uri,
          previewLayout,
          rawSourceImageDimensions,
          reticleLayout,
          scanStartedAt,
          sourceImageDimensions,
        });
        return;
      }

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
      let rawCollectorNumberPromise: Promise<string | null> | null = null;
      if (!isSlab && rawCollectorNumberOcrEnabled && !rawCollectorNumberReadInFlight) {
        rawCollectorNumberReadInFlight = true;
        rawCollectorNumberPromise = readRawCollectorNumber(normalizedTarget.normalizedImageUri);
        void rawCollectorNumberPromise.finally(() => {
          rawCollectorNumberReadInFlight = false;
        });
      }

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
        // The active lane, split into the two things the backend uses it for:
        // `game` selects the per-game visual index, `cardLanguage` is the
        // preferred-language hint (null for single-language catalogs).
        game: scanLane.game,
        cardLanguage: scanCardLanguageForLane(scanLane),
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
    ensureGuestSession,
    hasPermission,
    isBinderPageMode,
    isCameraReady,
    isCapturing,
    isGuest,
    requestPermission,
    runBinderPageCapture,
    runMatchForCapture,
    scanLane,
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
          // The smoke fixture runs the REAL match flow, so it must carry the
          // active game too — otherwise it would silently smoke-test Pokémon
          // while the user sits in another game's lane. It deliberately still
          // sends no `cardLanguage` (as it always has), so the fixture keeps
          // being matched without a language filter.
          game: scanLane.game,
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
  }, [isCapturing, scanLane, scannerSmokeEnabled, runMatchForCapture, updateRecentCapture]);

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

  const openBinderPageReview = useCallback((pageId: string) => {
    setActiveBinderPageId(pageId);
  }, []);

  const closeBinderPageReview = useCallback(() => {
    setActiveBinderPageId(null);
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
  }, [activeCollectionID, prependOptimisticInventoryEntry, priceSelection, recentCaptures, refreshData, removeCaptureAfterAdd, spotlightRepository, trackCandidateSelectionIfNeeded]);

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
    activeCollectionID,
    performClearAllCaptures,
    priceSelection,
    recentCaptures,
    refreshData,
    spotlightRepository,
    prependOptimisticInventoryEntry,
    trackCandidateSelectionIfNeeded,
  ]);

  // Page overlay "Add N to collection": the tray's bulk add scoped to one
  // binder page. Rows leave the tray as they land, like a row ADD, so the
  // rest of the session (other pages, single scans) stays put.
  const handleAddBinderPage = useCallback((pageId: string) => {
    const targets = binderPageRows(recentCaptures, pageId).filter(
      (capture) => !capture.isLoadingCandidates && !capture.recentlyAdded && !!activeCandidateForCapture(capture),
    );
    if (targets.length === 0 || isAddingBinderPage) {
      return;
    }
    setIsAddingBinderPage(true);
    void (async () => {
      const addedAt = new Date().toISOString();
      const rows = targets.flatMap((capture) => {
        const candidate = activeCandidateForCapture(capture);
        return candidate ? [{ capture, candidate }] : [];
      });
      const attempted = rows.length;
      let succeeded = 0;

      const applyCreated = (
        capture: RecentCapture,
        candidate: CatalogSearchResult,
        deckEntryID: string,
        createdAddedAt: string,
      ) => {
        prependOptimisticInventoryEntry(
          buildOptimisticInventoryEntry(
            candidate,
            createdAddedAt || addedAt,
            { mode: capture.mode, slabContext: capture.slabContext },
            deckEntryID,
          ),
        );
        removeCaptureAfterAdd(capture.id);
        succeeded += 1;
      };
      const entryArgs = (capture: RecentCapture, candidate: CatalogSearchResult) => {
        const condition: DeckConditionCode = priceSelection.get(capture.id)?.conditionCode ?? 'near_mint';
        return buildInventoryEntryArgs(capture, candidate, addedAt, condition, activeCollectionID);
      };
      // Older-backend fallback: the original per-entry creates, 3 in flight.
      const runPerEntryFallback = async () => {
        let nextIndex = 0;
        const drain = async (): Promise<void> => {
          const index = nextIndex++;
          if (index >= rows.length) {
            return;
          }
          const { capture, candidate } = rows[index];
          try {
            const createResponse = await spotlightRepository.createInventoryEntry(entryArgs(capture, candidate));
            applyCreated(capture, candidate, createResponse.deckEntryID, createResponse.addedAt || addedAt);
          } catch (error) {
            logScannerDiagnostic(`[SCANNER] binder page add failed: ${scannerErrorMessage(error)}`, error);
          }
          return drain();
        };
        await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => drain()));
      };

      rows.forEach(({ capture }) => trackCandidateSelectionIfNeeded(capture));
      try {
        // Nine ~1.5s creates were 13s on the wire; create-bulk lands the whole
        // page in ONE request/transaction with per-entry results.
        const response = await spotlightRepository.createInventoryEntriesBulk(
          rows.map(({ capture, candidate }) => entryArgs(capture, candidate)),
        );
        for (const result of response.results) {
          const row = rows[result.index];
          if (!row) {
            continue;
          }
          if (result.error || !result.deckEntryID) {
            logScannerDiagnostic(`[SCANNER] binder page bulk add entry failed: ${result.error ?? 'missing deckEntryID'}`);
            continue;
          }
          applyCreated(row.capture, row.candidate, result.deckEntryID, result.addedAt ?? addedAt);
        }
      } catch (error) {
        const status = isSpotlightRepositoryRequestError(error) ? error.status : null;
        if (status === 400 || status === 404 || status === 405) {
          // Older backend without create-bulk.
          await runPerEntryFallback();
        } else {
          logScannerDiagnostic(`[SCANNER] binder page bulk add failed: ${scannerErrorMessage(error)}`, error);
        }
      }
      capturePostHogEvent('binder_page_add_all', {
        attempted,
        succeeded,
        failed: attempted - succeeded,
      });
      setIsAddingBinderPage(false);
      setActiveBinderPageId(null);
      refreshData();
    })();
  }, [
    activeCollectionID,
    isAddingBinderPage,
    priceSelection,
    recentCaptures,
    refreshData,
    removeCaptureAfterAdd,
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

  // Reads the tray and inventory through refs (synced by effects above) so this
  // callback stays render-stable: it is a prop on every memoized tray row, and
  // depending on `recentCaptures` directly re-rendered the whole tray on every
  // scan progress tick.
  const handleOpenCard = useCallback(async (captureId: string) => {
    const capture = recentCapturesRef.current.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !candidate || capture.isLoadingCandidates) {
      return;
    }

    const matchingInventoryEntries = inventoryByCardIdRef.current.get(candidate.cardId)?.entryIds ?? [];
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
  }, [router, spotlightRepository, trackCandidateSelectionIfNeeded]);

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
      Unreachable in practice — `(tabs)/scan.tsx` always passes
      `onExitToPortfolio`. Not re-pointed at `/you`: `dismissTo` dispatches POP_TO,
      which `NativeBottomTabsRouter` cannot handle for a tab (see `app-drawer.tsx`).
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
      // Advance the row-content window only when the scroll crosses a bucket
      // edge — one JS render per ~4 rows scrolled, not one per scroll event.
      const bucket = Math.round(event.contentOffset.y / trayRenderWindowBucketPx);
      if (bucket !== trayRenderWindowBucket.value) {
        trayRenderWindowBucket.value = bucket;
        runOnJS(setTrayRenderWindowTop)(bucket * trayRenderWindowBucketPx);
      }
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
          // Writing trayHeight directly during the drag cancels any in-flight
          // settle animation, so a grab mid-animation just takes over.
          trayDragStartHeight.value = trayHeight.value;
        })
        .onUpdate((event) => {
          // Track the finger: expanding is always allowed from collapsed;
          // while expanded, the drag only collapses from top-of-content
          // (mid-list drags belong to the ScrollView). "Top" includes the
          // collapsed anchor sitting just past the first binder page header.
          const mayFollow = isTrayExpanded
            ? trayDragStartScrollOffset.value <= collapsedAnchorOffset
            : true;
          if (!mayFollow) {
            return;
          }
          trayHeight.value = Math.min(
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
            && trayDragStartScrollOffset.value <= collapsedAnchorOffset
            && (event.translationY >= traySwipeThreshold || event.velocityY >= trayFlingVelocity);
          const nextExpanded = shouldExpand ? true : shouldCollapse ? false : isTrayExpanded;

          // Settle toward the target NOW, on the UI thread, and record the
          // commanded target so the retarget effect (running after the JS state
          // flip re-renders) recognizes this settle and does NOT restart it.
          const settleTarget = nextExpanded ? trayScrollViewportHeight : collapsedViewportHeight;
          trayHeightTarget.value = settleTarget;
          trayHeight.value = withTiming(settleTarget, trayHeightTimingConfig);
          if (nextExpanded !== isTrayExpanded) {
            runOnJS(commitTrayExpandedState)(nextExpanded);
          }
        }),
    [
      canToggleTray,
      collapsedAnchorOffset,
      collapsedViewportHeight,
      commitTrayExpandedState,
      isGuest,
      isTopLevelSwipeEnabled,
      isTrayExpanded,
      trayDragStartHeight,
      trayDragStartScrollOffset,
      trayHeight,
      trayHeightTarget,
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

  // `gate()` returns a FRESH closure per call, so calling it inline in the row
  // props handed every CaptureTrayRow four new functions on every render and
  // silently defeated the row memo — the whole tray (100+ Swipeables) was
  // reconciled on every screen state tick. Wrap each handler exactly once.
  const gatedRowAddToCollection = useMemo(() => gate(handleRowAddToCollection), [gate, handleRowAddToCollection]);
  const gatedRowDelete = useMemo(() => gate(deleteRecentCapture), [deleteRecentCapture, gate]);
  const gatedOpenChangeCardPicker = useMemo(() => gate(openChangeCardPicker), [gate, openChangeCardPicker]);
  const gatedShowRowPrice = useMemo(() => gate(handleShowRowPrice), [gate, handleShowRowPrice]);

  // Collapsed tray: a newly mounted row "advances" in with the slide-from-right
  // enter; expanded: new rows appear in place. Mirrored through a stable ref
  // (updated during render, read by rows when they mount) instead of a boolean
  // prop — the boolean flipped on every toggle and re-rendered all rows at the
  // exact moment the expand/collapse animation started.
  const enterAnimationEnabledRef = useRef(!isTrayExpanded);
  enterAnimationEnabledRef.current = !isTrayExpanded;

  const renderCaptureRow = (capture: RecentCapture, index: number) => (
    <CaptureTrayRow
      key={capture.id}
      capture={capture}
      enterAnimationEnabledRef={enterAnimationEnabledRef}
      index={index}
      onActionRailVisibilityChange={handleCaptureActionRailVisibilityChange}
      onAddToCollection={gatedRowAddToCollection}
      onDelete={gatedRowDelete}
      onOpenCard={handleOpenCard}
      onOpenChangeCardPicker={gatedOpenChangeCardPicker}
      onOpenRowMenu={handleOpenRowMenu}
      onShowPrice={gatedShowRowPrice}
      renderContent={trayRowContentVisibility[index] !== false}
      selection={priceSelection.get(capture.id) ?? null}
    />
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
      {isActiveTab ? <ScannerKeepAwake /> : null}
      <RawScannerCaptureSurface
        cameraRef={cameraRef}
        canCapture={canCapture}
        captureResolution={isBinderPageMode ? 'page' : 'card'}
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
        suspendPreview={activeBinderPageId != null}
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
          Binder-page mode: a faint 3×3 grid over the reticle. Pure alignment
          guide — the reticle IS the page detector, so helping the user seat
          each pocket in a cell is what makes thirds-splitting work.
        */}
        {isBinderPageMode && !isTrayExpanded ? (
          <View pointerEvents="none" testID="scanner-binder-grid">
            {[1, 2].map((third) => (
              <View
                key={`binder-grid-v${third}`}
                style={[styles.binderGridLine, {
                  height: captureSurfaceLayout.captureCropRect.height,
                  left: captureSurfaceLayout.captureCropRect.x
                    + (captureSurfaceLayout.captureCropRect.width / binderPageGridSize) * third,
                  top: captureSurfaceLayout.captureCropRect.y,
                  width: 2,
                }]}
              />
            ))}
            {[1, 2].map((third) => (
              <View
                key={`binder-grid-h${third}`}
                style={[styles.binderGridLine, {
                  height: 2,
                  left: captureSurfaceLayout.captureCropRect.x,
                  top: captureSurfaceLayout.captureCropRect.y
                    + (captureSurfaceLayout.captureCropRect.height / binderPageGridSize) * third,
                  width: captureSurfaceLayout.captureCropRect.width,
                }]}
              />
            ))}
          </View>
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
            size="medium"
            surface="onLight"
            testID="scanner-back-button"
          >
            <IconChevronLeft color={colors.gray900} size={20} strokeWidth={2.2} />
          </GlassNavBubble>
          <View style={styles.topChromeCenter}>
            <ScanTargetPill
              flag={scanTargetFlag(scanLane)}
              label={scanTargetPillLabel(scanLane)}
              onPress={gate(() => {
                // Tapping the pill is also a tooltip dismissal — they learn the
                // control by using it.
                dismissLanguageTooltip();
                setIsScanTargetSheetOpen(true);
              })}
              testID="scanner-target-pill"
            />
          </View>
          <GlassNavBubble
            accessibilityLabel="Search the card catalog"
            onPress={gate(handleOpenCatalogSearch)}
            size="medium"
            surface="onLight"
            testID="scanner-search-button"
          >
            <IconSearch color={colors.gray900} size={20} strokeWidth={2.2} />
          </GlassNavBubble>
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
            {/*
              Single ↔ 3×3 (binder page) segmented selection, drawn with the
              same material recipe as the zoom dock beside it: a dark clear
              glass dock (scrim fallback off iOS 26), with the SELECTED segment
              on a light glass chip and the other a bare label — see
              `ScanTargetPill` for why the scheme is pinned rather than `auto`.
            */}
            {__DEV__ || runtimeAppEnv === 'staging' ? (
              <GlassSurface
                fallbackColor="rgba(0, 0, 0, 0.35)"
                glassColorScheme="dark"
                glassEffectStyle="clear"
                style={styles.binderModeDock}
                testID="scanner-binder-mode-toggle"
              >
                {([false, true] as const).map((pageMode) => {
                  const selected = isBinderPageMode === pageMode;
                  const label = pageMode ? '3×3' : 'Single';
                  const segmentTestID = pageMode ? 'scanner-binder-mode-page' : 'scanner-binder-mode-single';
                  return (
                    <Pressable
                      accessibilityLabel={pageMode ? 'Scan binder pages, nine cards at a time' : 'Scan single cards'}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      hitSlop={6}
                      key={label}
                      onPress={gate(() => setIsBinderPageMode(pageMode))}
                      style={styles.binderModeSegment}
                      testID={segmentTestID}
                    >
                      {selected ? (
                        <GlassSurface
                          fallbackColor={colors.gray0}
                          glassColorScheme="light"
                          glassEffectStyle="regular"
                          style={styles.binderModeSegmentSurface}
                          testID={`${segmentTestID}-surface`}
                        >
                          <Text style={[styles.binderModeSegmentLabel, styles.binderModeSegmentLabelSelected]}>
                            {label}
                          </Text>
                        </GlassSurface>
                      ) : (
                        <Text style={styles.binderModeSegmentLabel}>{label}</Text>
                      )}
                    </Pressable>
                  );
                })}
              </GlassSurface>
            ) : null}
            {/* Zoom is meaningless for a whole page; hiding it also frees the band for the reticle. */}
            {isBinderPageMode ? null : (
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
                        fallbackColor={colors.gray0}
                        glassColorScheme="light"
                        glassEffectStyle="regular"
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
            )}
          </View>
        )}

        {isTrayExpanded ? null : (
          <View
            pointerEvents="box-none"
            style={[
              styles.languageTooltipWrap,
              // Directly below the top-bar scan-target pill, tail pointing up.
              { top: captureSurfaceLayout.backButtonTop + 44 + 8 },
            ]}
          >
            <ScannerLanguageTooltip
              onPress={dismissLanguageTooltip}
              tailPosition="top"
              visible={showLanguageTooltip && !isScanTargetSheetOpen}
            />
          </View>
        )}

        {/*
          Bottom gradient behind the collapsed footer chrome (Figma 4062:21146:
          350pt, black at the screen edge fading out by the top). The expanded
          tray swaps it for the flat 40% scrim below (Figma 4046:20417).
        */}
        {isTrayExpanded ? null : (
          <Svg
            height={350}
            pointerEvents="none"
            style={styles.bottomGradient}
            testID="scanner-bottom-gradient"
            width="100%"
          >
            <Defs>
              <SvgLinearGradient id="scannerBottomGradient" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#5D5D5D" stopOpacity="0" />
                <Stop offset="0.4" stopColor="#5D5D5D" stopOpacity="0.19" />
                <Stop offset="1" stopColor="#000000" stopOpacity="0.3" />
              </SvgLinearGradient>
            </Defs>
            <Rect fill="url(#scannerBottomGradient)" height="100%" width="100%" />
          </Svg>
        )}
        <GestureDetector gesture={trayPanGesture}>
        <View style={styles.trayShell} testID="scanner-tray">
          {/*
            ONE BACKDROP EVERYWHERE: blur + a light dark scrim (Figma
            3594:25846 — `backdrop-blur(20px)` over rgba(0,0,0,0.15)).

            iOS 26 briefly got real Liquid Glass here instead, and it was the
            wrong material for THIS surface: `glassEffectStyle="clear"` refracts
            whatever is behind it, and behind the tray is a LIVE viewfinder — so
            the backdrop shimmered and warped with every hand movement ("the
            glass is just a little too much on iOS"). Liquid Glass stays right
            for the small chrome (pills, bubbles); a large panel over moving
            video wants the calmer frosted dim the design actually specs, which
            is also exactly what Android was already drawing.
          */}
          <Reanimated.View
            pointerEvents="none"
            style={[styles.trayBackdropFill, trayBackdropAnimatedStyle]}
            testID="scanner-tray-backdrop"
          >
            <BlurView
              // Android needs the dimezisBlurView method or BlurView is a
              // silent no-op. iOS ignores the prop.
              experimentalBlurMethod="dimezisBlurView"
              intensity={88}
              pointerEvents="none"
              style={styles.trayBackdropBlur}
              tint="default"
            />
            <View pointerEvents="none" style={styles.trayBackdropOverlay} />
          </Reanimated.View>
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
                {/*
                  Expanded: a solid white chip (Figma 4046:20579) — a plain
                  View, never glass, so the fill can't be replaced by the
                  translucent material on iOS 26.
                */}
                {isTrayExpanded ? (
                  <View
                    style={[styles.trayInfoPill, styles.trayInfoPillExpanded]}
                    testID="scanner-recent-title-surface"
                  >
                    <Text
                      style={[styles.trayInfoPillLabel, styles.trayInfoPillLabelExpanded]}
                      testID="scanner-recent-title"
                    >
                      {`SCAN: ${recentCaptures.length}`}
                    </Text>
                  </View>
                ) : (
                  <GlassSurface
                    fallbackColor="rgba(255, 255, 255, 0.10)"
                    glassColorScheme="dark"
                    glassEffectStyle="clear"
                    style={styles.trayInfoPill}
                    testID="scanner-recent-title-surface"
                  >
                    <Text style={styles.trayInfoPillLabel} testID="scanner-recent-title">
                      {`SCAN: ${recentCaptures.length}`}
                    </Text>
                  </GlassSurface>
                )}
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
              {isTrayExpanded ? (
                <View
                  style={[styles.trayInfoPill, styles.trayInfoPillExpanded]}
                  testID="scanner-value-pill-surface"
                >
                  <Text
                    style={[styles.trayInfoPillLabel, styles.trayInfoPillLabelExpanded]}
                    testID="scanner-value-pill-text"
                  >
                    {`TOTAL: ${formatTrayTotal(trayPriceSummary)}`}
                  </Text>
                </View>
              ) : (
                <GlassSurface
                  fallbackColor="rgba(255, 255, 255, 0.10)"
                  glassColorScheme="dark"
                  glassEffectStyle="clear"
                  style={styles.trayInfoPill}
                  testID="scanner-value-pill-surface"
                >
                  <Text style={styles.trayInfoPillLabel} testID="scanner-value-pill-text">
                    {`TOTAL: ${formatTrayTotal(trayPriceSummary)}`}
                  </Text>
                </GlassSurface>
              )}
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
                  {visibleCaptures.map((capture, index) => {
                    const pageId = capture.binderPage?.pageId ?? null;
                    const pageGroup = pageId != null ? binderPageGroups.get(pageId) : undefined;
                    // Headers render in BOTH tray states — the collapsed
                    // viewport scrolls past the first one (collapsedAnchorOffset)
                    // instead of the header unmounting, so expanding never
                    // reflows the list.
                    const startsPage = pageGroup?.firstCaptureId === capture.id;
                    if (!startsPage || pageId == null || pageGroup == null) {
                      return renderCaptureRow(capture, index);
                    }
                    const pageRowCount = pageGroup.rowCount;
                    return (
                      <Fragment key={`page-group-${pageId}`}>
                        <View style={styles.binderPageHeader} testID={`scanner-tray-page-header-${pageId}`}>
                          <Text style={styles.binderPageHeaderLabel}>
                            {`BINDER PAGE · ${pageRowCount} CARD${pageRowCount === 1 ? '' : 'S'}`}
                          </Text>
                          {pageRowCount > 0 ? (
                            <ArenaPressable
                              accessibilityLabel="View binder page"
                              accessibilityRole="button"
                              hitSlop={8}
                              onPress={gate(() => openBinderPageReview(pageId))}
                              style={({ pressed }) => [
                                styles.binderPageHeaderButton,
                                pressed ? styles.captureChangeChipPressed : null,
                              ]}
                              testID={`scanner-tray-page-view-${pageId}`}
                            >
                              <Text style={styles.binderPageHeaderButtonLabel}>VIEW PAGE</Text>
                            </ArenaPressable>
                          ) : null}
                        </View>
                        {renderCaptureRow(capture, index)}
                      </Fragment>
                    );
                  })}
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
        if (!activeBinderPageId) {
          return null;
        }
        return (
          <BinderPageReview
            isAddingAll={isAddingBinderPage}
            onAddAll={gate(() => handleAddBinderPage(activeBinderPageId))}
            onClose={closeBinderPageReview}
            onPressPocket={gate(openChangeCardPicker)}
            pockets={binderPageRows(recentCaptures, activeBinderPageId)}
            priceLabelFor={(capture) => {
              const { amount, currencyCode } = resolveCaptureTrayPrice(capture, priceSelection.get(capture.id) ?? null);
              return isFinitePrice(amount) ? formatCurrency(amount, currencyCode) : null;
            }}
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
        lane={scanLane}
        onSelectLane={(nextLane) => {
          // Picking a lane is a one-tap action: apply it and close the sheet
          // so the user doesn't have to also tap out of the modal to dismiss it.
          setScanLane(nextLane);
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
    justifyContent: 'center',
    position: 'absolute',
    zIndex: 4,
  },
  topChromeCenter: {
    flex: 1,
    paddingHorizontal: 16,
  },
  languageTooltipWrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 5,
  },
  binderGridLine: {
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
    position: 'absolute',
    zIndex: 3,
  },
  // POC chrome (dev builds only) — the UX pass owns the real treatment.
  binderPageHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    height: binderPageHeaderHeight,
    justifyContent: 'space-between',
    width: '100%',
  },
  binderPageHeaderLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    letterSpacing: 0.6,
    lineHeight: 16,
    opacity: 0.85,
  },
  binderPageHeaderButton: {
    backgroundColor: colors.scannerConditionPill,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  binderPageHeaderButtonLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
  },
  pocketBadge: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
  },
  pocketGlyph: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 1,
    width: 3 * 4 + 2,
  },
  pocketGlyphCell: {
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    height: 4,
    width: 4,
  },
  pocketGlyphCellActive: {
    backgroundColor: colors.purple500,
  },
  pocketBadgeLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
    opacity: 0.85,
  },
  // Single ↔ 3×3 segmented dock: dark clear-glass shell, light-glass chip on
  // the selected segment (mirrors the zoom dock's material recipe).
  binderModeDock: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 2,
    marginRight: 12,
    overflow: 'hidden',
    padding: 3,
  },
  binderModeSegment: {
    alignItems: 'center',
    borderRadius: 999,
    height: 26,
    justifyContent: 'center',
    minWidth: 52,
    paddingHorizontal: 10,
  },
  // The glass fills the whole segment chip so the material clips the label
  // rather than sitting behind it (same trick as zoomPillSurface).
  binderModeSegmentSurface: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  binderModeSegmentLabel: {
    ...textStyles.label,
    color: colors.gray0,
    fontSize: 12,
  },
  binderModeSegmentLabelSelected: {
    color: colors.gray900,
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
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  // The glass fills the whole 36pt circle, so the material clips the label
  // rather than sitting behind it.
  zoomPillSurface: {
    alignItems: 'center',
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 32,
  },
  zoomPillLabel: {
    ...textStyles.label,
    color: colors.gray0,
    fontSize: 12,
  },
  zoomPillLabelSelected: {
    color: colors.gray900,
  },
  captureCopy: {
    alignItems: 'flex-start',
    gap: 2,
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
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 16.4,
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
    ...textStyles.labelStrong,
    color: colors.gray0,
  },
  trayInfoPillExpanded: {
    backgroundColor: colors.gray0,
  },
  trayInfoPillLabelExpanded: {
    color: colors.gray900,
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
  trayBackdropFill: {
    ...StyleSheet.absoluteFillObject,
  },
  trayBackdropOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.40)',
  },
  bottomGradient: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 3,
  },
});
