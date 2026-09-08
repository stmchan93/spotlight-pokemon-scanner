import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { ScanSourceImageCrop, ScanSourceImageDimensions } from '@/features/scanner/scan-candidate-review-session';

export const rawCardNormalizedTargetWidth = 630;
export const rawCardNormalizedTargetHeight = 880;
export const rawCardReticleAspectRatio = rawCardNormalizedTargetHeight / rawCardNormalizedTargetWidth;

const rawCardTargetWidthToHeightRatio = rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight;
const normalizedTargetCompress = 0.82;

type ImageRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type PreviewLayout = {
  height: number;
  width: number;
};

type ReticleLayout = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type NormalizedScannerTarget = {
  /**
   * Inline base64 of the normalized JPEG. Null on the scanner hot path — scans
   * upload via multipart file streaming from `normalizedImageUri`, so base64 is
   * only produced when a caller opts in (`includeBase64`, e.g. labeling).
   */
  normalizedImageBase64: string | null;
  normalizedImageDimensions: ScanSourceImageDimensions;
  normalizedImageUri: string;
  nativeSourceImageDimensions: ScanSourceImageDimensions;
  normalizationRotationDegrees: number;
  sourceImageCrop: ScanSourceImageCrop;
};

export function makeOrientationFixedSourceImageDimensions(
  sourceImageDimensions: ScanSourceImageDimensions,
): ScanSourceImageDimensions {
  if (sourceImageDimensions.width > sourceImageDimensions.height) {
    return {
      height: sourceImageDimensions.width,
      width: sourceImageDimensions.height,
    };
  }

  return sourceImageDimensions;
}

function needsPortraitRotation({
  nativeSourceImageDimensions,
  reportedSourceImageDimensions,
}: {
  nativeSourceImageDimensions: ScanSourceImageDimensions;
  reportedSourceImageDimensions: ScanSourceImageDimensions;
}) {
  const nativeIsLandscape = nativeSourceImageDimensions.width > nativeSourceImageDimensions.height;
  const reportedIsPortrait = reportedSourceImageDimensions.height >= reportedSourceImageDimensions.width;
  return nativeIsLandscape && reportedIsPortrait;
}

function roundPositiveInt(value: number) {
  return Math.max(1, Math.round(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function centerAdjustedOrigin(origin: number, currentLength: number, nextLength: number, maxLength: number) {
  const centered = origin + (currentLength - nextLength) / 2;
  return clamp(centered, 0, Math.max(0, maxLength - nextLength));
}

function makeCanonicalCropRect(
  crop: ScanSourceImageCrop,
  sourceImageDimensions: ScanSourceImageDimensions,
  // 'landscape' = the card lies on its side in this rect (sideways binder
  // layouts); the canonical aspect is the card's, turned 90°.
  orientation: 'portrait' | 'landscape' = 'portrait',
): ScanSourceImageCrop {
  let width = crop.width;
  let height = crop.height;
  let x = crop.x;
  let y = crop.y;
  const targetRatio = orientation === 'landscape'
    ? 1 / rawCardTargetWidthToHeightRatio
    : rawCardTargetWidthToHeightRatio;

  const currentRatio = width / height;
  if (Math.abs(currentRatio - targetRatio) > 0.0001) {
    if (currentRatio > targetRatio) {
      const nextWidth = height * targetRatio;
      x = centerAdjustedOrigin(x, width, nextWidth, sourceImageDimensions.width);
      width = nextWidth;
    } else {
      const nextHeight = width / targetRatio;
      y = centerAdjustedOrigin(y, height, nextHeight, sourceImageDimensions.height);
      height = nextHeight;
    }
  }

  const roundedWidth = roundPositiveInt(width);
  const roundedHeight = roundPositiveInt(height);
  const roundedX = Math.round(clamp(x, 0, Math.max(0, sourceImageDimensions.width - roundedWidth)));
  const roundedY = Math.round(clamp(y, 0, Math.max(0, sourceImageDimensions.height - roundedHeight)));

  return {
    height: roundedHeight,
    width: roundedWidth,
    x: roundedX,
    y: roundedY,
  };
}

export function makeReticleSourceImageCrop({
  previewLayout,
  reticle,
  sourceImageDimensions,
}: {
  previewLayout: PreviewLayout;
  reticle: ReticleLayout;
  sourceImageDimensions: ScanSourceImageDimensions;
}): ScanSourceImageCrop | null {
  const { width: previewWidth, height: previewHeight } = previewLayout;
  const { width: imageWidth, height: imageHeight } = sourceImageDimensions;

  if (previewWidth <= 0 || previewHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const scale = Math.max(previewWidth / imageWidth, previewHeight / imageHeight);
  const displayedWidth = imageWidth * scale;
  const displayedHeight = imageHeight * scale;
  const offsetX = (previewWidth - displayedWidth) / 2;
  const offsetY = (previewHeight - displayedHeight) / 2;

  const cropX = (reticle.x - offsetX) / scale;
  const cropY = (reticle.y - offsetY) / scale;
  const cropWidth = reticle.width / scale;
  const cropHeight = reticle.height / scale;

  const clampedX = Math.max(0, Math.min(cropX, imageWidth - 1));
  const clampedY = Math.max(0, Math.min(cropY, imageHeight - 1));
  const clampedWidth = Math.max(1, Math.min(cropWidth, imageWidth - clampedX));
  const clampedHeight = Math.max(1, Math.min(cropHeight, imageHeight - clampedY));

  return makeCanonicalCropRect({
    height: clampedHeight,
    width: clampedWidth,
    x: clampedX,
    y: clampedY,
  }, sourceImageDimensions);
}

export const binderPageGridSize = 3;

export type BinderPageLayoutId = 'pockets-9' | 'pockets-12';

/**
 * One binder-page framing. The phone is always portrait and the sensor's short
 * side spans the reticle, so COLUMNS are what spend resolution: three columns
 * keep every pocket above the 360px zero-loss line measured in
 * docs/binder-scan-feasibility-2026-08-28.md, which is why every layout is
 * three across and only the row count grows.
 *
 * `cropRotationDegrees` = 90 means the cards lie SIDEWAYS in the frame (an open
 * binder turned so the card tops point left); each pocket cell is landscape
 * and the crop is rotated clockwise to upright before matching. An exact
 * 90° rotate is a pixel transpose, so it costs the matcher nothing.
 */
export type BinderPageLayout = {
  id: BinderPageLayoutId;
  /** Pocket count as the user thinks of it — "12 cards", never "3×4". */
  label: string;
  columns: number;
  rows: number;
  cropRotationDegrees: 0 | 90;
  /** Framing hint shown in place of "Tap to scan" while this layout is armed. */
  hint: string | null;
};

export const binderPageLayouts: readonly BinderPageLayout[] = [
  // The classic 9-pocket page.
  { id: 'pockets-9', label: '9 cards', columns: 3, rows: 3, cropRotationDegrees: 0, hint: null },
  // Ultra Pro-style 12-pocket page: 3 across, 4 down, upright.
  { id: 'pockets-12', label: '12 cards', columns: 3, rows: 4, cropRotationDegrees: 0, hint: null },
  // No 18: it was an open binder turned sideways (3 × 6, cropRotationDegrees
  // 90, "card tops to the left"), and asking for that at a show table costs
  // more scans than it gains. The sideways crop path stays built and tested
  // for a future wide 12-pocket binder (4 across × 3 down).
];

export const defaultBinderPageLayoutId: BinderPageLayoutId = 'pockets-9';

export function binderPageLayoutById(id: string | null | undefined): BinderPageLayout {
  return binderPageLayouts.find((layout) => layout.id === id) ?? binderPageLayouts[0];
}

export function binderPagePocketCount(layout: BinderPageLayout): number {
  return layout.columns * layout.rows;
}

/**
 * Height ÷ width of the page crop for a layout: cells are card-aspect when
 * upright and the inverse when the cards lie sideways.
 */
export function binderPageAspectRatio(layout: BinderPageLayout): number {
  const cellAspect = layout.cropRotationDegrees === 90
    ? 1 / rawCardReticleAspectRatio
    : rawCardReticleAspectRatio;
  return (layout.rows * cellAspect) / layout.columns;
}

// Inset each pocket crop by this fraction of the cell so sleeve edges and
// inter-pocket gaps stay out of the matcher input. Thirds-plus-inset scored
// 8/8 exact printings on a real page — docs/binder-scan-feasibility-2026-08-28.md.
const binderPocketInsetFraction = 0.025;

/**
 * The pocket crop rects for a binder page, row-major from the top-left. The
 * canonical page rect the reticle produces subdivides into cells of the
 * layout's aspect; each cell is then re-canonicalized so rounding never drifts
 * the aspect. Sideways layouts produce landscape cells — the rotate to upright
 * happens on the rendered crop, not here.
 */
export function makeBinderPocketCropRects(
  pageCrop: ScanSourceImageCrop,
  sourceImageDimensions: ScanSourceImageDimensions,
  layout: BinderPageLayout = binderPageLayouts[0],
): ScanSourceImageCrop[] {
  const cellWidth = pageCrop.width / layout.columns;
  const cellHeight = pageCrop.height / layout.rows;
  const insetX = cellWidth * binderPocketInsetFraction;
  const insetY = cellHeight * binderPocketInsetFraction;
  const rects: ScanSourceImageCrop[] = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let column = 0; column < layout.columns; column++) {
      rects.push(makeCanonicalCropRect({
        height: cellHeight - insetY * 2,
        width: cellWidth - insetX * 2,
        x: pageCrop.x + column * cellWidth + insetX,
        y: pageCrop.y + row * cellHeight + insetY,
      }, sourceImageDimensions, layout.cropRotationDegrees === 90 ? 'landscape' : 'portrait'));
    }
  }
  return rects;
}

export type BinderPageImage = {
  height: number;
  uri: string;
  width: number;
};

export type BinderPageTargets = {
  /** The page itself (reticle crop), downscaled for the on-screen review overlay. */
  pageImage: BinderPageImage;
  /** Nine pocket targets in reading order (row-major, top-left first). */
  targets: NormalizedScannerTarget[];
};

// Sized for SERVER-SIDE cropping: columns × the matcher's input width (630px)
// upright, or columns × its input height (880px) when the cards lie sideways
// (the cell's long side becomes the card's height). Capped at the source crop
// width so a smaller reticle never upscales.
function binderPageImageWidth(layout: BinderPageLayout): number {
  return layout.columns * (layout.cropRotationDegrees === 90
    ? rawCardNormalizedTargetHeight
    : rawCardNormalizedTargetWidth);
}

/**
 * Binder-page capture: ONE full-res decode, nine pocket crops in reading order
 * (row-major, top-left first), each normalized to the standard 630x880 target.
 * Mirrors `buildNormalizedScannerTarget` — including the single-rotate rule:
 * when the photo needs the portrait fix, the rotation is rendered ONCE and the
 * nine crops share the rotated ref, not nine rotate passes.
 */
export async function buildBinderPocketTargets({
  layout = binderPageLayouts[0],
  onPageImageReady,
  previewLayout,
  reticle,
  sourceImageDimensions,
  sourceImageUri,
}: {
  layout?: BinderPageLayout;
  /**
   * Fired the moment the page image file exists — BEFORE the nine pocket crop
   * renders (~several seconds of on-device 4K work). The caller starts the
   * batch upload here; the crops only feed thumbnails and training artifacts,
   * so they must never sit on the network critical path.
   */
  onPageImageReady?: (pageImage: BinderPageImage) => void;
  previewLayout: PreviewLayout;
  reticle: ReticleLayout;
  sourceImageDimensions: ScanSourceImageDimensions;
  sourceImageUri: string;
}): Promise<BinderPageTargets | null> {
  const sourceContext = ImageManipulator.manipulate(sourceImageUri);
  let sourceImage: Awaited<ReturnType<typeof sourceContext.renderAsync>> | null = null;
  let rotateContext: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  let rotatedImage: Awaited<ReturnType<typeof sourceContext.renderAsync>> | null = null;
  const cropContexts: Array<ReturnType<typeof ImageManipulator.manipulate>> = [];
  const cropRefs: Array<Awaited<ReturnType<typeof sourceContext.renderAsync>>> = [];

  try {
    sourceImage = await sourceContext.renderAsync();
    const nativeSourceImageDimensions: ScanSourceImageDimensions = {
      height: sourceImage.height,
      width: sourceImage.width,
    };
    const normalizationRotationDegrees = needsPortraitRotation({
      nativeSourceImageDimensions,
      reportedSourceImageDimensions: sourceImageDimensions,
    })
      ? 90
      : 0;
    const cropBasisDimensions = normalizationRotationDegrees === 0
      ? nativeSourceImageDimensions
      : makeOrientationFixedSourceImageDimensions(nativeSourceImageDimensions);
    const pageCrop = makeReticleSourceImageCrop({
      previewLayout,
      reticle,
      sourceImageDimensions: cropBasisDimensions,
    });
    if (!pageCrop) {
      return null;
    }

    let cropSource: NonNullable<typeof sourceImage> = sourceImage;
    if (normalizationRotationDegrees !== 0) {
      rotateContext = ImageManipulator.manipulate(sourceImage);
      rotateContext.rotate(normalizationRotationDegrees);
      rotatedImage = await rotateContext.renderAsync();
      cropSource = rotatedImage;
    }

    // The page review overlay draws chips over THIS image, so it must be the
    // exact rect the pockets were cut from — the chips then sit on a plain
    // thirds grid with no per-pocket geometry to carry around.
    const pageContext = ImageManipulator.manipulate(cropSource);
    cropContexts.push(pageContext);
    pageContext.crop({
      originX: pageCrop.x,
      originY: pageCrop.y,
      width: pageCrop.width,
      height: pageCrop.height,
    });
    const pageRenderWidth = Math.min(binderPageImageWidth(layout), Math.round(pageCrop.width));
    pageContext.resize({
      width: pageRenderWidth,
      height: Math.round((pageRenderWidth * pageCrop.height) / pageCrop.width),
    });
    const pageRef = await pageContext.renderAsync();
    cropRefs.push(pageRef);
    const pageImageFile = await pageRef.saveAsync({
      base64: false,
      // Lighter than the pocket targets: this file is UPLOADED over the phone
      // uplink (measured ~1MB+ at 0.82 for a detailed binder photo — the
      // biggest single cost of a page scan). The matcher is robust to JPEG q
      // and the server re-encodes the crops it makes from this.
      compress: 0.6,
      format: SaveFormat.JPEG,
    });
    if (!pageImageFile?.uri) {
      return null;
    }
    const pageImage: BinderPageImage = {
      height: pageImageFile.height,
      uri: pageImageFile.uri,
      width: pageImageFile.width,
    };
    onPageImageReady?.(pageImage);

    const pocketCrops = makeBinderPocketCropRects(pageCrop, cropBasisDimensions, layout);
    const targets: NormalizedScannerTarget[] = [];
    for (const pocketCrop of pocketCrops) {
      const cropContext = ImageManipulator.manipulate(cropSource);
      cropContexts.push(cropContext);
      cropContext.crop({
        originX: pocketCrop.x,
        originY: pocketCrop.y,
        width: pocketCrop.width,
        height: pocketCrop.height,
      });
      if (layout.cropRotationDegrees === 90) {
        // Card tops point LEFT in the frame; a clockwise quarter turn stands
        // the card up. Positive = clockwise in expo-image-manipulator.
        cropContext.rotate(90);
      }
      cropContext.resize({
        width: rawCardNormalizedTargetWidth,
        height: rawCardNormalizedTargetHeight,
      });
      const cropRef = await cropContext.renderAsync();
      cropRefs.push(cropRef);
      const normalizedImage = await cropRef.saveAsync({
        base64: false,
        compress: normalizedTargetCompress,
        format: SaveFormat.JPEG,
      });
      if (!normalizedImage?.uri) {
        return null;
      }
      targets.push({
        normalizedImageBase64: null,
        normalizedImageDimensions: {
          height: normalizedImage.height,
          width: normalizedImage.width,
        },
        normalizedImageUri: normalizedImage.uri,
        nativeSourceImageDimensions,
        normalizationRotationDegrees,
        sourceImageCrop: pocketCrop,
      });
    }
    return { pageImage, targets };
  } finally {
    for (const ref of cropRefs) {
      ref.release?.();
    }
    for (const context of cropContexts) {
      context.release?.();
    }
    rotatedImage?.release?.();
    rotateContext?.release?.();
    sourceImage?.release?.();
    sourceContext.release?.();
  }
}

export async function buildNormalizedScannerTarget({
  includeBase64 = false,
  previewLayout,
  reticle,
  sourceImageDimensions,
  sourceImageUri,
}: {
  /**
   * Materialize the normalized JPEG as base64 too. Default OFF: the scanner
   * uploads the saved file via multipart streaming, so pulling ~150KB of
   * base64 through the JS thread per scan is pure waste. Labeling (which posts
   * inline base64 payloads) opts in.
   */
  includeBase64?: boolean;
  previewLayout: PreviewLayout;
  reticle: ReticleLayout;
  sourceImageDimensions: ScanSourceImageDimensions;
  sourceImageUri: string;
}): Promise<NormalizedScannerTarget | null> {
  // ONE full-res decode per capture. `manipulate` accepts an already-decoded
  // native image (SharedRef<'image'>) as its source, so the crop pass below
  // re-uses this ref instead of re-reading the file. The previous shape decoded
  // the same JPEG TWICE per shutter tap — once through a throwaway context that
  // existed only to read the file's true pixel dimensions (the reported camera
  // dimensions can disagree, which is what `needsPortraitRotation` resolves),
  // then again to crop it. At FHD, on a burst-scanning session, that second
  // decode is pure battery burn for a width and a height.
  const sourceContext = ImageManipulator.manipulate(sourceImageUri);
  let sourceImage: Awaited<ReturnType<typeof sourceContext.renderAsync>> | null = null;
  let cropContext: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  let normalizedImageRef: Awaited<ReturnType<typeof sourceContext.renderAsync>> | null = null;

  try {
    sourceImage = await sourceContext.renderAsync();
    const nativeSourceImageDimensions: ScanSourceImageDimensions = {
      height: sourceImage.height,
      width: sourceImage.width,
    };
    const normalizationRotationDegrees = needsPortraitRotation({
      nativeSourceImageDimensions,
      reportedSourceImageDimensions: sourceImageDimensions,
    })
      ? 90
      : 0;
    const cropBasisDimensions = normalizationRotationDegrees === 0
      ? nativeSourceImageDimensions
      : makeOrientationFixedSourceImageDimensions(nativeSourceImageDimensions);
    const sourceImageCrop = makeReticleSourceImageCrop({
      previewLayout,
      reticle,
      sourceImageDimensions: cropBasisDimensions,
    });
    if (!sourceImageCrop) {
      return null;
    }

    cropContext = ImageManipulator.manipulate(sourceImage);
    if (normalizationRotationDegrees !== 0) {
      cropContext.rotate(normalizationRotationDegrees);
    }
    cropContext.crop({
      originX: sourceImageCrop.x,
      originY: sourceImageCrop.y,
      width: sourceImageCrop.width,
      height: sourceImageCrop.height,
    });
    cropContext.resize({
      width: rawCardNormalizedTargetWidth,
      height: rawCardNormalizedTargetHeight,
    });

    normalizedImageRef = await cropContext.renderAsync();
    const normalizedImage = await normalizedImageRef.saveAsync({
      base64: includeBase64,
      compress: normalizedTargetCompress,
      format: SaveFormat.JPEG,
    });

    if (!normalizedImage?.uri || (includeBase64 && !normalizedImage.base64)) {
      return null;
    }

    return {
      normalizedImageBase64: normalizedImage.base64 ?? null,
      normalizedImageDimensions: {
        height: normalizedImage.height,
        width: normalizedImage.width,
      },
      normalizedImageUri: normalizedImage.uri,
      nativeSourceImageDimensions,
      normalizationRotationDegrees,
      sourceImageCrop,
    };
  } finally {
    // The source ref has to outlive the crop render (it IS the crop's source),
    // so every handle is released together here rather than per-stage.
    normalizedImageRef?.release?.();
    cropContext?.release?.();
    sourceImage?.release?.();
    sourceContext.release?.();
  }
}
