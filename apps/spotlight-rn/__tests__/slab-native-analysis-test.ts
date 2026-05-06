describe('slab native analysis', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({
    nativeAnalyzeLabel,
    os = 'ios',
  }: {
    nativeAnalyzeLabel?: jest.Mock;
    os?: string;
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

    jest.doMock('react-native', () => ({
      NativeModules: nativeAnalyzeLabel
        ? {
            SpotlightPSASlabAnalysis: {
              analyzeLabel: nativeAnalyzeLabel,
            },
          }
        : {},
      Platform: {
        OS: os,
      },
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
    };
  }

  it('reports availability only when the iOS native module is registered', () => {
    const iosAvailable = loadModule({
      nativeAnalyzeLabel: jest.fn(),
      os: 'ios',
    });
    expect(iosAvailable.isPSASlabNativeAnalysisAvailable()).toBe(true);

    const androidUnavailable = loadModule({
      nativeAnalyzeLabel: jest.fn(),
      os: 'android',
    });
    expect(androidUnavailable.isPSASlabNativeAnalysisAvailable()).toBe(false);

    const missingModule = loadModule({ os: 'ios' });
    expect(missingModule.isPSASlabNativeAnalysisAvailable()).toBe(false);
  });

  it('trims the image uri before invoking the native module', async () => {
    const nativeAnalyzeLabel = jest.fn(async () => ({
      certNumber: '70539858',
      labelText: 'PSA 9 CHARIZARD',
    }));
    const moduleExports = loadModule({ nativeAnalyzeLabel });

    const result = await moduleExports.analyzePSASlabLabelNative('  file:///slab.jpg  ');

    expect(nativeAnalyzeLabel).toHaveBeenCalledWith('file:///slab.jpg');
    expect(result).toEqual({
      certNumber: '70539858',
      labelText: 'PSA 9 CHARIZARD',
    });
  });

  it('rejects blank image uris before touching native code', async () => {
    const nativeAnalyzeLabel = jest.fn();
    const moduleExports = loadModule({ nativeAnalyzeLabel });

    await expect(moduleExports.analyzePSASlabLabelNative('   ')).rejects.toMatchObject({
      code: 'invalid_image_uri',
      name: 'PSASlabNativeAnalysisError',
    });
    expect(nativeAnalyzeLabel).not.toHaveBeenCalled();
  });

  it('throws an unsupported-platform error outside iOS', async () => {
    const moduleExports = loadModule({
      nativeAnalyzeLabel: jest.fn(),
      os: 'android',
    });

    await expect(moduleExports.analyzePSASlabLabelNative('file:///slab.jpg')).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
  });

  it('throws a native-module-unavailable error when the bridge is missing', async () => {
    const moduleExports = loadModule({ os: 'ios' });

    await expect(moduleExports.analyzePSASlabLabelNative('file:///slab.jpg')).rejects.toMatchObject({
      code: 'native_module_unavailable',
    });
  });

  it('wraps native failures with a slab analysis error', async () => {
    const moduleExports = loadModule({
      nativeAnalyzeLabel: jest.fn(async () => {
        throw new Error('vision request failed');
      }),
    });

    await expect(moduleExports.analyzePSASlabLabelNative('file:///slab.jpg')).rejects.toMatchObject({
      code: 'native_analysis_failed',
      message: expect.stringContaining('vision request failed'),
    });
  });

  it('builds parsed scanner match fields from the native analysis result', async () => {
    const nativeAnalysis = {
      certNumber: '70539858',
      labelText: 'PSA 9 CHARIZARD',
    };
    const nativeAnalyzeLabel = jest.fn(async () => nativeAnalysis);
    const moduleExports = loadModule({ nativeAnalyzeLabel });

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
