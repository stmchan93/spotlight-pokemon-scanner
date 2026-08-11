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
): ScanSourceImageCrop {
  let width = crop.width;
  let height = crop.height;
  let x = crop.x;
  let y = crop.y;

  const currentRatio = width / height;
  if (Math.abs(currentRatio - rawCardTargetWidthToHeightRatio) > 0.0001) {
    if (currentRatio > rawCardTargetWidthToHeightRatio) {
      const nextWidth = height * rawCardTargetWidthToHeightRatio;
      x = centerAdjustedOrigin(x, width, nextWidth, sourceImageDimensions.width);
      width = nextWidth;
    } else {
      const nextHeight = width / rawCardTargetWidthToHeightRatio;
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
