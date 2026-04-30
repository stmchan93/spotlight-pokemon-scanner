import { Asset } from 'expo-asset';
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';

import type { ScanSourceImageCrop, ScanSourceImageDimensions } from '@/features/scanner/scan-candidate-review-session';
import {
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
  type NormalizedScannerTarget,
} from '@/features/scanner/scanner-normalized-target';

const rawScannerSmokeFixtureModule = require('../../../assets/scanner-smoke/raw-dark-weezing-runtime-normalized.jpg');

const smokeFixtureDimensions: ScanSourceImageDimensions = {
  height: rawCardNormalizedTargetHeight,
  width: rawCardNormalizedTargetWidth,
};

const smokeFixtureCrop: ScanSourceImageCrop = {
  height: rawCardNormalizedTargetHeight,
  width: rawCardNormalizedTargetWidth,
  x: 0,
  y: 0,
};

export async function loadRawScannerSmokeFixture(): Promise<NormalizedScannerTarget> {
  const asset = Asset.fromModule(rawScannerSmokeFixtureModule);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }

  const fixtureUri = asset.localUri ?? asset.uri;
  if (!fixtureUri) {
    throw new Error('scanner_smoke_fixture_uri_unavailable');
  }

  const normalizedImageBase64 = await readAsStringAsync(fixtureUri, {
    encoding: EncodingType.Base64,
  });
  if (!normalizedImageBase64) {
    throw new Error('scanner_smoke_fixture_base64_unavailable');
  }

  return {
    nativeSourceImageDimensions: smokeFixtureDimensions,
    normalizationRotationDegrees: 0,
    normalizedImageBase64,
    normalizedImageDimensions: smokeFixtureDimensions,
    normalizedImageUri: fixtureUri,
    sourceImageCrop: smokeFixtureCrop,
  };
}
