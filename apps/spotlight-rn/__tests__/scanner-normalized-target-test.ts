import {
  buildNormalizedScannerTarget,
  makeOrientationFixedSourceImageDimensions,
  makeReticleSourceImageCrop,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
} from '@/features/scanner/scanner-normalized-target';

describe('scanner-normalized-target', () => {
  it('treats landscape camera captures as portrait before reticle crop mapping', () => {
    const orientedDimensions = makeOrientationFixedSourceImageDimensions({
      height: 720,
      width: 1280,
    });

    expect(orientedDimensions).toEqual({
      height: 1280,
      width: 720,
    });

    const crop = makeReticleSourceImageCrop({
      previewLayout: {
        height: 780,
        width: 390,
      },
      reticle: {
        height: 503,
        width: 360,
        x: 15,
        y: 125,
      },
      sourceImageDimensions: orientedDimensions,
    });

    expect(crop).toBeTruthy();
    expect(crop).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(crop!.x).toBeGreaterThanOrEqual(0);
    expect(crop!.y).toBeGreaterThanOrEqual(0);
    expect(crop!.x + crop!.width).toBeLessThanOrEqual(orientedDimensions.width);
    expect(crop!.y + crop!.height).toBeLessThanOrEqual(orientedDimensions.height);
    expect(crop!.width / crop!.height).toBeCloseTo(
      rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight,
      3,
    );
  });

  // These lock the camera->normalize contract that the matcher depends on, so a
  // camera-library swap (expo-camera -> react-native-vision-camera) can't silently
  // change the normalized 630x880 target as long as it feeds the same source URI
  // + reported dimensions. The crop/rotate/resize math itself stays untouched.
  describe('buildNormalizedScannerTarget', () => {
    const previewLayout = { height: 780, width: 390 };
    const reticle = { height: 503, width: 360, x: 15, y: 125 };

    it('rotates a landscape capture to portrait and emits a 630x880 target', async () => {
      // The image-manipulator mock reports 'file:///mock-scan.jpg' as 1920x888
      // (landscape); the reported dimensions are portrait, so it must rotate 90.
      const target = await buildNormalizedScannerTarget({
        previewLayout,
        reticle,
        sourceImageDimensions: { height: 1920, width: 888 },
        sourceImageUri: 'file:///mock-scan.jpg',
      });

      expect(target).toBeTruthy();
      expect(target!.normalizationRotationDegrees).toBe(90);
      expect(target!.nativeSourceImageDimensions).toEqual({ height: 888, width: 1920 });
      expect(target!.normalizedImageDimensions).toEqual({
        height: rawCardNormalizedTargetHeight,
        width: rawCardNormalizedTargetWidth,
      });
      expect(target!.normalizedImageBase64.length).toBeGreaterThan(0);

      // Crop is canonical (630:880) and stays within the orientation-fixed source.
      const crop = target!.sourceImageCrop;
      expect(crop.width / crop.height).toBeCloseTo(
        rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight,
        3,
      );
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(888);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1920);
    });

    it('emits a 630x880 target without rotation for a portrait capture', async () => {
      // Unknown URI falls back to the mock's default 1080x1620 (portrait).
      const target = await buildNormalizedScannerTarget({
        previewLayout,
        reticle,
        sourceImageDimensions: { height: 1620, width: 1080 },
        sourceImageUri: 'file:///mock-portrait-capture.jpg',
      });

      expect(target).toBeTruthy();
      expect(target!.normalizationRotationDegrees).toBe(0);
      expect(target!.normalizedImageDimensions).toEqual({
        height: rawCardNormalizedTargetHeight,
        width: rawCardNormalizedTargetWidth,
      });
      expect(target!.normalizedImageBase64.length).toBeGreaterThan(0);
    });
  });
});
