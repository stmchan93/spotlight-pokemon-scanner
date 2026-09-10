import {
  binderPageAspectRatio,
  binderPageLayoutById,
  binderPageLayouts,
  buildNormalizedScannerTarget,
  makeBinderPocketCropRects,
  makeOrientationFixedSourceImageDimensions,
  makeReticleSourceImageCrop,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
} from '@/features/scanner/scanner-normalized-target';

describe('binder page layouts', () => {
  it('offers the 9-pocket page only, three columns wide', () => {
    // Three across keeps every pocket above the 360px zero-loss line in
    // portrait (docs/binder-scan-feasibility). 12 and 18 were pulled 2026-09-08.
    expect(binderPageLayouts.map((layout) => [layout.label, layout.columns * layout.rows])).toEqual([
      ['Multi-Scan', 9],
    ]);
    expect(binderPageLayouts.every((layout) => layout.columns === 3)).toBe(true);
    // Unknown/legacy ids (rows persisted before layouts) resolve to 3×3.
    expect(binderPageLayoutById(undefined).id).toBe('pockets-9');
    expect(binderPageLayoutById('nonsense').id).toBe('pockets-9');
  });

  it('cuts a 3x4 page into 12 upright card-aspect cells in reading order', () => {
    // Not offered today; the layout-driven crop stays exercised (see the table note).
    const layout = { ...binderPageLayoutById('pockets-9'), rows: 4 };
    const page = { height: 3520, width: 1890, x: 0, y: 0 };
    const rects = makeBinderPocketCropRects(page, { height: 3520, width: 1890 }, layout);
    expect(rects).toHaveLength(12);
    // Row-major: pocket 3 starts the second row.
    expect(rects[3].x).toBeLessThan(rects[2].x);
    expect(rects[3].y).toBeGreaterThan(rects[2].y);
    for (const rect of rects) {
      expect(rect.width / rect.height).toBeCloseTo(630 / 880, 2);
    }
  });

  it('cuts a sideways spread into landscape cells the crop then stands up', () => {
    // Not offered in the dropdown today, but the crop path stays exercised so
    // a future wide (4 × 3) binder layout is a table entry, not a rebuild.
    const layout = {
      id: 'pockets-9' as const,
      label: 'sideways test',
      columns: 3,
      rows: 6,
      cropRotationDegrees: 90 as const,
      hint: null,
    };
    // 3 across × 6 down of sideways cards: page aspect is 6·(630/880) / 3.
    expect(binderPageAspectRatio(layout)).toBeCloseTo((6 * (630 / 880)) / 3, 4);
    const pageWidth = 2640;
    const pageHeight = Math.round(pageWidth * binderPageAspectRatio(layout));
    const rects = makeBinderPocketCropRects(
      { height: pageHeight, width: pageWidth, x: 0, y: 0 },
      { height: pageHeight, width: pageWidth },
      layout,
    );
    expect(rects).toHaveLength(18);
    for (const rect of rects) {
      // Landscape cell = the card lying on its side.
      expect(rect.width / rect.height).toBeCloseTo(880 / 630, 2);
    }
  });
});

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
      // Scan hot path: the target is a saved FILE (streamed via multipart);
      // base64 is only materialized when a caller opts in via includeBase64.
      expect(target!.normalizedImageUri).toEqual(expect.stringContaining('file://'));
      expect(target!.normalizedImageBase64).toBeNull();

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
      expect(target!.normalizedImageBase64).toBeNull();
    });

    it('materializes inline base64 only when includeBase64 is requested (labeling lane)', async () => {
      const target = await buildNormalizedScannerTarget({
        includeBase64: true,
        previewLayout,
        reticle,
        sourceImageDimensions: { height: 1620, width: 1080 },
        sourceImageUri: 'file:///mock-portrait-capture.jpg',
      });

      expect(target).toBeTruthy();
      expect(target!.normalizedImageBase64).toEqual(expect.any(String));
      expect(target!.normalizedImageBase64!.length).toBeGreaterThan(0);
    });
  });
});
