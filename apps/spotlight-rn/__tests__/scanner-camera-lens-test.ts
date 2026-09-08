import { resolveScannerCameraDevice } from '@/features/scanner/scanner-camera-lens';

const multi = { id: 'triple', supportsFocusLocking: true };
const proUltraWide = { id: 'ultra-wide', supportsFocusLocking: true };
const fixedUltraWide = { id: 'ultra-wide-fixed', supportsFocusLocking: false, supportsFocusMetering: false };

describe('resolveScannerCameraDevice', () => {
  it('keeps the multi-lens device when the lock is off', () => {
    expect(resolveScannerCameraDevice({
      lockMacroLens: false, multiLensDevice: multi, ultraWideDevice: proUltraWide,
    })).toBe(multi);
  });

  it('locks to the ultra-wide when it can focus (Pro iPhones)', () => {
    expect(resolveScannerCameraDevice({
      lockMacroLens: true, multiLensDevice: multi, ultraWideDevice: proUltraWide,
    })).toBe(proUltraWide);
  });

  it('refuses a fixed-focus ultra-wide — every scan would blur', () => {
    expect(resolveScannerCameraDevice({
      lockMacroLens: true, multiLensDevice: multi, ultraWideDevice: fixedUltraWide,
    })).toBe(multi);
  });

  it('falls back to the multi-lens device when no ultra-wide exists', () => {
    expect(resolveScannerCameraDevice({
      lockMacroLens: true, multiLensDevice: multi, ultraWideDevice: null,
    })).toBe(multi);
  });
});
