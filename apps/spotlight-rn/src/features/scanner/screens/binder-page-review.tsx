import { useEffect, useState } from 'react';
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

import { Button, Text, colors, fontFamilies, textStyles } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import {
  binderPageGridSize,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
} from '@/features/scanner/scanner-normalized-target';

import { activeCandidateForCapture, scannerCaptureThumbUri } from './scanner-screen-helpers';
import type { RecentCapture } from './scanner-screen-types';

export type BinderPageReviewProps = {
  /** Rows of this page in pocket order (may be shorter than nine after adds/swipes). */
  pockets: readonly RecentCapture[];
  /** Formatted market price for the row's active candidate, or null when unpriced. */
  priceLabelFor: (capture: RecentCapture) => string | null;
  isAddingAll: boolean;
  onAddAll: () => void;
  onClose: () => void;
  /** Opens the ordinary change-card picker for that pocket's row. */
  onPressPocket: (captureId: string) => void;
  /** Formatted total of this page's shown prices (tray TOTAL formatting). */
  totalLabel: string;
  testID?: string;
};

const cardAspect = rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight;
const gridGap = 10;
const captionHeight = 50;

/**
 * The binder page as the scan result — but drawn with what we MATCHED, not
 * what we photographed. The user is holding the real page; the photo tells
 * them nothing new. A 3x3 of catalog art in pocket order lets them glance
 * between phone and binder and see any pocket that doesn't look like the card
 * sitting in it. Tap a tile to fix it (the ordinary change-card picker);
 * long-press to peek at the crop we actually scanned.
 *
 * In-tree overlay for the same reason as the change-card picker: an RN Modal
 * would sit in its own window and the picker (also in-tree) could not stack
 * above it.
 */
export function BinderPageReview({
  isAddingAll,
  onAddAll,
  onClose,
  onPressPocket,
  pockets,
  priceLabelFor,
  totalLabel,
  testID = 'scanner-binder-page-review',
}: BinderPageReviewProps) {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);



  // Frame-measured tile sizing (see the grid note below).
  const [tileWidth, setTileWidth] = useState(0);
  const handleFrameLayout = (event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    const usableWidth = width - 32;
    const widthDriven = (usableWidth - 2 * gridGap) / 3;
    const rowHeight = (height - 2 * gridGap) / 3;
    const artHeight = rowHeight - captionHeight - 4;
    const heightDriven = artHeight * cardAspect;
    const next = Math.floor(Math.max(0, Math.min(widthDriven, heightDriven)));
    setTileWidth((current) => (current === next ? current : next));
  };

  const byPocket = new Map(pockets.map((capture) => [capture.binderPage?.pocketIndex ?? -1, capture]));
  const pocketCount = binderPageGridSize * binderPageGridSize;
  const pending = pockets.filter((capture) => capture.isLoadingCandidates).length;
  const addable = pockets.filter((capture) => !capture.isLoadingCandidates && !!activeCandidateForCapture(capture));

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

        {/*
          No ScrollView: all nine pockets must fit the viewport at once, so the
          tile width is DERIVED from the measured frame — three rows of
          art + caption plus the grid gaps — and clamped to the width-driven
          three-column size. Small screens get smaller tiles, never a scroll.
        */}
        <View onLayout={handleFrameLayout} style={styles.frame}>
          {tileWidth > 0 ? (
            <View style={styles.grid} testID={`${testID}-grid`}>
              {Array.from({ length: pocketCount }, (_, pocketIndex) => (
                <PocketTile
                  capture={byPocket.get(pocketIndex) ?? null}
                  key={`pocket-${pocketIndex}`}
                  onPress={onPressPocket}
                  pocketIndex={pocketIndex}
                  priceLabelFor={priceLabelFor}
                  testID={`${testID}-pocket-${pocketIndex}`}
                  width={tileWidth}
                />
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.footer}>
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
  onPress,
  pocketIndex,
  priceLabelFor,
  testID,
  width,
}: {
  capture: RecentCapture | null;
  onPress: (captureId: string) => void;
  pocketIndex: number;
  priceLabelFor: (capture: RecentCapture) => string | null;
  testID: string;
  width: number;
}) {
  // Long-press shows the crop we scanned instead of the matched art.
  const [peeking, setPeeking] = useState(false);
  const candidate = capture ? activeCandidateForCapture(capture) : null;
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

  return (
    <Pressable
      accessibilityLabel={candidate
        ? `Pocket ${pocketIndex + 1}: ${candidate.name}. Change match`
        : `Pocket ${pocketIndex + 1}`}
      accessibilityRole="button"
      delayLongPress={220}
      disabled={!capture || isLoading}
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
        {isLoading || !capture ? (
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
            <Text numberOfLines={1} style={styles.captionPrice}>{priceLabel ?? '—'}</Text>
          </>
        ) : capture ? (
          <Text numberOfLines={2} style={styles.captionMeta}>No match · tap to search</Text>
        ) : (
          <Text numberOfLines={1} style={styles.captionMeta}>Identifying…</Text>
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
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  emptyLabel: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
  },
  pocketNumber: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
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
  captionPrice: {
    color: colors.scannerTextPrimary,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 12,
    lineHeight: 15,
  },
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
});
