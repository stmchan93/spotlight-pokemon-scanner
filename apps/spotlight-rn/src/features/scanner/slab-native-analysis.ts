import {
  buildPSASlabScannerMatchFields,
  parsePSASlabNativeAnalysis,
  type ParsedPSASlabLabel,
  type PSASlabNativeAnalysis,
  type PSASlabScannerMatchFields,
} from '@/features/scanner/psa-slab-parser';
import {
  isSlabScannerNativeAvailable,
  scanPSALabel,
  SLAB_SCANNER_NATIVE_MODULE_NAME,
} from '@/features/scanner/slab-scanner-native';

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

export function isPSASlabNativeAnalysisAvailable() {
  return isSlabScannerNativeAvailable();
}

export async function analyzePSASlabLabelNative(imageUri: string) {
  const trimmedUri = imageUri.trim();
  if (trimmedUri.length === 0) {
    throw new PSASlabNativeAnalysisError(
      'Expected a local image URI for slab analysis.',
      'invalid_image_uri',
    );
  }

  if (!isSlabScannerNativeAvailable()) {
    throw new PSASlabNativeAnalysisError(
      `Native module ${SLAB_SCANNER_NATIVE_MODULE_NAME} is not registered in this build.`,
      'native_module_unavailable',
    );
  }

  try {
    const analysis = await scanPSALabel(trimmedUri);
    if (__DEV__ && process.env.NODE_ENV !== 'test') {
      // Fixture-capture aid for PR 5: scrape Metro logs for `[slab-fixture-dump]`
      // lines and convert each to a JSON file under __tests__/fixtures/psa-slab-mlkit/.
      // eslint-disable-next-line no-console
      console.log(
        '[slab-fixture-dump]',
        JSON.stringify({ imageUri: trimmedUri, analysis }),
      );
    }
    return analysis;
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
