import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { ImageSourcePropType } from 'react-native';

import type { CatalogSearchResult, RawPricingMatrix } from '@spotlight/api-client';
import { colors, radii, shadows, spacing } from '@spotlight/design-system';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import type { RawScannerFrameRect } from '@/features/scanner/raw-scanner-capture-surface';
import {
  binderPageLayoutById,
  rawCardReticleAspectRatio,
} from '@/features/scanner/scanner-normalized-target';
import type { ScanPriceSheetSelection } from '@/features/scanner/screens/scan-price-sheet';
import { ScannerScreen, type ScannerDevPreview } from '@/features/scanner/screens/scanner-screen';
import { binderPocketRowId } from '@/features/scanner/screens/scanner-screen-helpers';
import type { BinderPageRef, RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import {
  DEV_SCAN_BINDER,
  DEV_SCAN_SINGLE,
  DEV_SCAN_SURFACE,
  type DevScanCard,
} from '@/dev/dev-scanner-fixtures';

/**
 * `spotlight://dev/scanner` and `spotlight://dev/scanner-binder`: the REAL
 * `ScannerScreen` with its camera swapped for a still photo and its tray
 * pre-filled from `dev-scanner-fixtures.ts`, so App Store screenshots can be
 * taken on the camera-less iOS Simulator. Nothing here is reachable outside
 * the dev host (`dev-screen-host.tsx`), which `app/dev/[screen].tsx` only
 * requires in `__DEV__`.
 *
 * The cards are drawn INSIDE the frame the reticle reports, so they sit where
 * a real capture would frame them; the tray rows are ordinary `RecentCapture`s
 * (one resolved candidate each), so the tray renders exactly as it does after
 * a live scan.
 */

export type DevScannerMode = 'single' | 'binder';

const DEV_BINDER_PAGE_ID = 'dev-binder-page';
const DEV_BINDER_LAYOUT = binderPageLayoutById('pockets-9');
// Fixed: a wall-clock stamp would vary the dwell analytics never fire here anyway.
const DEV_SCAN_SHOWN_AT_MS = Date.UTC(2026, 9, 15, 18, 0, 0);
// Single card at ~85% of the frame, tilted a touch so it reads as a card on a
// table rather than a cut-out.
const SINGLE_CARD_FILL = 0.85;
const SINGLE_CARD_TILT_DEG = 1.5;
// Pocket gap inside each binder cell — the sleeve edge around a pocketed card.
const BINDER_POCKET_GAP = spacing.xxxs;

function variantKeyFor(printing: string): string {
  return printing.toLowerCase().replace(/\s+/g, '-');
}

/** A fixture card as the catalog candidate the tray / scan review render. */
export function candidateFor(card: DevScanCard): CatalogSearchResult {
  // Metro serves the bundled PNG over http in dev, which is what the tray's
  // CachedImage (expo-image) expects for a candidate URL. Null when the asset
  // id is unregistered (jest's asset transform), so the thumb simply stays blank.
  const uri = Image.resolveAssetSource(card.image)?.uri ?? '';
  return {
    cardId: card.cardId,
    cardNumber: card.collectorNumber,
    currencyCode: 'USD',
    defaultVariantLabel: card.printing,
    game: 'pokemon',
    id: card.cardId,
    imageUrl: uri,
    largeImageUrl: uri,
    marketPrice: card.priceUsd,
    matchScore: 0.98,
    name: card.name,
    setName: card.setName,
    smallImageUrl: uri,
  };
}

function rowFor(
  card: DevScanCard,
  id: string,
  binderPage: BinderPageRef | null,
  // Runner-up matches: with more than one candidate the row draws its CHANGE
  // chip, so the Change Card overlay can be opened on the simulator.
  alternates: readonly DevScanCard[] = [],
): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [card, ...alternates].map(candidateFor),
    // Already "tracked": the terminal scan_row_resolved event must not fire for a fixture.
    hasTrackedSelectionEvent: true,
    id,
    isAddingToInventory: false,
    isLoadingCandidates: false,
    isLoadingMoreCandidates: false,
    matchConfidence: 'high',
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    // The still stands in for the capture, so "Your Photo" has something to show.
    normalizedImageUri: alternates.length > 0 ? Image.resolveAssetSource(card.image)?.uri ?? null : null,
    recentlyAdded: false,
    scanID: id,
    shownAtMs: DEV_SCAN_SHOWN_AT_MS,
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    totalCandidateCount: 1 + alternates.length,
    uri: '',
    ...(binderPage ? { binderPage } : {}),
  };
}

function selectionFor(card: DevScanCard): ScanPriceSheetSelection {
  return {
    conditionCode: 'near_mint',
    conditionShortLabel: 'NM',
    marketPrice: card.priceUsd,
    variantIsNonDefault: false,
    variantKey: variantKeyFor(card.printing),
    variantLabel: card.printing,
  };
}

function matrixFor(card: DevScanCard): RawPricingMatrix {
  const market = (share: number) => Number((card.priceUsd * share).toFixed(2));
  return {
    cardID: card.cardId,
    currencyCode: 'USD',
    variants: [
      {
        conditions: [
          { code: 'NM', label: 'Near Mint', market: card.priceUsd },
          { code: 'LP', label: 'Lightly Played', market: market(0.85) },
          { code: 'MP', label: 'Moderately Played', market: market(0.7) },
        ],
        variant: card.printing,
        variantKey: variantKeyFor(card.printing),
      },
    ],
  };
}

/**
 * Printings for the fixture cards, served by the dev repository so each tray
 * row shows its printing link (the row only draws one once the card's matrix
 * lands — the mock catalog has none of these ids).
 */
export const devScannerPricingMatrices: Readonly<Record<string, RawPricingMatrix>> = Object.fromEntries(
  [DEV_SCAN_SINGLE, ...DEV_SCAN_BINDER].map((card) => [card.cardId, matrixFor(card)]),
);

/** Fit a card (normalized-target aspect) inside a box, centered sizing only. */
function fitCard(maxWidth: number, maxHeight: number): { height: number; width: number } {
  const height = Math.min(maxHeight, maxWidth * rawCardReticleAspectRatio);
  return { height, width: height / rawCardReticleAspectRatio };
}

function DevSceneCard({
  image,
  rect,
  tiltDegrees = 0,
}: {
  image: ImageSourcePropType;
  rect: RawScannerFrameRect;
  tiltDegrees?: number;
}) {
  return (
    <View
      style={[
        styles.sceneCard,
        {
          height: rect.height,
          left: rect.x,
          top: rect.y,
          transform: [{ rotate: `${tiltDegrees}deg` }],
          width: rect.width,
        },
      ]}
    >
      {/* Radius + clip on the wrapper: RN Image styles take neither borderCurve
          nor a shadow, and clipping the shadowed view would cut the shadow. */}
      <View style={styles.sceneCardClip}>
        {/* Explicit size: an absoluteFill Image under a transformed parent laid
            out at the asset's intrinsic size on the simulator (clipped corner). */}
        <Image
          source={image}
          style={{ height: rect.height, resizeMode: 'cover', width: rect.width }}
        />
      </View>
    </View>
  );
}

function DevScannerScene({ frame, mode }: { frame: RawScannerFrameRect; mode: DevScannerMode }) {
  if (mode === 'single') {
    const fit = fitCard(frame.width * SINGLE_CARD_FILL, frame.height * SINGLE_CARD_FILL);
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFillObject} testID="dev-scanner-scene">
        <DevSceneCard
          image={DEV_SCAN_SINGLE.image}
          rect={{
            height: fit.height,
            width: fit.width,
            x: frame.x + (frame.width - fit.width) / 2,
            y: frame.y + (frame.height - fit.height) / 2,
          }}
          tiltDegrees={SINGLE_CARD_TILT_DEG}
        />
      </View>
    );
  }

  // Binder mode: the frame IS the page crop, split into the layout's cells
  // exactly as `makeBinderPocketCropRects` splits the capture.
  const cellWidth = frame.width / DEV_BINDER_LAYOUT.columns;
  const cellHeight = frame.height / DEV_BINDER_LAYOUT.rows;
  const fit = fitCard(cellWidth - BINDER_POCKET_GAP * 2, cellHeight - BINDER_POCKET_GAP * 2);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject} testID="dev-scanner-scene">
      {DEV_SCAN_BINDER.map((card, index) => {
        const column = index % DEV_BINDER_LAYOUT.columns;
        const row = Math.floor(index / DEV_BINDER_LAYOUT.columns);
        return (
          <DevSceneCard
            image={card.image}
            key={card.cardId}
            rect={{
              height: fit.height,
              width: fit.width,
              x: frame.x + column * cellWidth + (cellWidth - fit.width) / 2,
              y: frame.y + row * cellHeight + (cellHeight - fit.height) / 2,
            }}
          />
        );
      })}
    </View>
  );
}

export function buildDevScannerPreview(mode: DevScannerMode): ScannerDevPreview {
  const rows = mode === 'single'
    ? [rowFor(DEV_SCAN_SINGLE, 'dev-scan-single', null, DEV_SCAN_BINDER.slice(0, 3))]
    // Pocket order, like `insertBinderPocketRows` leaves a finished page.
    : DEV_SCAN_BINDER.map((card, pocketIndex) => rowFor(
        card,
        binderPocketRowId(DEV_BINDER_PAGE_ID, pocketIndex),
        { layoutId: DEV_BINDER_LAYOUT.id, pageId: DEV_BINDER_PAGE_ID, pocketIndex },
      ));
  const cards = mode === 'single' ? [DEV_SCAN_SINGLE] : DEV_SCAN_BINDER;
  return {
    mode,
    priceSelections: new Map(rows.map((row, index) => [row.id, selectionFor(cards[index])])),
    renderScene: (frame) => <DevScannerScene frame={frame} mode={mode} />,
    surface: DEV_SCAN_SURFACE,
    tray: rows,
  };
}

export function DevScannerScreen({ mode }: { mode: DevScannerMode }) {
  const devPreview = useMemo(() => buildDevScannerPreview(mode), [mode]);
  return (
    // The scanner gates on being the active tab page; the host's bridge says
    // "portfolio", so this one overrides it for the subtree.
    <NativeTabsPageBridge page="scanner">
      {/* Dark viewfinder needs light status-bar icons (mirrors app/(tabs)/scan.tsx). */}
      <StatusBar style="light" />
      <ScannerScreen devPreview={devPreview} onExitToPortfolio={() => undefined} />
    </NativeTabsPageBridge>
  );
}

const styles = StyleSheet.create({
  sceneCard: {
    ...shadows.glassPill,
    backgroundColor: colors.gray900,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    position: 'absolute',
  },
  sceneCardClip: {
    ...StyleSheet.absoluteFillObject,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
});
