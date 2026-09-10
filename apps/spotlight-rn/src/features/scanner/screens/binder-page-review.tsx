import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { IconChevronLeft } from '@tabler/icons-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { Button, Text, Toast, colors, fontFamilies, spacing, textStyles } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { BinderSetAllRow } from '@/features/scanner/components/binder-set-all-row';
import { PrintingChip, printingChipHeight } from '@/features/scanner/components/printing-chip';
import {
  describeBatchPriceResult,
  printingChipLabel,
  resolveBatchPriceSelections,
  standardPrintingOptions,
  type BatchPriceSelectionRequest,
  type RawPricingMatrixCache,
} from '@/features/scanner/scan-batch-pricing';
import {
  binderPageLayoutById,
  binderPagePocketCount,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
} from '@/features/scanner/scanner-normalized-target';
import { useAppServices } from '@/providers/app-providers';

import type { ScanPriceSheetSelection } from './scan-price-sheet';
import { activeCandidateForCapture, scannerCaptureThumbUri } from './scanner-screen-helpers';
import type { RecentCapture } from './scanner-screen-types';

export type BinderPageReviewProps = {
  /** Rows of this page in pocket order (may be shorter than nine after adds/swipes). */
  pockets: readonly RecentCapture[];
  /** Formatted market price for the row's active candidate, or null when unpriced. */
  priceLabelFor: (capture: RecentCapture) => string | null;
  /** The tray's per-capture printing/condition choices (same map the rows read). */
  priceSelections: ReadonlyMap<string, ScanPriceSheetSelection>;
  isAddingAll: boolean;
  onAddAll: () => void;
  onClose: () => void;
  /** Opens the ordinary change-card picker for that pocket's row. */
  onPressPocket: (captureId: string) => void;
  /** Opens the price sheet (printing + condition) for that pocket's row. */
  onPressPocketPrice: (captureId: string) => void;
  /** "Not sure?" alternate tapped — same setter the change-card picker uses. */
  onSelectPocketCandidate: (captureId: string, candidateIndex: number) => void;
  /** "Set all" resolved: merge these into the tray's price-selection map. */
  onApplyPriceSelections: (entries: { captureId: string; selection: ScanPriceSheetSelection }[]) => void;
  /** Formatted total of this page's shown prices (tray TOTAL formatting). */
  totalLabel: string;
  testID?: string;
};

const cardAspect = rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight;
const gridGap = 10;
// name 15 + set 13 + price 15 + chip 18 + 3 gaps of 2 (+ slack).
const captionHeight = 15 + 13 + 15 + printingChipHeight + 6 + 2;
const alternatesStripHeight = 92;
const alternateThumbWidth = 40;

type AlternateCandidate = { candidate: CatalogSearchResult; index: number };

/**
 * The binder page as the scan result — but drawn with what we MATCHED, not
 * what we photographed. The user is holding the real page; the photo tells
 * them nothing new. A 3x3 of catalog art in pocket order lets them glance
 * between phone and binder and see any pocket that doesn't look like the card
 * sitting in it. Tap a tile to fix it (the ordinary change-card picker);
 * long-press to peek at the crop we actually scanned; tap the printing chip
 * to fix the printing/condition; "Set all" fixes the whole page at once.
 *
 * In-tree overlay for the same reason as the change-card picker: an RN Modal
 * would sit in its own window and the picker (also in-tree) could not stack
 * above it.
 */
export function BinderPageReview({
  isAddingAll,
  onAddAll,
  onApplyPriceSelections,
  onClose,
  onPressPocket,
  onPressPocketPrice,
  onSelectPocketCandidate,
  pockets,
  priceLabelFor,
  priceSelections,
  totalLabel,
  testID = 'scanner-binder-page-review',
}: BinderPageReviewProps) {
  const { spotlightRepository } = useAppServices();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  // Frame-measured tile sizing (see the grid note below).
  // The page's own layout (3×3 / 3×4 / 3×6) drives the overlay grid; every
  // row of the page shares one layout, so the first pocket's is the page's.
  const layout = binderPageLayoutById(pockets[0]?.binderPage?.layoutId);
  const [frameSize, setFrameSize] = useState<{ height: number; width: number } | null>(null);
  const handleFrameLayout = (event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setFrameSize((current) => (
      current && current.height === height && current.width === width ? current : { height, width }
    ));
  };

  // "Not sure?" — which pocket's top-3 alternates are expanded (one at a time).
  const [expandedPocketId, setExpandedPocketId] = useState<string | null>(null);

  const tileWidth = useMemo(() => {
    if (!frameSize) {
      return 0;
    }
    const usableWidth = frameSize.width - 32;
    const widthDriven = (usableWidth - (layout.columns - 1) * gridGap) / layout.columns;
    const stripHeight = expandedPocketId ? alternatesStripHeight + gridGap : 0;
    const rowHeight = (frameSize.height - stripHeight - (layout.rows - 1) * gridGap) / layout.rows;
    const artHeight = rowHeight - captionHeight - 4;
    const heightDriven = artHeight * cardAspect;
    return Math.floor(Math.max(0, Math.min(widthDriven, heightDriven)));
  }, [expandedPocketId, frameSize, layout.columns, layout.rows]);

  const byPocket = new Map(pockets.map((capture) => [capture.binderPage?.pocketIndex ?? -1, capture]));
  const pocketCount = binderPagePocketCount(layout);
  const pending = pockets.filter((capture) => capture.isLoadingCandidates).length;
  // Same filter as the page's Add-all handler, so the CTA count is the count added.
  const addable = pockets.filter((capture) =>
    !capture.isLoadingCandidates && !capture.recentlyAdded && !!activeCandidateForCapture(capture));

  // Batch printing/condition — see `resolveBatchPriceSelections`.
  const matrixCacheRef = useRef<RawPricingMatrixCache>(new Map());
  const [isApplying, setIsApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pocketsRef = useRef(pockets);
  pocketsRef.current = pockets;
  const selectionsRef = useRef(priceSelections);
  selectionsRef.current = priceSelections;
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const applyToPage = useCallback((request: BatchPriceSelectionRequest) => {
    setIsApplying(true);
    void (async () => {
      const result = await resolveBatchPriceSelections(
        pocketsRef.current,
        request,
        selectionsRef.current,
        matrixCacheRef.current,
        (cardId) => spotlightRepository.getRawPricingMatrix(cardId),
      );
      if (result.entries.length > 0) {
        onApplyPriceSelections(result.entries);
      }
      if (mountedRef.current) {
        setIsApplying(false);
        setNotice(describeBatchPriceResult(request, result));
      }
    })();
  }, [onApplyPriceSelections, spotlightRepository]);

  const handleSelectPrinting = useCallback((printingLabel: string) => {
    applyToPage({ kind: 'printing', printingLabel });
  }, [applyToPage]);

  const expandedPocket = expandedPocketId
    ? pockets.find((capture) => capture.id === expandedPocketId) ?? null
    : null;
  const expandedRow = expandedPocket
    ? Math.floor((expandedPocket.binderPage?.pocketIndex ?? 0) / layout.columns)
    : -1;

  return (
    <View style={styles.root} testID={testID}>
      <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="dark" />
      <View style={styles.wash} />
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back to scanner"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            style={styles.backButton}
            testID={`${testID}-close`}
          >
            <IconChevronLeft color={colors.scannerTextPrimary} size={24} strokeWidth={2} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Binder page</Text>
            {pending > 0 ? (
              <Text style={styles.subtitle} testID={`${testID}-status`}>
                {`Identifying ${pending} of ${pocketCount}…`}
              </Text>
            ) : null}
          </View>
        </View>

        <BinderSetAllRow
          busy={isApplying}
          onSelectPrinting={handleSelectPrinting}
          printingOptions={standardPrintingOptions}
          testID={`${testID}-set-all`}
        />

        {/*
          No ScrollView: all nine pockets must fit the viewport at once, so the
          tile width is DERIVED from the measured frame — three rows of
          art + caption plus the grid gaps (and the alternates strip when one
          is open) — and clamped to the width-driven three-column size. Small
          screens get smaller tiles, never a scroll. Rows are laid out
          explicitly (not flexWrap) so the "Not sure?" strip can sit directly
          under the row that owns it.
        */}
        <View onLayout={handleFrameLayout} style={styles.frame} testID={`${testID}-frame`}>
          {tileWidth > 0 ? (
            <View style={styles.grid} testID={`${testID}-grid`}>
              {Array.from({ length: layout.rows }, (_, rowIndex) => (
                <View key={`row-${rowIndex}`} style={styles.gridRowGroup}>
                  <View style={styles.gridRow}>
                    {Array.from({ length: layout.columns }, (_, columnIndex) => {
                      const pocketIndex = rowIndex * layout.columns + columnIndex;
                      if (pocketIndex >= pocketCount) {
                        return null;
                      }
                      const capture = byPocket.get(pocketIndex) ?? null;
                      return (
                        <PocketTile
                          capture={capture}
                          isExpanded={!!capture && capture.id === expandedPocketId}
                          key={`pocket-${pocketIndex}`}
                          onPress={onPressPocket}
                          onPressPrice={onPressPocketPrice}
                          onToggleAlternates={(captureId) => {
                            setExpandedPocketId((current) => (current === captureId ? null : captureId));
                          }}
                          pocketIndex={pocketIndex}
                          priceLabelFor={priceLabelFor}
                          selection={capture ? priceSelections.get(capture.id) ?? null : null}
                          testID={`${testID}-pocket-${pocketIndex}`}
                          width={tileWidth}
                        />
                      );
                    })}
                  </View>
                  {expandedPocket && expandedRow === rowIndex ? (
                    <AlternatesStrip
                      capture={expandedPocket}
                      onSelect={(index) => {
                        onSelectPocketCandidate(expandedPocket.id, index);
                        setExpandedPocketId(null);
                      }}
                      testID={`${testID}-alternates`}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.footer}>
          {/* Floats over the grid's bottom edge so showing it never re-measures the tiles. */}
          <Toast
            durationMs={3500}
            message={notice ?? ''}
            onDismiss={() => setNotice(null)}
            showDismiss={false}
            style={styles.notice}
            testID={`${testID}-set-all-notice`}
            visible={notice != null}
          />
          <Button
            disabled={isAddingAll || addable.length === 0}
            label={isAddingAll ? 'Adding…' : `Add ${addable.length} · ${totalLabel}`}
            onPress={onAddAll}
            size="lg"
            testID={`${testID}-add-all`}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

function PocketTile({
  capture,
  isExpanded,
  onPress,
  onPressPrice,
  onToggleAlternates,
  pocketIndex,
  priceLabelFor,
  selection,
  testID,
  width,
}: {
  capture: RecentCapture | null;
  isExpanded: boolean;
  onPress: (captureId: string) => void;
  onPressPrice: (captureId: string) => void;
  onToggleAlternates: (captureId: string) => void;
  pocketIndex: number;
  priceLabelFor: (capture: RecentCapture) => string | null;
  selection: ScanPriceSheetSelection | null;
  testID: string;
  width: number;
}) {
  // Long-press shows the crop we scanned instead of the matched art.
  const [peeking, setPeeking] = useState(false);
  const candidate = capture ? activeCandidateForCapture(capture) : null;
  // The backend found no card here: no spinner, no picker, an "Empty" caption.
  const isEmpty = !!capture?.binderPage?.empty;
  const isLoading = !!capture?.isLoadingCandidates;
  const cropUri = capture?.normalizedImageUri ?? capture?.uri ?? null;
  const matchedUri = capture ? scannerCaptureThumbUri(capture, candidate) : null;
  const artUri = peeking || isLoading || !candidate ? cropUri : matchedUri;
  const priceLabel = capture && candidate ? priceLabelFor(capture) : null;
  const setLine = candidate
    ? [candidate.setName, candidate.cardNumber ? `#${candidate.cardNumber.replace(/^#/, '')}` : null]
      .filter(Boolean)
      .join(' · ')
    : '';
  // Anything short of a high-confidence match gets the "Not sure?" affordance
  // (needs at least one alternate to offer).
  const isUncertain = !!capture && !!candidate && capture.matchConfidence !== 'high' && capture.candidates.length > 1;
  const showPrintingChip = !!capture && !!candidate && capture.mode === 'raw';

  return (
    <Pressable
      accessibilityLabel={candidate
        ? `Pocket ${pocketIndex + 1}: ${candidate.name}. Change match`
        : `Pocket ${pocketIndex + 1}`}
      accessibilityRole="button"
      delayLongPress={220}
      disabled={!capture || isLoading || isEmpty}
      onLongPress={() => setPeeking(true)}
      onPress={() => {
        if (capture) {
          onPress(capture.id);
        }
      }}
      onPressOut={() => setPeeking(false)}
      style={({ pressed }) => [styles.tile, { width }, pressed ? styles.tilePressed : null]}
      testID={testID}
    >
      <View style={styles.art}>
        {artUri ? (
          <CachedImage
            cachePolicy={imageCachePolicy.thumbnail}
            contentFit="cover"
            // Keep the scanned crop up while the matched art downloads, with a
            // crossfade when it lands — the tray thumbnail does the same swap.
            placeholder={cropUri ? { uri: cropUri } : undefined}
            placeholderContentFit="cover"
            recyclingKey={`${capture?.id ?? 'empty'}-${peeking ? 'crop' : 'match'}`}
            style={StyleSheet.absoluteFill}
            transition={120}
            uri={artUri}
          />
        ) : null}
        {(isLoading || !capture) && !isEmpty ? (
          <View style={styles.artScrim}>
            <ActivityIndicator color={colors.scannerTextPrimary} size="small" />
          </View>
        ) : null}
        <View style={styles.pocketNumber}>
          <Text style={styles.pocketNumberLabel}>{pocketIndex + 1}</Text>
        </View>
      </View>
      <View style={styles.caption}>
        {isLoading ? (
          <Text numberOfLines={1} style={styles.captionMeta}>Identifying…</Text>
        ) : candidate ? (
          <>
            <Text numberOfLines={1} style={styles.captionTitle}>{candidate.name}</Text>
            <Text numberOfLines={1} style={styles.captionMeta}>{setLine}</Text>
            <View style={styles.captionPriceRow}>
              <Text numberOfLines={1} style={styles.captionPrice}>{priceLabel ?? '—'}</Text>
              {isUncertain ? (
                <Pressable
                  accessibilityLabel={isExpanded ? 'Hide other matches' : 'Not sure? Show other matches'}
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => {
                    if (capture) {
                      onToggleAlternates(capture.id);
                    }
                  }}
                  testID={`${testID}-not-sure`}
                >
                  <Text style={styles.notSure}>{isExpanded ? 'Hide' : 'Not sure?'}</Text>
                </Pressable>
              ) : null}
            </View>
            {showPrintingChip ? (
              <PrintingChip
                confirmed={!!selection}
                label={printingChipLabel(candidate, selection)}
                onPress={() => {
                  if (capture) {
                    onPressPrice(capture.id);
                  }
                }}
                testID={`${testID}-printing`}
              />
            ) : null}
          </>
        ) : isEmpty ? (
          // Same weight as a matched card's name — the pocket's state is the
          // headline here, not a footnote.
          <Text numberOfLines={1} style={styles.captionTitle}>Empty</Text>
        ) : capture ? (
          <Text numberOfLines={2} style={styles.captionMeta}>No match · tap to search</Text>
        ) : (
          <Text numberOfLines={1} style={styles.captionMeta}>Identifying…</Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * The top-3 alternates for an uncertain pocket, inline under its grid row.
 * Tapping one is the same selection the change-card picker makes.
 */
function AlternatesStrip({
  capture,
  onSelect,
  testID,
}: {
  capture: RecentCapture;
  onSelect: (candidateIndex: number) => void;
  testID: string;
}) {
  const alternates: AlternateCandidate[] = capture.candidates
    .slice(0, 3)
    .map((candidate, index) => ({ candidate, index }));
  const pocketNumber = (capture.binderPage?.pocketIndex ?? 0) + 1;
  return (
    <View style={styles.alternates} testID={testID}>
      <Text numberOfLines={1} style={styles.alternatesTitle}>{`Pocket ${pocketNumber} · other matches`}</Text>
      <View style={styles.alternatesRow}>
        {alternates.map(({ candidate, index }) => {
          const isActive = index === capture.activeCandidateIndex;
          const thumbUri = candidate.smallImageUrl ?? candidate.imageUrl;
          return (
            <Pressable
              accessibilityLabel={`Use ${candidate.name}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              key={candidate.id}
              onPress={() => onSelect(index)}
              style={({ pressed }) => [
                styles.alternate,
                isActive ? styles.alternateActive : null,
                pressed ? styles.tilePressed : null,
              ]}
              testID={`${testID}-${index}`}
            >
              <View style={styles.alternateThumb}>
                {thumbUri ? (
                  <CachedImage
                    cachePolicy={imageCachePolicy.thumbnail}
                    contentFit="cover"
                    recyclingKey={`${capture.id}-alt-${candidate.id}`}
                    style={StyleSheet.absoluteFill}
                    uri={thumbUri}
                  />
                ) : null}
              </View>
              <View style={styles.alternateCopy}>
                <Text numberOfLines={1} style={styles.captionTitle}>{candidate.name}</Text>
                <Text numberOfLines={1} style={styles.captionMeta}>{candidate.setName}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    elevation: 20,
    zIndex: 90,
  },
  wash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  safe: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
  },
  subtitle: {
    ...textStyles.caption,
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    opacity: 0.8,
  },
  frame: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  grid: {
    gap: gridGap,
  },
  gridRowGroup: {
    gap: gridGap,
  },
  gridRow: {
    flexDirection: 'row',
    gap: gridGap,
    justifyContent: 'center',
  },
  tile: {
    gap: 4,
    // Width comes inline from the measured frame (three rows must fit with no
    // scroll); the grid renders only after the first measurement, so there is
    // no unmeasured first paint to mis-wrap.
  },
  tilePressed: {
    opacity: 0.75,
  },
  art: {
    aspectRatio: cardAspect,
    backgroundColor: colors.scannerSurfaceStrong,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderCurve: 'continuous',
    borderRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
    width: '100%',
  },
  artScrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
  },
  pocketNumber: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    borderCurve: 'continuous',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    left: 4,
    position: 'absolute',
    top: 4,
    width: 18,
  },
  pocketNumberLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
  },
  caption: {
    gap: 2,
    height: captionHeight,
  },
  captionTitle: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 15,
  },
  captionMeta: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 10,
    lineHeight: 13,
    opacity: 0.75,
  },
  captionPriceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
    justifyContent: 'space-between',
  },
  captionPrice: {
    color: colors.scannerTextPrimary,
    flexShrink: 1,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 12,
    lineHeight: 15,
  },
  notSure: {
    ...textStyles.overline,
    color: colors.warning,
    textDecorationLine: 'underline',
  },
  alternates: {
    backgroundColor: colors.scannerSurfaceStrong,
    borderCurve: 'continuous',
    borderRadius: spacing.xs,
    gap: spacing.xxxs,
    height: alternatesStripHeight,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  alternatesTitle: {
    ...textStyles.overline,
    color: colors.scannerTextPrimary,
    opacity: 0.8,
  },
  alternatesRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  alternate: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderCurve: 'continuous',
    borderRadius: spacing.xxs,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xxxs,
    padding: 2,
  },
  alternateActive: {
    borderColor: colors.scannerTextPrimary,
  },
  alternateThumb: {
    aspectRatio: cardAspect,
    backgroundColor: colors.scannerSurfaceStrong,
    borderCurve: 'continuous',
    borderRadius: 2,
    overflow: 'hidden',
    width: alternateThumbWidth,
  },
  alternateCopy: {
    flex: 1,
  },
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  notice: {
    bottom: '100%',
    left: 16,
    marginBottom: spacing.xxs,
    position: 'absolute',
    right: 16,
  },
});
