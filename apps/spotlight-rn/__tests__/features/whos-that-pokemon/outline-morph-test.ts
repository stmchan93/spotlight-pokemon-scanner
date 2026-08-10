import {
  buildMorphOutlines,
  fitOutlineIntoRect,
  lerpOutline,
  MORPH_POINT_COUNT,
  morphPathD,
  outlinePathD,
  projectOutlineOntoRect,
  resampleOutlineByAngle,
} from '@/features/whos-that-pokemon/outline-morph';
import type { Point, Rect } from '@/features/whos-that-pokemon/face-geometry';

const RECT: Rect = { x: 40, y: 100, width: 300, height: 300 };

/**
 * The shape of a real backend outline: clockwise on screen from 3 o'clock,
 * evenly spaced by angle about the centroid, normalized 0..1 against its own
 * image. `radiusX`/`radiusY` let a test tell two shapes apart.
 */
function ellipse(count: number, radiusX: number, radiusY: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(angle) * radiusX,
      y: 0.5 + Math.sin(angle) * radiusY,
    };
  });
}

function centroid(points: readonly Point[]): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/** Bearing of each point about the shape's own centre, in 0..2π. */
function bearings(points: readonly Point[]): number[] {
  const centre = centroid(points);
  return points.map((point) => {
    const angle = Math.atan2(point.y - centre.y, point.x - centre.x);
    return angle < 0 ? angle + Math.PI * 2 : angle;
  });
}

/** Shortest angular distance between two bearings — 0 and 2π are the same. */
function bearingGap(left: number, right: number): number {
  const delta = Math.abs(left - right) % (Math.PI * 2);
  return Math.min(delta, Math.PI * 2 - delta);
}

/** Index i must point the same way on both shapes, or the morph twists. */
function expectSameBearings(left: readonly Point[], right: readonly Point[]) {
  const leftAngles = bearings(left);
  const rightAngles = bearings(right);
  expect(rightAngles).toHaveLength(leftAngles.length);
  leftAngles.forEach((angle, index) => {
    expect(bearingGap(angle, rightAngles[index])).toBeLessThan(1e-4);
  });
}

describe('resampleOutlineByAngle', () => {
  it('returns exactly `count` points on evenly spaced bearings', () => {
    const points = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.4, 0.4), RECT));

    expect(points).toHaveLength(MORPH_POINT_COUNT);
    bearings(points).forEach((angle, index) => {
      const expected = (index / MORPH_POINT_COUNT) * Math.PI * 2;
      expect(bearingGap(angle, expected)).toBeLessThan(1e-4);
    });
  });

  it('puts index i on the same bearing regardless of point count or winding', () => {
    // This is the property the whole morph rests on: whatever the backend sent —
    // a different number of surviving rays, or a mirrored (reversed) array —
    // index i must mean the same direction on both shapes, or the morph twists.
    const clockwise = resampleOutlineByAngle(
      projectOutlineOntoRect(ellipse(48, 0.35, 0.45), RECT),
    );
    const sparseAndReversed = resampleOutlineByAngle(
      projectOutlineOntoRect([...ellipse(19, 0.35, 0.45)].reverse(), RECT),
    );

    expect(sparseAndReversed).toHaveLength(MORPH_POINT_COUNT);
    expectSameBearings(clockwise, sparseAndReversed);
  });

  it('rejects anything too small to be a shape instead of guessing', () => {
    expect(resampleOutlineByAngle(null)).toEqual([]);
    expect(resampleOutlineByAngle([])).toEqual([]);
    expect(resampleOutlineByAngle([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual([]);
  });
});

describe('fitOutlineIntoRect', () => {
  it('contains the outline inside the rect, centred', () => {
    // A tall, narrow figure standing off to one side of the selfie frame — the
    // usual case, and the reason this cannot be a raw projection.
    const person = ellipse(48, 0.08, 0.4).map((point) => ({ x: point.x - 0.3, y: point.y }));

    const fitted = fitOutlineIntoRect(person, RECT, { mirrorX: false });

    const xs = fitted.map((point) => point.x);
    const ys = fitted.map((point) => point.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(RECT.x - 0.001);
    expect(Math.max(...xs)).toBeLessThanOrEqual(RECT.x + RECT.width + 0.001);
    expect(Math.min(...ys)).toBeCloseTo(RECT.y, 3);
    expect(Math.max(...ys)).toBeCloseTo(RECT.y + RECT.height, 3);
    // Centred horizontally in the box despite being off-centre in the selfie.
    expect(centroid(fitted).x).toBeCloseTo(RECT.x + RECT.width / 2, 3);
  });

  it('mirrors on request, because the selfie is flipped for display', () => {
    const lopsided: Point[] = [
      { x: 0.1, y: 0.5 },
      { x: 0.5, y: 0.1 },
      { x: 0.9, y: 0.5 },
      { x: 0.5, y: 0.9 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.8 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.35, y: 0.5 },
    ];

    const mirrored = fitOutlineIntoRect(lopsided, RECT, { mirrorX: true });
    const plain = fitOutlineIntoRect(lopsided, RECT);

    expect(mirrored).toHaveLength(plain.length);
    // The interior notch at x=0.35 lands on the far side once mirrored.
    const mirroredXs = mirrored.map((point) => point.x).sort((a, b) => a - b);
    const plainXs = plain.map((point) => point.x).sort((a, b) => a - b);
    expect(mirroredXs).not.toEqual(plainXs);
  });

  it('returns nothing for a missing, short, or degenerate outline', () => {
    expect(fitOutlineIntoRect(null, RECT)).toEqual([]);
    expect(fitOutlineIntoRect(ellipse(4, 0.4, 0.4), RECT)).toEqual([]);
    // Every point identical → no bounding box to fit.
    expect(fitOutlineIntoRect(Array.from({ length: 12 }, () => ({ x: 0.5, y: 0.5 })), RECT))
      .toEqual([]);
    expect(fitOutlineIntoRect(ellipse(48, 0.4, 0.4), { x: 0, y: 0, width: 0, height: 0 }))
      .toEqual([]);
  });
});

describe('lerpOutline', () => {
  const from = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.1, 0.45), RECT));
  const to = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.45, 0.2), RECT));

  it('lands exactly on each endpoint', () => {
    expect(lerpOutline(from, to, 0)).toEqual(from);
    expect(lerpOutline(from, to, 1)).toEqual(to);
  });

  it('clamps outside 0..1 rather than overshooting the shape', () => {
    expect(lerpOutline(from, to, -3)).toEqual(from);
    expect(lerpOutline(from, to, 9)).toEqual(to);
  });

  it('moves every point monotonically toward its own target', () => {
    const half = lerpOutline(from, to, 0.5);

    expect(half).toHaveLength(from.length);
    half.forEach((point, index) => {
      expect(point.x).toBeCloseTo((from[index].x + to[index].x) / 2, 6);
      expect(point.y).toBeCloseTo((from[index].y + to[index].y) / 2, 6);
    });
  });

  it('interpolates through mismatched lengths instead of bailing out', () => {
    const short = from.slice(0, 12);

    const half = lerpOutline(short, to, 0.5);

    expect(half).toHaveLength(to.length);
    half.forEach((point) => {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    });
  });

  it('falls through to whichever side actually exists', () => {
    expect(lerpOutline([], to, 0.4)).toEqual(to);
    expect(lerpOutline(from, [], 0.4)).toEqual(from);
  });
});

describe('outlinePathD', () => {
  const points = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.4, 0.4), RECT));

  it('builds a closed smooth path through every sample', () => {
    const d = outlinePathD(points);

    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    // Cubic segments, not line segments — a 48-gon reads as faceted.
    expect(d).not.toContain(' L ');
    expect(d.match(/ C /g)).toHaveLength(points.length);
  });

  it('is deterministic, which is what makes the lock-on handoff seamless', () => {
    expect(outlinePathD(points)).toBe(outlinePathD(points));
  });

  it('draws nothing rather than something broken when there is no shape', () => {
    expect(outlinePathD([])).toBe('');
    expect(outlinePathD([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBe('');
  });
});

describe('morphPathD', () => {
  const from = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.1, 0.45), RECT));
  const to = resampleOutlineByAngle(projectOutlineOntoRect(ellipse(48, 0.45, 0.1), RECT));

  it('agrees with the endpoints and changes continuously between them', () => {
    expect(morphPathD(from, to, 0)).toBe(outlinePathD(from));
    expect(morphPathD(from, to, 1)).toBe(outlinePathD(to));

    const frames = [0, 0.25, 0.5, 0.75, 1].map((t) => morphPathD(from, to, t));
    expect(new Set(frames).size).toBe(frames.length);
  });
});

describe('buildMorphOutlines', () => {
  const person = ellipse(48, 0.12, 0.42);
  const species = ellipse(48, 0.44, 0.3);

  it('prepares both sides on the same bearings in the artwork rect', () => {
    const morph = buildMorphOutlines({
      personOutline: person,
      speciesOutline: species,
      artworkRect: RECT,
    });

    expect(morph.canMorph).toBe(true);
    expect(morph.from).toHaveLength(MORPH_POINT_COUNT);
    expect(morph.to).toHaveLength(MORPH_POINT_COUNT);
    expectSameBearings(morph.from, morph.to);
  });

  it('is a pure function of its inputs — the seamless handoff depends on it', () => {
    // FaceLockOn and RevealMorph call this separately with the same arguments
    // and must land on the same pixels, or the shape jumps between the phases.
    const first = buildMorphOutlines({
      personOutline: person,
      speciesOutline: species,
      artworkRect: RECT,
    });
    const second = buildMorphOutlines({
      personOutline: person,
      speciesOutline: species,
      artworkRect: { ...RECT },
    });

    expect(outlinePathD(first.from)).toBe(outlinePathD(second.from));
  });

  it('mirrors your outline by default, and can be told not to', () => {
    // Asymmetric about the VERTICAL axis specifically — an ellipse, or anything
    // built only from sin(nθ)/cos(2nθ) terms, is its own mirror image and would
    // prove nothing here.
    const lumpy = Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      const radius = 0.3 + 0.1 * Math.cos(angle) + 0.07 * Math.sin(2 * angle);
      return { x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
    });

    const byDefault = buildMorphOutlines({
      personOutline: lumpy,
      speciesOutline: species,
      artworkRect: RECT,
    });
    const asCaptured = buildMorphOutlines({
      personOutline: lumpy,
      speciesOutline: species,
      artworkRect: RECT,
      mirrorPerson: false,
    });
    const mirrored = buildMorphOutlines({
      personOutline: lumpy,
      speciesOutline: species,
      artworkRect: RECT,
      mirrorPerson: true,
    });

    // The DEFAULT is now as-captured. `SelfieImage` stopped flipping the photo,
    // and these two have to agree — mirroring the outline but not the picture
    // is what put your silhouette on the wrong side of your body.
    expect(outlinePathD(byDefault.from)).toBe(outlinePathD(asCaptured.from));
    // The flip is still reachable, and still actually does something.
    expect(outlinePathD(mirrored.from)).not.toBe(outlinePathD(asCaptured.from));
  });

  it('refuses to morph when either outline is missing', () => {
    expect(
      buildMorphOutlines({ personOutline: null, speciesOutline: species, artworkRect: RECT }),
    ).toEqual({ from: [], to: [], canMorph: false });
    expect(
      buildMorphOutlines({ personOutline: person, speciesOutline: null, artworkRect: RECT }),
    ).toEqual({ from: [], to: [], canMorph: false });
    expect(
      buildMorphOutlines({ personOutline: null, speciesOutline: null, artworkRect: RECT }),
    ).toEqual({ from: [], to: [], canMorph: false });
  });

  it('refuses to morph before the container has been measured', () => {
    const morph = buildMorphOutlines({
      personOutline: person,
      speciesOutline: species,
      artworkRect: { x: 0, y: 0, width: 0, height: 0 },
    });

    expect(morph.canMorph).toBe(false);
  });
});
