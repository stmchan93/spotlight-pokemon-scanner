import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { requireOptionalNativeModule } from 'expo-modules-core';

import { loadNativeImagePicker } from '@/lib/native-image-picker';

// jest.setup replaces this module app-wide so screen tests get a working picker.
// This suite is about the real probe, so it opts back out.
jest.unmock('@/lib/native-image-picker');
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));

const probe = requireOptionalNativeModule as jest.Mock;

/**
 * Regression guard for a failure that was invisible from inside the app.
 *
 * The probe asked for 'ExpoImagePicker'; expo-image-picker actually registers
 * 'ExponentImagePicker'. `requireOptionalNativeModule` returns null for an
 * unknown name exactly as it does for a missing module, so Photo, Camera, and
 * avatar upload told every user to update an app that was already current — on
 * builds where the native module was present the whole time.
 *
 * Nothing about that is catchable by mocking our own code, because our own code
 * was self-consistent. So the first test reads the name back out of the
 * INSTALLED package: if a future expo-image-picker renames its module, this
 * fails at CI instead of silently disabling photo upload in the field again.
 */
describe('loadNativeImagePicker', () => {
  beforeEach(() => probe.mockReset());

  it('probes the name expo-image-picker actually registers', () => {
    const require_ = createRequire(__filename);
    const source = readFileSync(
      require_.resolve('expo-image-picker/build/ExponentImagePicker.js'),
      'utf8',
    );
    const registered = /requireNativeModule\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)?.[1];
    expect(registered).toBeTruthy();

    loadNativeImagePicker();

    expect(probe).toHaveBeenCalledWith(registered);
  });

  it('returns null when the native half is missing from the binary', () => {
    probe.mockReturnValue(null);

    // Callers rely on null to show "update needed" rather than calling into a
    // native side that isn't there, which used to take the whole app down.
    expect(loadNativeImagePicker()).toBeNull();
  });

  it('resolves the module when the native half is present', () => {
    probe.mockReturnValue({});

    expect(loadNativeImagePicker()).not.toBeNull();
  });
});
