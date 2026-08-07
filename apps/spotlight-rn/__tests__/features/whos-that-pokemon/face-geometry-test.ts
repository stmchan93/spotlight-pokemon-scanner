import {
  assignOutlineTargets,
  describeFaceMeasurements,
  FACE_LANDMARKS,
  FALLBACK_HEAD_BOX,
  isUsableNormalizedBox,
  projectLandmarks,
  projectSpeciesOutline,
  rectCenter,
  resolveArtworkRect,
  resolveHeadRect,
  scatterTargets,
  type Point,
} from '@/features/whos-that-pokemon/face-geometry';

describe('resolveHeadRect', () => {
  it('projects a selfie-space head box through the cover crop and the display mirror', () => {
    // Source and container share an aspect ratio → no crop, pure scale.
    const { rect, isMeasured } = resolveHeadRect({
      headBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.15 },
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 400,
      containerHeight: 800,
    });

    expect(isMeasured).toBe(true);
    // Mirrored: x 0.1..0.4 in the original becomes 0.6..0.9 on screen.
    expect(rect).toEqual({ x: 240, y: 160, width: 120, height: 120 });
  });

  it('accounts for the centre crop when the selfie is wider than the container', () => {
    const { rect } = resolveHeadRect({
      headBox: { x: 0.4, y: 0.1, width: 0.2, height: 0.3 },
      sourceWidth: 2000,
      sourceHeight: 1000,
      containerWidth: 400,
      containerHeight: 800,
    });

    // cover scale = 0.8 → drawn 1600x800, so 600px is cropped off each side.
    expect(rect.x).toBeCloseTo(40, 6);
    expect(rect.y).toBeCloseTo(80, 6);
    expect(rect.width).toBeCloseTo(320, 6);
    expect(rect.height).toBeCloseTo(240, 6);
  });

  it('can skip the mirror for callers that draw the un-flipped selfie', () => {
    const { rect } = resolveHeadRect({
      headBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.15 },
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 400,
      containerHeight: 800,
      mirrored: false,
    });

    expect(rect.x).toBe(40);
  });

  it('falls back to a centred proportional head box when the backend sent nothing', () => {
    const { rect, isMeasured } = resolveHeadRect({
      headBox: null,
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 400,
      containerHeight: 800,
    });

    expect(isMeasured).toBe(false);
    expect(rect).toEqual({
      x: FALLBACK_HEAD_BOX.x * 400,
      y: FALLBACK_HEAD_BOX.y * 800,
      width: FALLBACK_HEAD_BOX.width * 400,
      height: FALLBACK_HEAD_BOX.height * 800,
    });
    // Horizontally centred — a guess should look deliberate, not lopsided.
    expect(rect.x + rect.width / 2).toBeCloseTo(200, 5);
  });

  it('falls back when the source dimensions or the box itself are unusable', () => {
    const noSource = resolveHeadRect({
      headBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.15 },
      sourceWidth: 0,
      sourceHeight: 0,
      containerWidth: 400,
      containerHeight: 800,
    });
    expect(noSource.isMeasured).toBe(false);

    const degenerate = resolveHeadRect({
      headBox: { x: 0.1, y: 0.2, width: 0, height: 0.15 },
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 400,
      containerHeight: 800,
    });
    expect(degenerate.isMeasured).toBe(false);

    const offFrame = resolveHeadRect({
      headBox: { x: 3, y: 0.2, width: 0.3, height: 0.15 },
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 400,
      containerHeight: 800,
    });
    expect(offFrame.isMeasured).toBe(false);
  });

  it('never returns NaN geometry when the container has not been measured yet', () => {
    const { rect } = resolveHeadRect({
      headBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.15 },
      sourceWidth: 1000,
      sourceHeight: 2000,
      containerWidth: 0,
      containerHeight: 0,
    });
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('isUsableNormalizedBox', () => {
  it('rejects missing, degenerate, and wildly out-of-range boxes', () => {
    expect(isUsableNormalizedBox(null)).toBe(false);
    expect(isUsableNormalizedBox(undefined)).toBe(false);
    expect(isUsableNormalizedBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 })).toBe(false);
    expect(isUsableNormalizedBox({ x: 0.1, y: 0.1, width: Number.NaN, height: 0.2 })).toBe(false);
    expect(isUsableNormalizedBox({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).toBe(true);
  });
});

describe('resolveArtworkRect', () => {
  it('letterboxes the square artwork inside the reveal box', () => {
    // 80% x 58% of 400x800 → 320x464; the square art fits to 320.
    expect(resolveArtworkRect(400, 800)).toEqual({ x: 40, y: 240, width: 320, height: 320 });
  });
});

describe('projectLandmarks', () => {
  it('maps the head-box-local template into layout pixels', () => {
    const points = projectLandmarks({ x: 100, y: 50, width: 200, height: 400 });
    expect(points).toHaveLength(FACE_LANDMARKS.length);
    expect(points[14]).toEqual({
      x: 100 + FACE_LANDMARKS[14].x * 200,
      y: 50 + FACE_LANDMARKS[14].y * 400,
    });
  });
});

describe('describeFaceMeasurements', () => {
  it('derives its readouts from the landmarks actually drawn', () => {
    const points = projectLandmarks({ x: 0, y: 0, width: 200, height: 200 });
    const measurements = describeFaceMeasurements(points);

    expect(measurements.map((entry) => entry.label)).toEqual(['EYE SPAN', 'JAW']);
    // Eye span is a ratio of the face width, jaw is an angle in degrees.
    expect(measurements[0].value).toMatch(/^0\.\d{2}w$/);
    expect(measurements[1].value).toMatch(/^\d{1,3}°$/);
  });

  it('returns nothing rather than throwing when the landmark set is empty', () => {
    expect(describeFaceMeasurements([])).toEqual([]);
  });
});

function circleOutline(count: number, radius: number, center: Point): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

describe('projectSpeciesOutline', () => {
  const artworkRect = { x: 40, y: 240, width: 320, height: 320 };

  it('maps artwork-space points into the artwork rect', () => {
    const outline = circleOutline(16, 0.4, { x: 0.5, y: 0.5 });
    const projected = projectSpeciesOutline(outline, artworkRect);

    expect(projected).toHaveLength(16);
    for (const point of projected) {
      expect(point.x).toBeGreaterThanOrEqual(artworkRect.x);
      expect(point.x).toBeLessThanOrEqual(artworkRect.x + artworkRect.width);
      expect(point.y).toBeGreaterThanOrEqual(artworkRect.y);
      expect(point.y).toBeLessThanOrEqual(artworkRect.y + artworkRect.height);
    }
  });

  it('normalizes the winding direction so reversed backend output still maps cleanly', () => {
    const outline = circleOutline(16, 0.4, { x: 0.5, y: 0.5 });
    const forward = projectSpeciesOutline(outline, artworkRect);
    const backward = projectSpeciesOutline([...outline].reverse(), artworkRect);

    // Same ring, same direction — only the starting index may differ.
    expect(new Set(backward.map((point) => `${point.x},${point.y}`))).toEqual(
      new Set(forward.map((point) => `${point.x},${point.y}`)),
    );
    const startIndex = forward.findIndex(
      (point) => point.x === backward[0].x && point.y === backward[0].y,
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(backward[1]).toEqual(forward[(startIndex + 1) % forward.length]);
  });

  it('treats a missing or too-short outline as absent', () => {
    expect(projectSpeciesOutline(null, artworkRect)).toEqual([]);
    expect(projectSpeciesOutline(undefined, artworkRect)).toEqual([]);
    expect(projectSpeciesOutline(circleOutline(4, 0.4, { x: 0.5, y: 0.5 }), artworkRect)).toEqual([]);
  });
});

describe('assignOutlineTargets', () => {
  const center = { x: 200, y: 400 };

  it('gives every face point a distinct landing spot on the outline', () => {
    const facePoints = circleOutline(12, 60, center);
    const outline = circleOutline(48, 160, center);
    const targets = assignOutlineTargets(facePoints, center, outline);

    expect(targets).toHaveLength(facePoints.length);
    const unique = new Set(targets.map((point) => `${point.x},${point.y}`));
    expect(unique.size).toBe(facePoints.length);
    for (const target of targets) {
      expect(outline).toContainEqual(target);
    }
  });

  it('preserves angular order, so no two flight paths cross', () => {
    const facePoints = circleOutline(12, 60, center);
    const outline = circleOutline(48, 160, center);
    const targets = assignOutlineTargets(facePoints, center, outline);

    const bearing = (point: Point) => {
      const angle = Math.atan2(point.y - center.y, point.x - center.x);
      return angle < 0 ? angle + Math.PI * 2 : angle;
    };
    // Face points were generated in increasing-bearing order, so their targets
    // must walk the outline in one direction (allowing a single wrap).
    let wraps = 0;
    for (let index = 1; index < targets.length; index += 1) {
      if (bearing(targets[index]) < bearing(targets[index - 1])) {
        wraps += 1;
      }
    }
    expect(wraps).toBeLessThanOrEqual(1);
  });

  it('returns nothing when either side is empty', () => {
    expect(assignOutlineTargets([], center, circleOutline(48, 160, center))).toEqual([]);
    expect(assignOutlineTargets(circleOutline(12, 60, center), center, [])).toEqual([]);
  });
});

describe('scatterTargets', () => {
  it('pushes every point outward from the head centre — the no-outline exit', () => {
    const center = { x: 200, y: 400 };
    const facePoints = circleOutline(12, 60, center);
    const targets = scatterTargets(facePoints, center);

    targets.forEach((target, index) => {
      const source = facePoints[index];
      const before = Math.hypot(source.x - center.x, source.y - center.y);
      const after = Math.hypot(target.x - center.x, target.y - center.y);
      expect(after).toBeGreaterThan(before);
    });
  });

  it('is deterministic — no per-frame randomness', () => {
    const center = { x: 200, y: 400 };
    const facePoints = circleOutline(12, 60, center);
    expect(scatterTargets(facePoints, center)).toEqual(scatterTargets(facePoints, center));
  });
});

describe('rectCenter', () => {
  it('returns the middle of the rect', () => {
    expect(rectCenter({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 60, y: 45 });
  });
});
