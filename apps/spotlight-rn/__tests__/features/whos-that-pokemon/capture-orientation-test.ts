import {
  captureUnmirrorActions,
  exifOrientationRotationDegrees,
  uprightDimensions,
  uprightRotationDegrees,
} from '@/features/whos-that-pokemon/screens/whos-that-pokemon-screen';

/*
  The capture arrives sensor-native with its rotation in an EXIF flag.
  `expo-image-manipulator` applies that flag itself on iOS but NOT on Android —
  where baking stripped the tag without rotating the pixels, so `expo-image`
  lost the only thing making the selfie upright and it rendered sideways. These
  pin the decision that drives the corrective second pass.
*/
describe('capture orientation', () => {
  describe('uprightRotationDegrees', () => {
    it('turns the content back the way it came', () => {
      // 'right' means "whatever was top is now on the right", so it comes back
      // counter-clockwise. Getting this sign wrong yields an upside-down
      // selfie, which the dimension check CANNOT catch — a 180 error leaves
      // width and height untouched.
      expect(uprightRotationDegrees('right')).toBe(-90);
      expect(uprightRotationDegrees('left')).toBe(90);
      expect(uprightRotationDegrees('down')).toBe(180);
    });

    it('leaves an already-upright capture alone', () => {
      expect(uprightRotationDegrees('up')).toBe(0);
      // vision-camera may not report one at all; never rotate on a guess.
      expect(uprightRotationDegrees(undefined)).toBe(0);
    });
  });

  describe('uprightDimensions', () => {
    const landscapeCapture = { width: 3840, height: 2160 };

    it('swaps the axes for a quarter turn', () => {
      // This is what makes "did pass 1 actually rotate?" answerable without
      // branching on Platform.OS.
      expect(uprightDimensions(landscapeCapture, 'right')).toEqual({ width: 2160, height: 3840 });
      expect(uprightDimensions(landscapeCapture, 'left')).toEqual({ width: 2160, height: 3840 });
    });

    it('keeps the axes for a half turn or none', () => {
      expect(uprightDimensions(landscapeCapture, 'down')).toEqual({ width: 3840, height: 2160 });
      expect(uprightDimensions(landscapeCapture, 'up')).toEqual({ width: 3840, height: 2160 });
      expect(uprightDimensions(landscapeCapture, undefined)).toEqual({ width: 3840, height: 2160 });
    });
  });

  describe('captureUnmirrorActions', () => {
    // With mirrorMode="off" neither camera reports a mirror, so the still is
    // baked as-is — no flip on either camera.
    it('never flips an un-mirrored capture (front or back camera)', () => {
      expect(captureUnmirrorActions(false, -90, 'horizontal')).toEqual([]);
      expect(captureUnmirrorActions(undefined, -90, 'horizontal')).toEqual([]);
      expect(captureUnmirrorActions(false, 90, 'horizontal')).toEqual([]);
    });

    it('cancels a mirror exactly once, in pass 1, when one is reported', () => {
      expect(captureUnmirrorActions(true, -90, 'horizontal')).toEqual([{ flip: 'horizontal' }]);
    });

    it('does not flip on a guess when pass 1 cannot be observed', () => {
      expect(captureUnmirrorActions(true, 0, 'horizontal')).toEqual([]);
    });
  });

  describe('exifOrientationRotationDegrees', () => {
    it('maps the rotation-only EXIF tags to clockwise degrees', () => {
      expect(exifOrientationRotationDegrees(1)).toBe(0);
      expect(exifOrientationRotationDegrees(3)).toBe(180);
      expect(exifOrientationRotationDegrees(6)).toBe(90);
      expect(exifOrientationRotationDegrees(8)).toBe(-90);
    });

    it('accepts string tags and ignores missing or unknown ones', () => {
      expect(exifOrientationRotationDegrees('6')).toBe(90);
      expect(exifOrientationRotationDegrees(undefined)).toBe(0);
      expect(exifOrientationRotationDegrees(5)).toBe(0);
    });
  });
});
