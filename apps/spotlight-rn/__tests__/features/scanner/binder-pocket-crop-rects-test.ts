import {
  binderPageGridSize,
  makeBinderPocketCropRects,
  rawCardNormalizedTargetHeight,
  rawCardNormalizedTargetWidth,
} from '@/features/scanner/scanner-normalized-target';

const CARD_ASPECT = rawCardNormalizedTargetWidth / rawCardNormalizedTargetHeight;

describe('makeBinderPocketCropRects', () => {
  // A canonical page rect as the reticle mapping produces it: card-aspect
  // (a 3x3 page of 63:88 cards IS 63:88), inside a 4K-ish portrait source.
  const source = { height: 4032, width: 3024 };
  const page = { height: 3520, width: Math.round(3520 * CARD_ASPECT), x: 250, y: 250 };

  it('yields nine card-aspect cells in reading order, inside the page rect', () => {
    const rects = makeBinderPocketCropRects(page, source);
    expect(rects).toHaveLength(binderPageGridSize * binderPageGridSize);

    for (const rect of rects) {
      // Every cell stays within the page bounds (insets pull inward).
      expect(rect.x).toBeGreaterThanOrEqual(page.x);
      expect(rect.y).toBeGreaterThanOrEqual(page.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(page.x + page.width + 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(page.y + page.height + 1);
      // Canonicalized back to the matcher's aspect (±rounding).
      expect(rect.width / rect.height).toBeCloseTo(CARD_ASPECT, 2);
    }

    // Reading order: pocket 0 is top-left, pocket 2 ends row one, pocket 3
    // drops a row. The tray order the user sees depends on this.
    expect(rects[1].x).toBeGreaterThan(rects[0].x);
    expect(rects[2].x).toBeGreaterThan(rects[1].x);
    expect(rects[3].x).toBeLessThan(rects[2].x);
    expect(rects[3].y).toBeGreaterThan(rects[0].y);
    expect(rects[8].y).toBeGreaterThan(rects[5].y);
  });

  it('insets each cell so sleeve edges stay out of the crop', () => {
    const rects = makeBinderPocketCropRects(page, source);
    const cellWidth = page.width / binderPageGridSize;
    // The inset shrinks every cell strictly below the raw third.
    for (const rect of rects) {
      expect(rect.width).toBeLessThan(cellWidth);
    }
    // And neighbors never overlap: pocket 0's right edge < pocket 1's left.
    expect(rects[0].x + rects[0].width).toBeLessThanOrEqual(rects[1].x);
  });

  it('clamps to source bounds when the page rect touches the image edge', () => {
    const edgePage = { height: 4032, width: Math.round(4032 * CARD_ASPECT), x: 0, y: 0 };
    const rects = makeBinderPocketCropRects(edgePage, source);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(source.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(source.height);
    }
  });
});
