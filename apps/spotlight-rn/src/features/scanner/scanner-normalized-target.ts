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
  normalizedImageBase64: string;
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

async function loadNativeSourceImageDimensions(sourceImageUri: string): Promise<ScanSourceImageDimensions> {
  const context = ImageManipulator.manipulate(sourceImageUri);
  let image: { height: number; release?: () => void; width: number } | null = null;

  try {
    image = await context.renderAsync();
    return {
      height: image.height,
      width: image.width,
    };
  } finally {
    image?.release?.();
    context.release?.();
  }
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
  previewLayout,
  reticle,
  sourceImageDimensions,
  sourceImageUri,
}: {
  previewLayout: PreviewLayout;
  reticle: ReticleLayout;
  sourceImageDimensions: ScanSourceImageDimensions;
  sourceImageUri: string;
}): Promise<NormalizedScannerTarget | null> {
  const nativeSourceImageDimensions = await loadNativeSourceImageDimensions(sourceImageUri);
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

  const context = ImageManipulator.manipulate(sourceImageUri);
  let normalizedImageRef: { height: number; release?: () => void; saveAsync: (options?: { base64?: boolean; compress?: number; format?: SaveFormat }) => Promise<{ base64?: string; height: number; uri: string; width: number }>; width: number } | null = null;
  let normalizedImage: { base64?: string; height: number; uri: string; width: number } | null = null;

  try {
    if (normalizationRotationDegrees !== 0) {
      context.rotate(normalizationRotationDegrees);
    }
    context.crop({
      originX: sourceImageCrop.x,
      originY: sourceImageCrop.y,
      width: sourceImageCrop.width,
      height: sourceImageCrop.height,
    });
    context.resize({
      width: rawCardNormalizedTargetWidth,
      height: rawCardNormalizedTargetHeight,
    });

    normalizedImageRef = await context.renderAsync();
    normalizedImage = await normalizedImageRef.saveAsync({
      base64: true,
      compress: normalizedTargetCompress,
      format: SaveFormat.JPEG,
    });
  } finally {
    normalizedImageRef?.release?.();
    context.release?.();
  }

  if (!normalizedImage?.base64) {
    return null;
  }

  return {
    normalizedImageBase64: normalizedImage.base64,
    normalizedImageDimensions: {
      height: normalizedImage.height,
      width: normalizedImage.width,
    },
    normalizedImageUri: normalizedImage.uri,
    nativeSourceImageDimensions,
    normalizationRotationDegrees,
    sourceImageCrop,
  };
}
