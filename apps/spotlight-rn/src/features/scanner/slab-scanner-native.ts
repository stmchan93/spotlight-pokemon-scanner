import { requireOptionalNativeModule } from 'expo-modules-core';

export type SlabScannerBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SlabScannerTextBlock = {
  text: string;
  boundingBox?: SlabScannerBoundingBox | null;
};

export type SlabScannerBarcode = {
  rawValue: string;
  format?: string | null;
  boundingBox?: SlabScannerBoundingBox | null;
};

export type SlabScannerNativeAnalysis = {
  width: number;
  height: number;
  textBlocks: SlabScannerTextBlock[];
  barcodes: SlabScannerBarcode[];
};

export const SLAB_SCANNER_NATIVE_MODULE_NAME = 'SpotlightSlabScanner';

type NativeBindings = {
  scanPSALabel(imageUri: string): Promise<SlabScannerNativeAnalysis>;
};

const nativeModule = requireOptionalNativeModule<NativeBindings>(SLAB_SCANNER_NATIVE_MODULE_NAME);

export function isSlabScannerNativeAvailable(): boolean {
  return nativeModule != null;
}

export async function scanPSALabel(imageUri: string): Promise<SlabScannerNativeAnalysis> {
  if (!nativeModule) {
    throw new Error(
      `Native module ${SLAB_SCANNER_NATIVE_MODULE_NAME} is not registered in this build. `
        + 'Build a custom dev client (Expo Go is not supported).',
    );
  }

  if (typeof imageUri !== 'string') {
    throw new Error('scanPSALabel requires a string imageUri.');
  }

  const trimmed = imageUri.trim();
  if (trimmed.length === 0) {
    throw new Error('scanPSALabel requires a non-empty imageUri.');
  }

  return await nativeModule.scanPSALabel(trimmed);
}
