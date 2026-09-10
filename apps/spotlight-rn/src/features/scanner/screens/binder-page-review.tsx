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

import { Button, Text, Toast, colors, fontFamilies, spacing, textStyles } from '@spotlight/design-system';

import { capturePostHogEvent } from '@/lib/observability/posthog';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { BinderBatchActionRow } from '@/features/scanner/components/binder-batch-action-row';
import {
  describeBatchPriceResult,
  printingAbbreviation,
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
  /** A selection batch resolved: merge these into the tray's price-selection map. */
  onApplyPriceSelections: (entries: { captureId: string; selection: ScanPriceSheetSelection }[]) => void;
  /** Formatted total of this page's shown prices (tray TOTAL formatting). */
  totalLabel: string;
  testID?: string;
};

const cardAspect = rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight;
const gridGap = 10;
// Name 15 + set line 13 + price row 15 + 3 gaps of 2 (+ slack). FIXED: the
// printing rides on the price row rather than adding a line of its own, so a
// batch never resizes the cards or pushes the grid into a scroll
// (user, 2026-09-10: "it kinda makes the ui kinda like moves").
const captionHeight = 15 + 13 + 15 + 6 + 2;
/**
 * The binder page as the scan result — but drawn with what we MATCHED, not
 * what we photographed. The user is holding the real page; the photo tells
 * them nothing new. A 3x3 of catalog art in pocket order lets them glance
 * between phone and binder and see any pocket that doesn't look like the card
 * sitting in it. Tap a tile to fix it (the ordinary change-card picker);
 * HOLD a tile to start selecting, then tap the rest (or "All") and set their
 * variant or condition together from the toolbar that appears. Nothing but the
 * hint sits over the page until then — the always-on "Set all" row with its two
 * dropdowns was removed (user, 2026-09-09).
 *
 * The tiles carry no controls of their own. They had two — a "Not sure?" link
 * opening a strip of alternates, and a printing chip opening the price sheet —
 * and nine of each left the art too small to check against the binder in your
 * hand (user, 2026-09-09). Both capabilities survive off the tile: the
 * alternates are the first thing in the change-card picker a tap already opens,
 * and variant/condition are the selection toolbar's two dropdowns, over a
 * selection of one where they used to be per card.
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

  /*
    HOLD-TO-SELECT. Empty = not selecting at all, and the page behaves as it
    always did (tap fixes a match). Non-empty and every tap toggles instead,
    which is why the set is the mode rather than a separate boolean: the two
    can never disagree about whether a tap means "fix this" or "pick this".
  */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selecting = selectedIds.size > 0;

  const tileWidth = useMemo(() => {
    if (!frameSize) {
      return 0;
    }
    const usableWidth = frameSize.width - 32;
    const widthDriven = (usableWidth - (layout.columns - 1) * gridGap) / layout.columns;
    const rowHeight = (frameSize.height - (layout.rows - 1) * gridGap) / layout.rows;
    const artHeight = rowHeight - captionHeight - 4;
    const heightDriven = artHeight * cardAspect;
    return Math.floor(Math.max(0, Math.min(widthDriven, heightDriven)));
  }, [frameSize, layout.columns, layout.rows]);

  /*
    Where the FIRST CARD starts, in screen px. The grid rows center themselves
    inside the 16pt page gutter, and the tile width is usually height-driven
    rather than width-driven, so the columns sit noticeably inboard of that
    gutter. The selection toolbar reads as floating loose on the left unless it
    starts on the same line as the cards it is editing (user, 2026-09-10).
  */
  const gridInsetLeft = useMemo(() => {
    if (!frameSize || tileWidth <= 0) {
      return null;
    }
    const usableWidth = frameSize.width - 32;
    const contentWidth = layout.columns * tileWidth + (layout.columns - 1) * gridGap;
    return 16 + Math.max(0, (usableWidth - contentWidth) / 2);
  }, [frameSize, layout.columns, tileWidth]);

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

  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  // Applies to the SELECTION only — the toolbar exists only while there is
  // one. `resolveBatchPriceSelections` only ever sees the pockets it should
  // touch, so its "applied to 7 of 9" count is already scoped correctly.
  const applyToTargets = useCallback((request: BatchPriceSelectionRequest) => {
    const chosen = selectedIdsRef.current;
    const targets = pocketsRef.current.filter((capture) => chosen.has(capture.id));
    if (targets.length === 0) {
      return;
    }
    setIsApplying(true);
    void (async () => {
      const result = await resolveBatchPriceSelections(
        targets,
        request,
        selectionsRef.current,
        matrixCacheRef.current,
        (cardId) => spotlightRepository.getRawPricingMatrix(cardId),
      );
      // Do the batch actions earn the toolbar? `selected` vs `applied` also
      // shows how often a printing simply does not exist on the cards picked.
      capturePostHogEvent('binder_batch_applied', {
        kind: request.kind,
        selected: targets.length,
        applied: result.entries.length,
      });
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
    applyToTargets({ kind: 'printing', printingLabel });
  }, [applyToTargets]);

  // Holding a tile starts selecting; tapping one while selecting toggles it.
  // Emptying the set by hand leaves selection mode, so there is no way to be
  // "selecting nothing" with the page's ordinary taps disabled.
  const toggleSelected = useCallback((captureId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(captureId)) {
        next.add(captureId);
      }
      return next;
    });
  }, []);


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
            {/*
              The hold gesture is the only way to the variant/condition
              dropdowns, so the screen says so out loud — while it is still
              worth saying. Once someone is selecting, the toolbar below is
              showing them the count and the dropdowns, and repeating the
              instruction would just be noise.
            */}
            {pending > 0 ? (
              <Text style={styles.subtitle} testID={`${testID}-status`}>
                {`Identifying ${pending} of ${pocketCount}…`}
              </Text>
            ) : selecting ? null : (
              <Text style={styles.subtitle} testID={`${testID}-hint`}>
                Hold to edit
              </Text>
            )}
          </View>
        </View>

        {selecting ? (
          <BinderBatchActionRow
            busy={isApplying}
            insetLeft={gridInsetLeft ?? undefined}
            onDone={() => setSelectedIds(new Set())}
            onSelectPrinting={handleSelectPrinting}
            printingOptions={standardPrintingOptions}
            selectedCount={selectedIds.size}
            testID={`${testID}-batch`}
          />
        ) : null}

        {/*
          No ScrollView: all nine pockets must fit the viewport at once, so the
          tile width is DERIVED from the measured frame — three rows of
          art + caption plus the grid gaps — and clamped to the width-driven
          three-column size. Small screens get smaller tiles, never a scroll,
          and the caption is a fixed height so a batch never resizes them.
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
                          isSelected={!!capture && selectedIds.has(capture.id)}
                          key={`pocket-${pocketIndex}`}
                          onPress={onPressPocket}
                          onToggleSelected={toggleSelected}
                          pocketIndex={pocketIndex}
                          priceLabelFor={priceLabelFor}
                          selecting={selecting}
                          selection={capture ? priceSelections.get(capture.id) ?? null : null}
                          testID={`${testID}-pocket-${pocketIndex}`}
                          width={tileWidth}
                        />
                      );
                    })}
                  </View>
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
            testID={`${testID}-batch-notice`}
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
  isSelected,
  onPress,
  onToggleSelected,
  pocketIndex,
  priceLabelFor,
  selecting,
  selection,
  testID,
  width,
}: {
  capture: RecentCapture | null;
  isSelected: boolean;
  onPress: (captureId: string) => void;
  onToggleSelected: (captureId: string) => void;
  pocketIndex: number;
  priceLabelFor: (capture: RecentCapture) => string | null;
  selecting: boolean;
  selection: ScanPriceSheetSelection | null;
  testID: string;
  width: number;
}) {
  const candidate = capture ? activeCandidateForCapture(capture) : null;
  // The backend found no card here: no spinner, no picker, an "Empty" caption.
  const isEmpty = !!capture?.binderPage?.empty;
  const isLoading = !!capture?.isLoadingCandidates;
  // NO ROW for this pocket. Every pocket gets a loading row the moment the
  // page is captured, and in-flight rows are deliberately not persisted
  // (`isPersistableItem`) — so after a force-quit mid-page the pockets that
  // never finished come back with nothing behind them. That used to draw as a
  // spinner + "Identifying…" that could never resolve (user, 2026-09-09). It is
  // a result now: the pocket was not identified, and there is nothing to wait
  // for or to tap.
  const isLost = !capture;
  const cropUri = capture?.normalizedImageUri ?? capture?.uri ?? null;
  const matchedUri = capture ? scannerCaptureThumbUri(capture, candidate) : null;
  // The scanned crop stands in until the match lands. Peeking at it by
  // long-press is gone — the hold gesture belongs to selection now.
  const artUri = isLoading || !candidate ? cropUri : matchedUri;
  const priceLabel = capture && candidate ? priceLabelFor(capture) : null;
  const setLine = candidate
    ? [candidate.setName, candidate.cardNumber ? `#${candidate.cardNumber.replace(/^#/, '')}` : null]
      .filter(Boolean)
      .join(' · ')
    : '';
  // Only a printing the user MOVED earns a label — it is confirmation that a
  // batch changed something, not a control. On the card's own printing the
  // price already says everything the label would. Abbreviated because it
  // shares the price row.
  const printingLabel = selection?.variantIsNonDefault && capture?.mode === 'raw'
    ? printingAbbreviation(printingChipLabel(candidate, selection))
    : null;
  const selectable = !!capture && !isLoading && !isEmpty;

  return (
    <Pressable
      accessibilityLabel={candidate
        ? `Pocket ${pocketIndex + 1}: ${candidate.name}. ${selecting ? 'Select' : 'Change match'}`
        : `Pocket ${pocketIndex + 1}`}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: isSelected } : undefined}
      delayLongPress={220}
      disabled={!selectable}
      // Hold anywhere on the page to start selecting; from then on a plain tap
      // picks rather than opens, which is the convention every photo grid uses.
      onLongPress={() => {
        if (capture && !selecting) {
          onToggleSelected(capture.id);
        }
      }}
      onPress={() => {
        if (!capture) {
          return;
        }
        if (selecting) {
          onToggleSelected(capture.id);
          return;
        }
        onPress(capture.id);
      }}
      style={({ pressed }) => [
        styles.tile,
        { width },
        pressed ? styles.tilePressed : null,
        selecting && !isSelected ? styles.tileDeselected : null,
      ]}
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
            recyclingKey={`${capture?.id ?? 'empty'}-${candidate ? 'match' : 'crop'}`}
            style={StyleSheet.absoluteFill}
            transition={120}
            uri={artUri}
          />
        ) : null}
        {isLoading && !isEmpty ? (
          <View style={styles.artScrim}>
            <ActivityIndicator color={colors.scannerTextPrimary} size="small" />
          </View>
        ) : null}
        <View style={styles.pocketNumber}>
          <Text style={styles.pocketNumberLabel}>{pocketIndex + 1}</Text>
        </View>
        {selecting && selectable ? (
          <View
            style={[styles.selectTick, isSelected ? styles.selectTickOn : null]}
            testID={`${testID}-tick`}
          >
            {isSelected ? <Text style={styles.selectTickMark}>✓</Text> : null}
          </View>
        ) : null}
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
              {printingLabel ? (
                <Text numberOfLines={1} style={styles.captionPrinting} testID={`${testID}-printing`}>
                  {printingLabel}
                </Text>
              ) : null}
            </View>
          </>
        ) : isEmpty ? (
          // Same weight as a matched card's name — the pocket's state is the
          // headline here, not a footnote.
          <Text numberOfLines={1} style={styles.captionTitle}>Empty</Text>
        ) : isLost ? (
          // Headline weight, like "Empty": this is the pocket's state.
          <Text numberOfLines={2} style={styles.captionTitle} testID={`${testID}-unidentified`}>
            Couldn&apos;t identify
          </Text>
        ) : (
          <Text numberOfLines={2} style={styles.captionMeta}>No match · tap to search</Text>
        )}
      </View>
    </Pressable>
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
  captionPrinting: {
    ...textStyles.overline,
    color: colors.scannerTextSecondary,
    flexShrink: 1,
  },
  // The tick sits opposite the pocket number so the two never collide.
  selectTick: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderColor: colors.scannerTextPrimary,
    borderCurve: 'continuous',
    borderRadius: 11,
    borderWidth: 1.5,
    bottom: 4,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    width: 22,
  },
  selectTickOn: {
    backgroundColor: colors.scannerAddPurple,
    borderColor: colors.scannerAddPurple,
  },
  selectTickMark: {
    ...textStyles.overline,
    color: colors.scannerTextPrimary,
  },
  // Unpicked tiles recede while selecting so the picked ones read at a glance.
  tileDeselected: {
    opacity: 0.45,
  },
  captionPrice: {
    color: colors.scannerTextPrimary,
    flexShrink: 1,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 12,
    lineHeight: 15,
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
