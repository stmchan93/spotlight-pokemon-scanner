import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type {
  ScanSourceImageCrop,
  ScanSourceImageDimensions,
} from '@/features/scanner/scan-candidate-review-session';
import { type NormalizedScannerTarget, makeOrientationFixedSourceImageDimensions } from '@/features/scanner/scanner-normalized-target';
import {
  slabLabelAnalysisBottomRatio,
  slabLabelDividerRatio,
} from '@/features/scanner/raw-scanner-capture-surface';

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

type ImageRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

const normalizedTargetCompress = 0.88;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundPositiveInt(value: number) {
  return Math.max(1, Math.round(value));
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

function makeSlabReticleSourceImageCrop({
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

  return {
    height: roundPositiveInt(clampedHeight),
    width: roundPositiveInt(clampedWidth),
    x: Math.round(clampedX),
    y: Math.round(clampedY),
  };
}

function makeSlabLabelSourceImageCrop(reticleCrop: ScanSourceImageCrop): ScanSourceImageCrop {
  const labelHeight = roundPositiveInt(reticleCrop.height * slabLabelAnalysisBottomRatio);
  const labelY = Math.round(clamp(reticleCrop.y, 0, Math.max(0, reticleCrop.y + reticleCrop.height - labelHeight)));

  return {
    height: labelHeight,
    width: reticleCrop.width,
    x: reticleCrop.x,
    y: labelY,
  };
}

function makeSlabGuideLineSourceImageCrop(reticleCrop: ScanSourceImageCrop): ImageRect {
  const guideHeight = roundPositiveInt(Math.max(2, reticleCrop.height * 0.02));
  const guideY = Math.round(reticleCrop.y + (reticleCrop.height * slabLabelDividerRatio) - (guideHeight / 2));

  return {
    height: guideHeight,
    width: reticleCrop.width,
    x: reticleCrop.x,
    y: clamp(guideY, reticleCrop.y, reticleCrop.y + reticleCrop.height - guideHeight),
  };
}

export async function buildSlabScannerTarget({
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
  const reticleCrop = makeSlabReticleSourceImageCrop({
    previewLayout,
    reticle,
    sourceImageDimensions: cropBasisDimensions,
  });
  if (!reticleCrop) {
    return null;
  }

  const sourceImageCrop = makeSlabLabelSourceImageCrop(reticleCrop);
  const guideLineCrop = makeSlabGuideLineSourceImageCrop(reticleCrop);

  const context = ImageManipulator.manipulate(sourceImageUri);
  let normalizedImageRef: {
    height: number;
    release?: () => void;
    saveAsync: (options?: {
      base64?: boolean;
      compress?: number;
      format?: SaveFormat;
    }) => Promise<{ base64?: string; height: number; uri: string; width: number }>;
    width: number;
  } | null = null;
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

export function makeSlabGuidePreviewY({
  reticleHeight,
  reticleY,
}: {
  reticleHeight: number;
  reticleY: number;
}) {
  return reticleY + (reticleHeight * slabLabelDividerRatio);
}

export function makeSlabGuideSourceImageCrop({
  reticleCrop,
}: {
  reticleCrop: ScanSourceImageCrop;
}) {
  return makeSlabGuideLineSourceImageCrop(reticleCrop);
}
