import {
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
});
