import {
  collectFooterText,
  extractRawCollectorNumber,
} from '@/features/scanner/raw-collector-number-ocr';
import type { SlabScannerNativeAnalysis } from '@/features/scanner/slab-scanner-native';

describe('extractRawCollectorNumber', () => {
  it('extracts a slashed number/total footer token', () => {
    const text = 'Illus. Mitsuhiro Arita\n087/162';
    expect(extractRawCollectorNumber(text)).toBe('087/162');
  });

  it('extracts a bare numeric footer token', () => {
    expect(extractRawCollectorNumber('Frogadier\n089')).toBe('089');
  });

  it('extracts a set-prefixed promo token (TG / GG style)', () => {
    expect(extractRawCollectorNumber('TG12/TG30')).toBe('TG12/TG30');
    expect(extractRawCollectorNumber('Lugia\nGG01')).toBe('GG01');
  });

  it('prefers the slashed form when both bare and slashed are present', () => {
    const text = 'HP120\n087/162';
    expect(extractRawCollectorNumber(text)).toBe('087/162');
  });

  it('prefers the last (footer-most) token among bare numbers', () => {
    // Earlier digit run is noise; the real collector number is at the bottom.
    const text = 'Stage 1\n70\nIllus.\n089';
    expect(extractRawCollectorNumber(text)).toBe('089');
  });

  it('ignores HP values', () => {
    expect(extractRawCollectorNumber('HP120')).toBeNull();
    expect(extractRawCollectorNumber('120 HP')).toBeNull();
  });

  it('ignores a standalone copyright year', () => {
    expect(extractRawCollectorNumber('(C) 2024 Pokemon')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(extractRawCollectorNumber('')).toBeNull();
    expect(extractRawCollectorNumber('   ')).toBeNull();
    expect(extractRawCollectorNumber(null)).toBeNull();
    expect(extractRawCollectorNumber(undefined)).toBeNull();
    expect(extractRawCollectorNumber('no numbers here')).toBeNull();
  });
});

describe('collectFooterText', () => {
  function analysis(
    overrides: Partial<SlabScannerNativeAnalysis> = {},
  ): SlabScannerNativeAnalysis {
    return {
      width: 630,
      height: 880,
      textBlocks: [],
      barcodes: [],
      ...overrides,
    };
  }

  it('keeps only blocks in the bottom region when geometry is present', () => {
    const result = collectFooterText(
      analysis({
        textBlocks: [
          { text: 'Charizard', boundingBox: { x: 20, y: 30, width: 200, height: 40 } },
          { text: '087/162', boundingBox: { x: 20, y: 820, width: 120, height: 30 } },
        ],
      }),
    );
    expect(result).toContain('087/162');
    expect(result).not.toContain('Charizard');
  });

  it('includes blocks that have no geometry so the number is not lost', () => {
    const result = collectFooterText(
      analysis({
        textBlocks: [
          { text: 'top', boundingBox: { x: 0, y: 10, width: 10, height: 10 } },
          { text: '089', boundingBox: null },
        ],
      }),
    );
    expect(result).toContain('089');
  });

  it('falls back to all text when image height is unknown', () => {
    const result = collectFooterText(
      analysis({
        height: 0,
        textBlocks: [
          { text: 'A' },
          { text: '087/162' },
        ],
      }),
    );
    expect(result).toContain('087/162');
    expect(result).toContain('A');
  });

  it('end-to-end: footer crop text yields the collector number', () => {
    const footer = collectFooterText(
      analysis({
        textBlocks: [
          { text: 'Frogadier', boundingBox: { x: 20, y: 40, width: 200, height: 40 } },
          { text: 'Illus. Arita', boundingBox: { x: 20, y: 800, width: 200, height: 24 } },
          { text: '089/162', boundingBox: { x: 20, y: 840, width: 120, height: 28 } },
        ],
      }),
    );
    expect(extractRawCollectorNumber(footer)).toBe('089/162');
  });
});

describe('readRawCollectorNumber (native flow)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({
    nativeScanPSALabel,
  }: {
    nativeScanPSALabel?: jest.Mock | null;
  } = {}) {
    const nativeBindings = nativeScanPSALabel === null
      ? null
      : { scanPSALabel: nativeScanPSALabel ?? jest.fn() };

    jest.doMock('expo-modules-core', () => ({
      requireOptionalNativeModule: (name: string) =>
        name === 'SpotlightSlabScanner' ? nativeBindings : null,
    }));

    let moduleExports: typeof import('@/features/scanner/raw-collector-number-ocr');
    jest.isolateModules(() => {
      moduleExports = require('@/features/scanner/raw-collector-number-ocr');
    });

    return {
      ...moduleExports!,
      nativeScanPSALabel: nativeBindings?.scanPSALabel,
    };
  }

  it('returns null and never calls native when the module is unavailable (Expo Go)', async () => {
    const mod = loadModule({ nativeScanPSALabel: null });
    expect(mod.isRawCollectorNumberOcrAvailable()).toBe(false);
    await expect(mod.readRawCollectorNumber('file:///cap.jpg')).resolves.toBeNull();
  });

  it('reads the footer collector number via the native text reader', async () => {
    const nativeScanPSALabel = jest.fn(async () => ({
      width: 630,
      height: 880,
      textBlocks: [
        { text: 'Frogadier', boundingBox: { x: 20, y: 40, width: 200, height: 40 } },
        { text: '089/162', boundingBox: { x: 20, y: 840, width: 120, height: 28 } },
      ],
      barcodes: [],
    }));
    const mod = loadModule({ nativeScanPSALabel });
    await expect(mod.readRawCollectorNumber('  file:///cap.jpg  ')).resolves.toBe('089/162');
    expect(nativeScanPSALabel).toHaveBeenCalledWith('file:///cap.jpg');
  });

  it('resolves null (never throws) when native analysis fails', async () => {
    const nativeScanPSALabel = jest.fn(async () => {
      throw new Error('native_boom');
    });
    const mod = loadModule({ nativeScanPSALabel });
    await expect(mod.readRawCollectorNumber('file:///cap.jpg')).resolves.toBeNull();
  });

  it('returns null for empty image uri', async () => {
    const mod = loadModule({ nativeScanPSALabel: jest.fn() });
    await expect(mod.readRawCollectorNumber('   ')).resolves.toBeNull();
    expect(mod.nativeScanPSALabel).not.toHaveBeenCalled();
  });
});
