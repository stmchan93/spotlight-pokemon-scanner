import { NativeModules, Platform } from 'react-native';

import {
  buildPSASlabScannerMatchFields,
  parsePSASlabNativeAnalysis,
  type ParsedPSASlabLabel,
  type PSASlabNativeAnalysis,
  type PSASlabScannerMatchFields,
} from '@/features/scanner/psa-slab-parser';

const nativeModuleName = 'SpotlightPSASlabAnalysis';

type SpotlightPSASlabAnalysisModule = {
  analyzeLabel(imageUri: string): Promise<PSASlabNativeAnalysis>;
};

export class PSASlabNativeAnalysisError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'native_module_unavailable'
      | 'unsupported_platform'
      | 'invalid_image_uri'
      | 'native_analysis_failed',
  ) {
    super(message);
    this.name = 'PSASlabNativeAnalysisError';
  }
}

export type PSASlabCaptureAnalysis = {
  nativeAnalysis: PSASlabNativeAnalysis;
  parsed: ParsedPSASlabLabel;
  scannerMatchFields: PSASlabScannerMatchFields;
};

function getNativeModule() {
  const moduleCandidate = NativeModules[nativeModuleName] as SpotlightPSASlabAnalysisModule | undefined;
  return moduleCandidate ?? null;
}

export function isPSASlabNativeAnalysisAvailable() {
  return Platform.OS === 'ios' && getNativeModule() != null;
}

export async function analyzePSASlabLabelNative(imageUri: string) {
  const trimmedUri = imageUri.trim();
  if (trimmedUri.length === 0) {
    throw new PSASlabNativeAnalysisError(
      'Expected a local image URI for slab analysis.',
      'invalid_image_uri',
    );
  }

  if (Platform.OS !== 'ios') {
    throw new PSASlabNativeAnalysisError(
      `PSA slab native analysis is only available on iOS. Current platform: ${Platform.OS}.`,
      'unsupported_platform',
    );
  }

  const nativeModule = getNativeModule();
  if (!nativeModule) {
    throw new PSASlabNativeAnalysisError(
      `Native module ${nativeModuleName} is not registered in this build.`,
      'native_module_unavailable',
    );
  }

  try {
    return await nativeModule.analyzeLabel(trimmedUri);
  } catch (error) {
    const nativeMessage = error instanceof Error ? error.message : String(error);
    throw new PSASlabNativeAnalysisError(
      `Native PSA slab analysis failed: ${nativeMessage}`,
      'native_analysis_failed',
    );
  }
}

export async function analyzePSASlabCapture(imageUri: string): Promise<PSASlabCaptureAnalysis> {
  const nativeAnalysis = await analyzePSASlabLabelNative(imageUri);
  const parsed = parsePSASlabNativeAnalysis(nativeAnalysis);
  const scannerMatchFields = buildPSASlabScannerMatchFields({
    nativeAnalysis,
    parsed,
  });

  return {
    nativeAnalysis,
    parsed,
    scannerMatchFields,
  };
}
