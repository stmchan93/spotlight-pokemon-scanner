type SlabScannerNativeModule = typeof import('@/features/scanner/slab-scanner-native');

type LoadOptions = {
  scanPSALabel?: jest.Mock | null;
};

function loadModule({ scanPSALabel }: LoadOptions = {}): {
  module: SlabScannerNativeModule;
  scanPSALabelMock: jest.Mock;
} {
  const scanPSALabelMock = scanPSALabel ?? jest.fn();
  const nativeBindings = scanPSALabel === null ? null : { scanPSALabel: scanPSALabelMock };

  jest.resetModules();
  jest.doMock('expo-modules-core', () => ({
    requireOptionalNativeModule: (name: string) =>
      name === 'SpotlightSlabScanner' ? nativeBindings : null,
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('@/features/scanner/slab-scanner-native') as SlabScannerNativeModule;
  return { module: loaded, scanPSALabelMock };
}

describe('slab-scanner-native', () => {
  afterEach(() => {
    jest.dontMock('expo-modules-core');
  });

  it('exposes the expected native module name', () => {
    const { module } = loadModule();
    expect(module.SLAB_SCANNER_NATIVE_MODULE_NAME).toBe('SpotlightSlabScanner');
  });

  it('reports availability when expo-modules-core resolves the native module', () => {
    const { module } = loadModule();
    expect(module.isSlabScannerNativeAvailable()).toBe(true);
  });

  it('reports unavailable when expo-modules-core returns null', () => {
    const { module } = loadModule({ scanPSALabel: null });
    expect(module.isSlabScannerNativeAvailable()).toBe(false);
  });

  it('throws a guidance error when the native module is missing', async () => {
    const { module } = loadModule({ scanPSALabel: null });
    await expect(module.scanPSALabel('file:///mock-slab.jpg')).rejects.toThrow(
      /not registered in this build/,
    );
  });

  it('rejects empty image URIs before calling the native module', async () => {
    const { module, scanPSALabelMock } = loadModule();
    await expect(module.scanPSALabel('')).rejects.toThrow(/non-empty imageUri/);
    await expect(module.scanPSALabel('   ')).rejects.toThrow(/non-empty imageUri/);
    expect(scanPSALabelMock).not.toHaveBeenCalled();
  });

  it('rejects non-string image URIs before calling the native module', async () => {
    const { module, scanPSALabelMock } = loadModule();
    await expect(
      module.scanPSALabel(undefined as unknown as string),
    ).rejects.toThrow(/string imageUri/);
    expect(scanPSALabelMock).not.toHaveBeenCalled();
  });

  it('passes the trimmed image URI through to the native module and returns its result', async () => {
    const expected = {
      width: 1200,
      height: 500,
      textBlocks: [{ text: 'PSA 12345678', boundingBox: { x: 100, y: 40, width: 300, height: 40 } }],
      barcodes: [
        { rawValue: '12345678', format: 'code128', boundingBox: { x: 800, y: 60, width: 220, height: 80 } },
      ],
    };
    const scanPSALabel = jest.fn().mockResolvedValue(expected);
    const { module, scanPSALabelMock } = loadModule({ scanPSALabel });

    const result = await module.scanPSALabel('  file:///mock-slab.jpg  ');

    expect(scanPSALabelMock).toHaveBeenCalledWith('file:///mock-slab.jpg');
    expect(result).toEqual(expected);
  });

  it('propagates native errors verbatim', async () => {
    const nativeFailure = new Error('native ocr failed');
    const scanPSALabel = jest.fn().mockRejectedValue(nativeFailure);
    const { module } = loadModule({ scanPSALabel });

    await expect(module.scanPSALabel('file:///mock-slab.jpg')).rejects.toBe(nativeFailure);
  });
});
