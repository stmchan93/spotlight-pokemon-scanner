describe('slab native analysis', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({
    nativeScanPSALabel,
  }: {
    nativeScanPSALabel?: jest.Mock | null;
  } = {}) {
    const parsePSASlabNativeAnalysis = jest.fn((analysis) => ({
      certNumber: analysis.certNumber ?? null,
      grader: 'PSA',
      grade: '9',
      isPSA: true,
    }));
    const buildPSASlabScannerMatchFields = jest.fn(({ nativeAnalysis, parsed }) => ({
      grader: parsed.grader,
      grade: parsed.grade,
      certNumber: nativeAnalysis.certNumber ?? null,
    }));

    const nativeBindings = nativeScanPSALabel === null
      ? null
      : { scanPSALabel: nativeScanPSALabel ?? jest.fn() };

    jest.doMock('expo-modules-core', () => ({
      requireOptionalNativeModule: (name: string) =>
        name === 'SpotlightSlabScanner' ? nativeBindings : null,
    }));
    jest.doMock('@/features/scanner/psa-slab-parser', () => ({
      buildPSASlabScannerMatchFields,
      parsePSASlabNativeAnalysis,
    }));

    let moduleExports: typeof import('@/features/scanner/slab-native-analysis');
    jest.isolateModules(() => {
      moduleExports = require('@/features/scanner/slab-native-analysis');
    });

    return {
      ...moduleExports!,
      buildPSASlabScannerMatchFields,
      parsePSASlabNativeAnalysis,
      nativeScanPSALabel: nativeBindings?.scanPSALabel,
    };
  }

  it('reports availability when the SpotlightSlabScanner native module is registered', () => {
    const available = loadModule({ nativeScanPSALabel: jest.fn() });
    expect(available.isPSASlabNativeAnalysisAvailable()).toBe(true);

    const missing = loadModule({ nativeScanPSALabel: null });
    expect(missing.isPSASlabNativeAnalysisAvailable()).toBe(false);
  });

  it('trims the image uri before invoking the native module', async () => {
    const nativeScanPSALabel = jest.fn(async () => ({
      width: 1200,
      height: 500,
      textBlocks: [],
      barcodes: [],
    }));
    const moduleExports = loadModule({ nativeScanPSALabel });

    const result = await moduleExports.analyzePSASlabLabelNative('  file:///slab.jpg  ');

    expect(nativeScanPSALabel).toHaveBeenCalledWith('file:///slab.jpg');
    expect(result).toEqual({
      width: 1200,
      height: 500,
      textBlocks: [],
      barcodes: [],
    });
  });

  it('rejects blank image uris before touching native code', async () => {
    const nativeScanPSALabel = jest.fn();
    const moduleExports = loadModule({ nativeScanPSALabel });

    await expect(moduleExports.analyzePSASlabLabelNative('   ')).rejects.toMatchObject({
      code: 'invalid_image_uri',
      name: 'PSASlabNativeAnalysisError',
    });
    expect(nativeScanPSALabel).not.toHaveBeenCalled();
  });

  it('throws a native-module-unavailable error when the bridge is missing', async () => {
    const moduleExports = loadModule({ nativeScanPSALabel: null });

    await expect(moduleExports.analyzePSASlabLabelNative('file:///slab.jpg')).rejects.toMatchObject({
      code: 'native_module_unavailable',
      message: expect.stringContaining('SpotlightSlabScanner'),
    });
  });

  it('wraps native failures with a slab analysis error', async () => {
    const moduleExports = loadModule({
      nativeScanPSALabel: jest.fn(async () => {
        throw new Error('ml kit text recognition failed');
      }),
    });

    await expect(moduleExports.analyzePSASlabLabelNative('file:///slab.jpg')).rejects.toMatchObject({
      code: 'native_analysis_failed',
      message: expect.stringContaining('ml kit text recognition failed'),
    });
  });

  it('builds parsed scanner match fields from the native analysis result', async () => {
    const nativeAnalysis = {
      width: 1200,
      height: 500,
      textBlocks: [{ text: 'PSA 70539858', boundingBox: { x: 100, y: 40, width: 300, height: 40 } }],
      barcodes: [],
      certNumber: '70539858',
    };
    const nativeScanPSALabel = jest.fn(async () => nativeAnalysis);
    const moduleExports = loadModule({ nativeScanPSALabel });

    const result = await moduleExports.analyzePSASlabCapture('file:///slab.jpg');

    expect(moduleExports.parsePSASlabNativeAnalysis).toHaveBeenCalledWith(nativeAnalysis);
    expect(moduleExports.buildPSASlabScannerMatchFields).toHaveBeenCalledWith({
      nativeAnalysis,
      parsed: {
        certNumber: '70539858',
        grader: 'PSA',
        grade: '9',
        isPSA: true,
      },
    });
    expect(result).toEqual({
      nativeAnalysis,
      parsed: {
        certNumber: '70539858',
        grader: 'PSA',
        grade: '9',
        isPSA: true,
      },
      scannerMatchFields: {
        certNumber: '70539858',
        grader: 'PSA',
        grade: '9',
      },
    });
  });
});
